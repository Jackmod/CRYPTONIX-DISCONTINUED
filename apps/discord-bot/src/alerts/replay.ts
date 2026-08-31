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
    let posted = 0;
    try {
      for (;;) {
        const page = await this.options.listAlertsSince(this.cursor);
        if (page.length === 0) break;

        for (const alert of page) {
          // Explicitly does NOT advance the cursor: doing so per-alert leaves
          // it already equal to the page's highest id, so the progress check
          // below trips immediately and the walk stops after one page.
          if (await this.deliverOnce(alert, { advanceCursor: false })) posted++;
        }

        const highest = page.reduce((max, alert) => Math.max(max, alert.id), this.cursor);
        // No forward progress would spin forever; stop instead.
        if (highest <= this.cursor) break;
        this.cursor = highest;

        // A short page means the backlog is exhausted.
        if (page.length < this.options.pageSize) break;
      }
    } finally {
      this.catchingUp = false;
    }

    // Drain live alerts that arrived while the walk was running.
    const pending = this.queued;
    this.queued = [];
    for (const alert of pending) {
      if (await this.deliverOnce(alert)) posted++;
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
    if (this.deliveredIds.has(alert.id)) return false;

    await this.options.deliver(alert);

    // Only after a successful delivery: a throw should leave the alert
    // eligible for the next attempt rather than silently consumed.
    this.remember(alert.id);
    if (advanceCursor) this.cursor = Math.max(this.cursor, alert.id);
    return true;
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
