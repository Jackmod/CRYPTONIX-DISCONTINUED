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
  /** Delivery attempts before an alert is given up on. Defaults to 3. */
  maxAttempts?: number;
  /**
   * Reads the cursor persisted by a previous run, or null on a first run.
   *
   * Without this the cursor was in-memory only and `start` reset it to the
   * engine head, so alerts published while the bot process was DOWN were
   * never replayed — the case the replay mechanism most obviously exists for.
   * Only within-process reconnects were actually covered.
   */
  loadCursor?(): Promise<number | null>;
  /** Persists the cursor. Failures are logged, never fatal. */
  saveCursor?(cursor: number): Promise<void>;
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
 *   drained afterwards. That keeps the cursor contiguous. Ordering across a
 *   reconnect boundary is best-effort: a queued live alert can land ahead of
 *   an older backlog fetched by a re-run. Delivering each alert exactly once
 *   and never stepping the cursor over one both still hold, and those are the
 *   properties worth machinery.
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
  /**
   * Ids whose delivery failed, with how many times.
   *
   * Retries are bounded on purpose. Holding the cursor below a permanently
   * undeliverable alert forever meant every reconnect re-walked the backlog
   * from that point, and ids already evicted from the bounded de-duplication
   * set were posted again — duplicates in Discord, growing with history. After
   * `maxAttempts` the alert is given up on, loudly, and the cursor moves on.
   */
  private failureCounts = new Map<number, number>();
  private rerunRequested = false;
  private queued: AlertEvent[] = [];
  private deliveredIds = new Set<number>();
  private readonly maxRememberedIds: number;

  private readonly maxAttempts: number;

  constructor(private options: AlertReplayOptions) {
    this.maxRememberedIds = options.maxRememberedIds ?? 1_000;
    this.maxAttempts = options.maxAttempts ?? 3;
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
        // A persisted cursor wins: it is where the previous run left off, and
        // everything after it is genuinely undelivered. Only a first run —
        // nothing persisted — starts at the head, so it does not replay the
        // whole history into channels that may have changed since.
        const persisted = (await this.options.loadCursor?.()) ?? null;
        this.cursor = persisted ?? (await this.options.getAlertHead());
        this.started = true;
        // The head IS the frontier, so by definition nothing is behind it. A
        // resumed cursor is not: there is a backlog to walk first.
        this.backlogClear = persisted === null;
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
    if (!this.started) return 0;
    if (this.catchingUp) {
      // A reconnect landing mid-walk used to be dropped outright: it returned
      // 0 and nothing re-ran, so alerts published during that disconnect were
      // never fetched, and a later live alert moved the cursor past them.
      this.rerunRequested = true;
      return 0;
    }

    this.catchingUp = true;
    this.backlogClear = false;
    let posted = 0;
    try {
      // Walk AND drain both sit inside the re-run loop.
      //
      // The walk goes first because a reconnect's backlog is older than
      // anything queued live, and draining first put alerts into Discord out
      // of order. The drain is inside the loop because a reconnect landing
      // during the drain would otherwise set the flag after the loop had
      // already exited, and that reconnect's backlog would then wait for some
      // later one - `stream.onOpen` is the only caller.
      do {
        this.rerunRequested = false;
        try {
          posted += await this.walkBacklog();
        } finally {
          // Even when the walk throws: leaving the queue undrained strands
          // every live alert behind a transient engine failure.
          posted += await this.drainQueue();
        }
      } while (this.rerunRequested);

      this.backlogClear = true;
    } finally {
      // Held across walk and drain alike. Releasing it earlier let a reconnect
      // start a second walk sharing the cursor, re-posting ids already evicted
      // from the de-duplication set.
      this.catchingUp = false;
    }

    return posted;
  }

  /**
   * Posts everything queued while a walk was running. Never throws: a single
   * bad alert must not abort the rest of the queue.
   */
  private async drainQueue(): Promise<number> {
    let posted = 0;
    // A `while`, not one pass over a snapshot: an alert arriving DURING the
    // drain lands in the queue too and must go out in this pass.
    while (this.queued.length > 0) {
      const alert = this.queued.shift()!;
      try {
        if (await this.deliverOnce(alert)) posted++;
      } catch (err) {
        console.error(`could not deliver queued alert ${alert.id}; will retry on the next walk`, err);
      }
    }
    return posted;
  }

  /**
   * One pass over everything after the cursor. Returns how many it posted.
   *
   * The walk position and the durable cursor are deliberately separate.
   * Walking straight off the cursor meant one deterministically-failing alert
   * pinned it, the progress check tripped, and the walk stopped — so
   * everything after that alert was never fetched at all. The walk keeps
   * moving; the cursor is what stays behind so failures can be fetched again.
   */
  private async walkBacklog(): Promise<number> {
    let posted = 0;
    let fetchFrom = this.cursor;

    for (;;) {
      const page = await this.options.listAlertsSince(fetchFrom);
      if (page.length === 0) break;

      for (const alert of page) {
        // Per-alert boundary. One undeliverable alert must not abort the walk,
        // or everything behind it would stay undelivered.
        try {
          // Explicitly does NOT advance the cursor: doing so per-alert leaves
          // it already equal to the page's highest id, so the progress check
          // below trips immediately and the walk stops after one page.
          if (await this.deliverOnce(alert, { advanceCursor: false })) posted++;
        } catch (err) {
          console.error(`could not deliver alert ${alert.id}; skipping it`, err);
        }
      }

      const highest = page.reduce((max, alert) => Math.max(max, alert.id), fetchFrom);
      // No forward progress would spin forever; stop instead.
      if (highest <= fetchFrom) break;
      fetchFrom = highest;

      this.advanceCursorTo(highest);

      // A short page means the backlog is exhausted.
      if (page.length < this.options.pageSize) break;
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
      this.failureCounts.delete(alert.id);
    } catch (err) {
      const attempts = (this.failureCounts.get(alert.id) ?? 0) + 1;
      if (attempts >= this.maxAttempts) {
        // Give up: keep it claimed so the cursor can move past it. Retrying
        // forever pins the cursor and re-posts everything after it on every
        // reconnect once the de-duplication set has rolled over.
        this.failureCounts.delete(alert.id);
        console.error(`alert ${alert.id} failed ${attempts} times; giving up on it`);
      } else {
        // Eligible again on the next walk. Safe because the cursor is held
        // below this id while it is still being retried.
        this.deliveredIds.delete(alert.id);
        this.failureCounts.set(alert.id, attempts);
      }
      throw err;
    } finally {
      this.inFlightIds.delete(alert.id);
    }
    // Only when nothing may still lie behind the cursor. After an aborted
    // walk there are unfetched ids below this one, and moving past them would
    // lose them.
    if (advanceCursor && this.backlogClear) this.advanceCursorTo(alert.id);
    return true;
  }

  /**
   * Moves the cursor toward `target`, never past anything unresolved.
   *
   * Both the walk and the live path go through here. The live path used to
   * assign the cursor directly, which stepped straight over an alert whose
   * delivery had failed — and only ids ABOVE the cursor are ever returned, so
   * that alert could never be fetched again.
   */
  private advanceCursorTo(target: number) {
    const blocked = this.lowestUnresolvedId();
    const bound = blocked === null ? target : Math.min(target, blocked - 1);
    if (bound <= this.cursor) return;

    this.cursor = bound;
    // Persisting is best-effort: losing it costs a replay after a restart,
    // which is recoverable, whereas throwing here would abort a walk that has
    // already delivered its alerts.
    void this.options.saveCursor?.(bound).catch((err) => {
      console.error(`could not persist alert cursor ${bound}`, err);
    });
  }

  /** Lowest id that must stay fetchable, or null when there is none. */
  private lowestUnresolvedId(): number | null {
    let lowest: number | null = null;
    for (const id of [...this.inFlightIds, ...this.failureCounts.keys()]) {
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
