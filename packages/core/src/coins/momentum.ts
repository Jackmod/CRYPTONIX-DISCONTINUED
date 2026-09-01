/**
 * A coin's market state at one moment, normalised away from any one provider.
 *
 * Deliberately provider-agnostic: DexScreener supplies these today (see
 * docs/superpowers/specs/2026-09-01-phase-3-data-sources-spike.md), but the
 * scoring must not care where they came from.
 */
export interface CoinSnapshot {
  mint: string;
  symbol: string;
  /** Minutes since the pair was created. */
  ageMinutes: number;
  /**
   * Pool liquidity in USD, or null when the provider has not computed it yet.
   *
   * Null is common on the newest pairs — exactly the ones a scanner cares
   * about — so it is optional by design. A threshold that treated null as zero
   * would silently reject the freshest coins.
   */
  liquidityUsd: number | null;
  volume5m: number;
  volume1h: number;
  /** Percent change over five minutes, e.g. 79.97 for +79.97%. */
  priceChange5m: number;
  buys5m: number;
  sells5m: number;
  fdvUsd: number | null;
  /**
   * The token's real logo, when the provider has one.
   *
   * Spec §5.3 requires every surface to show the actual image for what it is
   * showing rather than a placeholder, so this is carried end to end: provider
   * -> alert payload -> Discord embed and desktop UI.
   */
  imageUrl: string | null;
}

export interface MomentumThresholds {
  /** Older pairs are not "new coins" any more. */
  maxAgeMinutes: number;
  minVolume5m: number;
  /** Share of 5-minute trades that were buys, 0-1. */
  minBuyRatio: number;
  minPriceChange5m: number;
  /** Total 5-minute trades, so a single trade cannot look like a 100% buy rate. */
  minTrades5m: number;
  /** Skipped entirely when liquidity is null. */
  minLiquidityUsd: number;
}

/**
 * Starting values, not claimed to be optimal.
 *
 * Spec §12 says the coin scanner "ships with a reasonable starting formula,
 * not a promise of optimality" and expects real-world tuning after launch,
 * which is why every one of these is overridable from the environment rather
 * than baked in. They aim at the shape of signal seen while investigating the
 * data source: a pair minutes old, five-figure five-minute volume, and buys
 * clearly outnumbering sells.
 */
export const DEFAULT_MOMENTUM_THRESHOLDS: MomentumThresholds = {
  maxAgeMinutes: 60,
  minVolume5m: 5_000,
  minBuyRatio: 0.6,
  minPriceChange5m: 20,
  minTrades5m: 30,
  minLiquidityUsd: 5_000,
};

export interface MomentumResult {
  /** 0-100. Only meaningful when `passes` is true. */
  score: number;
  passes: boolean;
  /** Why it failed, in plain words — this is what gets logged. */
  rejections: string[];
  buyRatio: number;
}

/** Share of trades that were buys; 0 when nothing traded. */
export function buyRatio(buys: number, sells: number): number {
  const total = buys + sells;
  return total === 0 ? 0 : buys / total;
}

/** Maps `value` onto 0-1 across [floor, ceiling], flat outside it. */
function ramp(value: number, floor: number, ceiling: number): number {
  if (ceiling <= floor) return value >= ceiling ? 1 : 0;
  return Math.max(0, Math.min(1, (value - floor) / (ceiling - floor)));
}

/**
 * Scores a coin's short-term momentum and decides whether it is worth an alert.
 *
 * Gates first, then scores. The gates are what stop the channel filling with
 * noise; the score only orders what survives them, so a coin that fails any
 * gate is never alerted no matter how strong the rest looks.
 */
export function scoreMomentum(
  snapshot: CoinSnapshot,
  thresholds: MomentumThresholds = DEFAULT_MOMENTUM_THRESHOLDS
): MomentumResult {
  const trades = snapshot.buys5m + snapshot.sells5m;
  const ratio = buyRatio(snapshot.buys5m, snapshot.sells5m);
  const rejections: string[] = [];

  if (snapshot.ageMinutes > thresholds.maxAgeMinutes) {
    rejections.push(`${Math.round(snapshot.ageMinutes)}m old, over the ${thresholds.maxAgeMinutes}m window`);
  }
  if (snapshot.volume5m < thresholds.minVolume5m) {
    rejections.push(`5m volume $${Math.round(snapshot.volume5m)} under $${thresholds.minVolume5m}`);
  }
  if (trades < thresholds.minTrades5m) {
    // Guards the ratio below: 1 buy and 0 sells is a 100% buy rate on nothing.
    rejections.push(`${trades} trades in 5m, under ${thresholds.minTrades5m}`);
  }
  if (ratio < thresholds.minBuyRatio) {
    rejections.push(`buy ratio ${(ratio * 100).toFixed(0)}% under ${(thresholds.minBuyRatio * 100).toFixed(0)}%`);
  }
  if (snapshot.priceChange5m < thresholds.minPriceChange5m) {
    rejections.push(`5m change ${snapshot.priceChange5m.toFixed(1)}% under ${thresholds.minPriceChange5m}%`);
  }
  // Only when the provider actually reported it; see CoinSnapshot.liquidityUsd.
  if (snapshot.liquidityUsd !== null && snapshot.liquidityUsd < thresholds.minLiquidityUsd) {
    rejections.push(`liquidity $${Math.round(snapshot.liquidityUsd)} under $${thresholds.minLiquidityUsd}`);
  }

  // Four signals, weighted by how much each one tends to mean on its own.
  // Volume carries the most because it is the hardest to fake cheaply.
  const score =
    100 *
    (0.35 * ramp(snapshot.volume5m, thresholds.minVolume5m, thresholds.minVolume5m * 20) +
      0.25 * ramp(snapshot.priceChange5m, thresholds.minPriceChange5m, thresholds.minPriceChange5m * 5) +
      0.25 * ramp(ratio, thresholds.minBuyRatio, 0.9) +
      0.15 * ramp(trades, thresholds.minTrades5m, thresholds.minTrades5m * 10));

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    passes: rejections.length === 0,
    rejections,
    buyRatio: ratio,
  };
}
