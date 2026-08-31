import type { AlertEvent } from '../engine/alert-stream.js';

export interface AlertReplayOptions {
  /** Alerts with an id greater than `since`, ascending, capped at `pageSize`. */
  listAlertsSince(since: number): Promise<AlertEvent[]>;
  /** The engine's newest alert id, or 0 when there are none. */
  getAlertHead(): Promise<number>;
  /** Posts one alert. Throwing is fine; the id is not marked delivered. */
  deliver(alert: AlertEvent): Promise<void>;
  /** Must match the engine's page cap. */
  pageSize: number;
  /** Ids remembered for de-duplication. */
  maxRememberedIds?: number;
}

/**
 * Decides which alerts to post and where to resume from.
 *
 * The engine's WebSocket only reaches clients connected at the moment an alert
 * is published, so a trade landing during a restart or inside the reconnect
 * backoff is recorded and never delivered. This walks the gap on every
 * connection.
 *
 * The ordering rules here are the whole point, and each one exists because
 * getting it wrong loses or duplicates alerts:
 *
 * - The cursor advances ONLY in `catchUp`, one page at a time, and only over
 *   ids actually fetched. Letting the live socket move it lets a live alert
 *   jump the cursor past ids the walk has not reached, and those are then
 *   unreachable forever.
 * - Live alerts arriving during a catch-up are queued, not posted, then
 *   drained afterwards. That keeps the cursor contiguous and the order sane.
 * - `start` must be called with a real head before anything is delivered.
 *   Beginning at 0 replays the entire alert history into live channels.
 */
export class AlertReplay {
  private cursor = 0;
  private started = false;
  private catchingUp = false;
  /**
   * False while a backlog may still lie behind the cursor.
   *
   * Live deliveries may only move the cursor when this is true. After a walk
   * aborts mid-page, ids between the cursor and the failure point have not
   * been fetched; letting a live alert jump the cursor past them would make
   * them unreachable, which is the same class of bug the queue prevents while
   * a walk is running.
   */
  private backlogClear = false;
  /**
   * Ids claimed but not yet resolved, and ids whose delivery failed.
   *
   * The cursor may never advance past either. Claiming an id before awaiting
   * stops a concurrent walk double-posting it, but on its own it turned that
   * double-post into permanent loss: the walk skipped the claimed id, moved
   * the cursor beyond it, and the delivery then failed — and
   * `listAlertsSince` only ever returns ids ABOVE the cursor, so nothing
   * could fetch it again. Holding the cursor below the lowest unresolved or
   * failed id keeps it reachable on the next walk.
   */
  private inFlightIds = new Set<number>();
  private failedIds = new Set<number>();
  private queued: AlertEvent[] = [];
  private deliveredIds = new Set<number>();
  private readonly maxRememberedIds: number;

  constructor(private options: AlertReplayOptions) {
    this.maxRememberedIds = options.maxRememberedIds ?? 1_000;
  }

  /** Where the next catch-up resumes from. */
  get resumeFrom(): number {
    return this.cursor;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Reads the engine's head and arms delivery, retrying until it succeeds.
   *
   * Arming with a fallback of 0 after a failure would defeat the guard it
   * exists to provide: the first catch-up would replay the oldest page into
   * every configured channel.
   */
  async start(retryDelayMs = 5_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
    for (;;) {
      try {
        this.cursor = await this.options.getAlertHead();
        this.started = true;
        // The head IS the frontier, so by definition nothing is behind it.
        this.backlogClear = true;
        return this.cursor;
      } catch (err) {
        console.error(`could not read the alert head; retrying in ${retryDelayMs}ms`, err);
        await sleep(retryDelayMs);
      }
    }
  }

  /** Posts a live alert, or queues it if a catch-up is walking the backlog. */
  async handleLive(alert: AlertEvent): Promise<void> {
    if (!this.started) {
      // Not armed yet: queue rather than drop. The catch-up that follows
      // start() would find it anyway, but queueing keeps ordering predictable.
      this.queued.push(alert);
      return;
    }
    if (this.catchingUp) {
      this.queued.push(alert);
      return;
    }
    await this.deliverOnce(alert);
  }

  /**
   * Posts everything published since the cursor, then drains anything that
   * arrived live while it was working.
   *
   * Returns how many alerts were posted.
   */
  async catchUp(): Promise<number> {
    if (!this.started || this.catchingUp) return 0;

    this.catchingUp = true;
    this.backlogClear = false;
    let posted = 0;
    try {
      for (;;) {
        const page = await this.options.listAlertsSince(this.cursor);
        if (page.length === 0) break;

        for (const alert of page) {
          // Per-alert boundary. One undeliverable alert must not abort the
          // walk: the cursor would never pass it, so every later reconnect
          // would refetch the same page and die on the same alert, and
          // everything behind it would stay undelivered forever.
          try {
            // Explicitly does NOT advance the cursor: doing so per-alert leaves
            // it already equal to the page's highest id, so the progress check
            // below trips immediately and the walk stops after one page.
            if (await this.deliverOnce(alert, { advanceCursor: false })) posted++;
          } catch (err) {
            console.error(`could not deliver alert ${alert.id}; skipping it`, err);
          }
        }

        const highest = page.reduce((max, alert) => Math.max(max, alert.id), this.cursor);
        // Never step over an id that is still in flight or that failed: those
        // have to remain fetchable, and only ids above the cursor ever are.
        const blocked = this.lowestUnresolvedId();
        const next = blocked === null ? highest : Math.min(highest, blocked - 1);

        // No forward progress would spin forever; stop instead.
        if (next <= this.cursor) break;
        this.cursor = next;

        // A short page means the backlog is exhausted.
        if (page.length < this.options.pageSize) break;
      }
      this.backlogClear = true;
    } finally {
      // In `finally`: a throw from the walk (a failing listAlertsSince, say)
      // must not strand the live alerts queued behind it, which would
      // otherwise wait for some future clean catch-up and pile up meanwhile.
      //
      // `catchingUp` stays true across the drain and is cleared only after it.
      // Releasing it first let a reconnect start a second walk that shared the
      // cursor and re-posted ids already evicted from the de-duplication set.
      try {
        // A `while`, not one pass over a snapshot: an alert arriving DURING the
        // drain lands in the new queue, and with a single pass it sat there
        // until the next reconnect — the only thing that calls catchUp.
        while (this.queued.length > 0) {
          const alert = this.queued.shift()!;
          try {
            if (await this.deliverOnce(alert)) posted++;
          } catch (err) {
            console.error(`could not deliver queued alert ${alert.id}; will retry on the next walk`, err);
          }
        }
      } finally {
        this.catchingUp = false;
      }
    }

    return posted;
  }

  /**
   * Delivers unless already seen. Returns whether it posted.
   *
   * `advanceCursor` is false while walking a backlog page: the cursor moves at
   * page boundaries there, so that the loop can tell whether a page made
   * progress. It is true on the live path, where the id IS the frontier.
   */
  private async deliverOnce(alert: AlertEvent, { advanceCursor = true } = {}): Promise<boolean> {
    if (this.deliveredIds.has(alert.id) || this.inFlightIds.has(alert.id)) return false;

    // Claimed BEFORE awaiting, so a concurrent walk cannot post it a second
    // time — and recorded as in-flight, so that walk also cannot move the
    // cursor past it while the outcome is unknown.
    this.remember(alert.id);
    this.inFlightIds.add(alert.id);
    try {
      await this.options.deliver(alert);
      this.failedIds.delete(alert.id);
    } catch (err) {
      // Eligible again on the next walk. Safe because the cursor is held
      // below this id for as long as it is in `failedIds`.
      this.deliveredIds.delete(alert.id);
      this.failedIds.add(alert.id);
      throw err;
    } finally {
      this.inFlightIds.delete(alert.id);
    }
    // Only when nothing may still lie behind the cursor. After an aborted
    // walk there are unfetched ids below this one, and moving past them would
    // lose them.
    if (advanceCursor && this.backlogClear) this.cursor = Math.max(this.cursor, alert.id);
    return true;
  }

  /** Lowest id that must stay fetchable, or null when there is none. */
  private lowestUnresolvedId(): number | null {
    let lowest: number | null = null;
    for (const id of [...this.inFlightIds, ...this.failedIds]) {
      if (lowest === null || id < lowest) lowest = id;
    }
    return lowest;
  }

  private remember(id: number) {
    this.deliveredIds.add(id);
    if (this.deliveredIds.size <= this.maxRememberedIds) return;
    // Sets iterate in insertion order, so this evicts the oldest ids first.
    const excess = this.deliveredIds.size - this.maxRememberedIds;
    let dropped = 0;
    for (const seen of this.deliveredIds) {
      if (dropped++ >= excess) break;
      this.deliveredIds.delete(seen);
    }
  }
}
