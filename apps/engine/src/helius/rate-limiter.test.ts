import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter';

/**
 * Frozen fake clock: `sleep` records the requested delay but does NOT advance
 * `now`. That is deliberate — real concurrent sleeps overlap in wall-clock
 * time, so a clock that advanced on every sleep would model callers as
 * strictly sequential and hide whether the limiter reserves slots correctly
 * under concurrency. Time only moves when a test says so, via `advance`.
 */
function build(minIntervalMs: number) {
  let clock = 1_000;
  const slept: number[] = [];
  const limiter = new RateLimiter(minIntervalMs, {
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  });
  return { limiter, slept, advance: (ms: number) => (clock += ms) };
}

describe('RateLimiter', () => {
  it('does not delay the first request', async () => {
    const { limiter, slept } = build(125);

    await limiter.acquire();

    expect(slept).toEqual([]);
  });

  it('gives each queued caller its own slot rather than the same one', async () => {
    // Each acquire reserves the next slot synchronously, so the second caller
    // waits one interval and the third waits two. If the reservation happened
    // after the await instead, all three would compute the same wait and fire
    // together — precisely the burst this class exists to prevent.
    const { limiter, slept } = build(125);

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(slept).toEqual([125, 250]);
  });

  it('staggers concurrent callers instead of letting them burst', async () => {
    // The real failure mode: POST /wallets kicks off a backfill without
    // awaiting it, so tracking several wallets at once fires many Helius
    // calls simultaneously and trips the free tier's 10 req/s cap.
    const { limiter, slept } = build(125);

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    expect(slept).toEqual([125, 250, 375]);
  });

  it('does not delay a request made after a long idle period', async () => {
    const { limiter, slept, advance } = build(125);

    await limiter.acquire();
    advance(10_000);
    await limiter.acquire();

    expect(slept).toEqual([]);
  });

  it('derives the interval from a requests-per-second budget', async () => {
    // 8 req/s -> 125ms apart, which is what HeliusClient configures.
    const { limiter, slept } = build(Math.ceil(1000 / 8));

    await limiter.acquire();
    await limiter.acquire();

    expect(slept).toEqual([125]);
  });
});
