/**
 * Threshold tuning aid for the new-coin scanner.
 *
 * Samples the coins DexScreener is listing right now, prints their momentum
 * side by side, and reports how many would clear each gate set. Spec §12 says
 * the scanner "ships with a reasonable starting formula, not a promise of
 * optimality" and expects tuning against real traffic -- this is how to do
 * that with evidence instead of guesswork.
 *
 * Nothing is written and no alert is published; it only reads.
 *
 *   pnpm --filter @cryptonix/engine exec tsx scripts/threshold-sweep.ts
 *
 * Memecoin launches are bursty, so one run is a snapshot, not a verdict. Run
 * it a few times across different hours before moving a threshold. Reading
 * the output: if nothing passes any set, the market is quiet rather than the
 * gates being broken -- check the distribution above the counts to see which
 * gate is actually binding.
 */
import { DexScreenerClient } from '@cryptonix/engine';
import { scoreMomentum, DEFAULT_MOMENTUM_THRESHOLDS, type CoinSnapshot } from '@cryptonix/core';

const dex = new DexScreenerClient();
const mints = await dex.listRecentSolanaMints();

const snapshots: CoinSnapshot[] = [];
for (const mint of mints) {
  const s = await dex.getSnapshot(mint);
  if (s) snapshots.push(s);
}
console.log(`sampled ${snapshots.length} live coins\n`);

const young = snapshots.filter((s) => s.ageMinutes <= 60);
console.log(`under 60m old: ${young.length}`);
console.log('distribution of the young ones:');
for (const s of young.sort((a, b) => b.volume5m - a.volume5m)) {
  const ratio = s.buys5m + s.sells5m ? s.buys5m / (s.buys5m + s.sells5m) : 0;
  console.log(
    `  ${s.symbol.padEnd(12)} ${String(Math.round(s.ageMinutes)).padStart(3)}m  vol5m $${String(Math.round(s.volume5m)).padStart(7)}  chg ${s.priceChange5m.toFixed(1).padStart(7)}%  ${String(s.buys5m).padStart(3)}B/${String(s.sells5m).padStart(3)}S  ratio ${(ratio * 100).toFixed(0)}%`
  );
}

const sets = {
  'default (strict)': DEFAULT_MOMENTUM_THRESHOLDS,
  'moderate': { ...DEFAULT_MOMENTUM_THRESHOLDS, minVolume5m: 2000, minPriceChange5m: 10, minTrades5m: 20 },
  'loose': { ...DEFAULT_MOMENTUM_THRESHOLDS, minVolume5m: 500, minPriceChange5m: 5, minTrades5m: 10, minBuyRatio: 0.55 },
};

console.log('\npass counts by threshold set (of all sampled):');
for (const [name, t] of Object.entries(sets)) {
  const passing = snapshots.filter((s) => scoreMomentum(s, t).passes);
  console.log(`  ${name.padEnd(18)} ${passing.length}/${snapshots.length}  ${passing.map((p) => p.symbol).join(', ') || '-'}`);
}
