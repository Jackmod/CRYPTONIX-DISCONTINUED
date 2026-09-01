import { describe, it, expect } from 'vitest';
import {
  scoreMomentum,
  buyRatio,
  DEFAULT_MOMENTUM_THRESHOLDS,
  type CoinSnapshot,
} from './momentum';

/**
 * A coin that clears every gate comfortably. Modelled on a real pair seen while
 * investigating the data source: three minutes old, ~$25k of five-minute
 * volume, 288 buys to 157 sells, +80%.
 */
function strongCoin(overrides: Partial<CoinSnapshot> = {}): CoinSnapshot {
  return {
    mint: 'BnS61WuqU6LGvy8Pu6WXezuyQqvW2HcE2tnwRBr6pump',
    symbol: 'catcall',
    ageMinutes: 3,
    liquidityUsd: 40_000,
    volume5m: 24_983,
    volume1h: 24_983,
    priceChange5m: 79.97,
    buys5m: 288,
    sells5m: 157,
    fdvUsd: 500_000,
    imageUrl: 'https://cdn.dexscreener.com/cms/images/example',
    ...overrides,
  };
}

describe('buyRatio', () => {
  it('is the share of trades that were buys', () => {
    expect(buyRatio(3, 1)).toBe(0.75);
  });

  it('is zero when nothing traded, rather than NaN', () => {
    // 0/0 would poison every comparison downstream.
    expect(buyRatio(0, 0)).toBe(0);
  });
});

describe('scoreMomentum: gates', () => {
  it('passes a coin with real momentum', () => {
    const result = scoreMomentum(strongCoin());

    expect(result.passes).toBe(true);
    expect(result.rejections).toEqual([]);
    expect(result.score).toBeGreaterThan(0);
  });

  it('rejects a coin that is too old to be news', () => {
    const result = scoreMomentum(strongCoin({ ageMinutes: 240 }));

    expect(result.passes).toBe(false);
    expect(result.rejections.join(' ')).toContain('old');
  });

  it('rejects thin volume', () => {
    const result = scoreMomentum(strongCoin({ volume5m: 100 }));

    expect(result.passes).toBe(false);
    expect(result.rejections.join(' ')).toContain('volume');
  });

  it('rejects a sell-dominated tape even when volume is high', () => {
    const result = scoreMomentum(strongCoin({ buys5m: 100, sells5m: 400 }));

    expect(result.passes).toBe(false);
    expect(result.rejections.join(' ')).toContain('buy ratio');
  });

  it('rejects a flat price', () => {
    const result = scoreMomentum(strongCoin({ priceChange5m: 1 }));

    expect(result.passes).toBe(false);
    expect(result.rejections.join(' ')).toContain('change');
  });

  it('rejects a perfect buy ratio built from almost no trades', () => {
    // 2 buys and 0 sells is a 100% buy rate on nothing at all. Without the
    // trade-count gate this would look like the strongest possible signal.
    const result = scoreMomentum(strongCoin({ buys5m: 2, sells5m: 0 }));

    expect(result.passes).toBe(false);
    expect(result.rejections.join(' ')).toContain('trades');
  });

  it('explains every reason it rejected something, not just the first', () => {
    // These go straight into the log; one reason at a time makes tuning
    // thresholds a guessing game.
    const result = scoreMomentum(strongCoin({ ageMinutes: 999, volume5m: 1, buys5m: 1, sells5m: 9 }));

    expect(result.rejections.length).toBeGreaterThan(2);
  });
});

describe('scoreMomentum: missing liquidity', () => {
  it('does not reject a coin whose provider has not reported liquidity', () => {
    // The three-minute-old pair found while investigating the data source had
    // NO liquidity figure. Treating null as zero would silently reject exactly
    // the freshest coins the scanner exists to find.
    const result = scoreMomentum(strongCoin({ liquidityUsd: null }));

    expect(result.passes).toBe(true);
  });

  it('still rejects a coin whose reported liquidity is genuinely too thin', () => {
    const result = scoreMomentum(strongCoin({ liquidityUsd: 50 }));

    expect(result.passes).toBe(false);
    expect(result.rejections.join(' ')).toContain('liquidity');
  });
});

describe('scoreMomentum: ordering', () => {
  it('scores a stronger coin above a marginal one', () => {
    const marginal = scoreMomentum(
      strongCoin({ volume5m: 5_100, priceChange5m: 21, buys5m: 20, sells5m: 12 })
    );
    const strong = scoreMomentum(strongCoin({ volume5m: 200_000, priceChange5m: 300, buys5m: 900, sells5m: 100 }));

    expect(marginal.passes).toBe(true);
    expect(strong.passes).toBe(true);
    expect(strong.score).toBeGreaterThan(marginal.score);
  });

  it('keeps the score inside 0-100 however extreme the inputs', () => {
    const absurd = scoreMomentum(
      strongCoin({ volume5m: 1e12, priceChange5m: 1e9, buys5m: 1e6, sells5m: 0 })
    );

    expect(absurd.score).toBeLessThanOrEqual(100);
    expect(absurd.score).toBeGreaterThanOrEqual(0);
  });

  it('never claims a passing score for something it rejected', () => {
    // `passes` is the gate; the score only orders what survives it.
    const rejected = scoreMomentum(strongCoin({ volume5m: 1 }));

    expect(rejected.passes).toBe(false);
  });
});

describe('scoreMomentum: thresholds are tunable', () => {
  it('honours a caller-supplied threshold set', () => {
    // Spec §12 expects these to be tuned live, so they must not be baked in.
    const coin = strongCoin({ volume5m: 200 });

    expect(scoreMomentum(coin).passes).toBe(false);
    expect(scoreMomentum(coin, { ...DEFAULT_MOMENTUM_THRESHOLDS, minVolume5m: 100 }).passes).toBe(true);
  });
});
