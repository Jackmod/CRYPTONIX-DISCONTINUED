export interface RateLimiterClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Spaces outbound requests by a minimum interval.
 *
 * The Helius free tier allows 10 requests/second. `POST /wallets` starts a
 * backfill without awaiting it, so tracking several wallets in quick
 * succession fires many paginated history calls at once — the exact shape that
 * trips the cap. Reserving the slot synchronously (before any await) is what
 * makes concurrent callers queue behind each other rather than all seeing the
 * same "next available" time and bursting together.
 */
export class RateLimiter {
  private nextAvailable = 0;

  constructor(private minIntervalMs: number, private clock: RateLimiterClock = realClock) {}

  async acquire(): Promise<void> {
    const now = this.clock.now();
    const waitMs = Math.max(0, this.nextAvailable - now);
    // Claim the slot before awaiting, so a concurrent caller sees it taken.
    this.nextAvailable = Math.max(now, this.nextAvailable) + this.minIntervalMs;
    if (waitMs > 0) await this.clock.sleep(waitMs);
  }
}
