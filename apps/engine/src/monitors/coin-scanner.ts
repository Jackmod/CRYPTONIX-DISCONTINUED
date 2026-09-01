import { eq, sql } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { scannedCoins, alerts } from '@cryptonix/db';
import {
  buildAxiomLink,
  scoreMomentum,
  DEFAULT_MOMENTUM_THRESHOLDS,
  type CoinSnapshot,
  type MomentumThresholds,
} from '@cryptonix/core';
import type { DexScreenerClient } from '../coins/dexscreener.js';
import type { AlertBus } from '../api/alert-bus.js';

/** Exactly what a new_coin alert carries; the bot's embed reads these fields. */
export interface NewCoinAlertPayload {
  mint: string;
  symbol: string;
  momentumScore: number;
  ageMinutes: number;
  volume5m: number;
  priceChange5m: number;
  buys5m: number;
  sells5m: number;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  /** The token's real logo (spec §5.3), or null when there is none. */
  imageUrl: string | null;
  axiomLink: string;
}

export interface CoinScannerOptions {
  thresholds?: MomentumThresholds;
  /** Most mints to score per poll, so one sweep cannot exhaust the rate limit. */
  maxPerPoll?: number;
}

/**
 * Finds newly launched Solana coins with real short-term momentum and
 * publishes them onto the same alert bus wallet trades use.
 *
 * Isolated from the wallet path on purpose (spec §9): it shares only the bus,
 * so a failure here cannot stop trades being recorded, and the bot already
 * ignores alert types it does not recognise.
 */
export class CoinScanner {
  private readonly thresholds: MomentumThresholds;
  private readonly maxPerPoll: number;

  constructor(
    private db: Db,
    private dex: Pick<DexScreenerClient, 'listRecentSolanaMints' | 'getSnapshot'>,
    private alertBus: AlertBus,
    options: CoinScannerOptions = {}
  ) {
    this.thresholds = options.thresholds ?? DEFAULT_MOMENTUM_THRESHOLDS;
    this.maxPerPoll = options.maxPerPoll ?? 20;
  }

  /**
   * One pass: discover recent mints, score the ones not yet alerted, and
   * publish those that clear every gate.
   *
   * Returns how many alerts it published, for logging.
   */
  async poll(): Promise<number> {
    const mints = await this.dex.listRecentSolanaMints();
    let published = 0;

    for (const mint of mints.slice(0, this.maxPerPoll)) {
      try {
        if (await this.scanMint(mint)) published++;
      } catch (err) {
        // Per-coin isolation, the same rule the wallet monitor follows: one
        // coin's failure must not abandon the rest of the sweep.
        console.error(`coin scanner: failed scoring ${mint}`, err);
      }
    }

    return published;
  }

  /** Returns true if this mint produced an alert. */
  private async scanMint(mint: string): Promise<boolean> {
    const [seen] = await this.db.select().from(scannedCoins).where(eq(scannedCoins.mint, mint));
    // Already alerted: never alert the same coin twice, however it looks now.
    if (seen?.alerted) return false;

    const snapshot = await this.dex.getSnapshot(mint);
    if (!snapshot) return false;

    const result = scoreMomentum(snapshot, this.thresholds);

    if (!result.passes) {
      // Recorded even though it failed, so the next poll knows it has been
      // considered — and so a coin that later crosses the threshold is still
      // eligible, because `alerted` stays false.
      await this.remember(snapshot, { alerted: false, score: result.score });
      return false;
    }

    // Recorded BEFORE the alert goes out: publishing first meant a failed
    // upsert, or a restart in between, left an alert delivered with no dedupe
    // row, and the next poll alerted the same coin again.
    await this.remember(snapshot, { alerted: true, score: result.score });
    await this.publish(snapshot, result.score);
    return true;
  }

  private async remember(snapshot: CoinSnapshot, { alerted, score }: { alerted: boolean; score: number }) {
    await this.db
      .insert(scannedCoins)
      .values({
        mint: snapshot.mint,
        symbol: snapshot.symbol,
        alerted,
        momentumScore: score,
        imageUrl: snapshot.imageUrl,
        stats: snapshot,
      })
      .onConflictDoUpdate({
        target: scannedCoins.mint,
        set: {
          // Sticky: `alerted` only ever moves false -> true. Writing this
          // pass's value could flip an already-alerted coin back to false --
          // and then re-alert it -- which is exactly the noise this table
          // exists to prevent.
          alerted: sql`${scannedCoins.alerted} OR excluded.alerted`,
          momentumScore: score,
          lastCheckedAt: new Date(),
          symbol: snapshot.symbol,
          imageUrl: snapshot.imageUrl,
          stats: snapshot,
        },
      });
  }

  private async publish(snapshot: CoinSnapshot, momentumScore: number) {
    const payload: NewCoinAlertPayload = {
      mint: snapshot.mint,
      symbol: snapshot.symbol,
      momentumScore,
      ageMinutes: Math.round(snapshot.ageMinutes),
      volume5m: snapshot.volume5m,
      priceChange5m: snapshot.priceChange5m,
      buys5m: snapshot.buys5m,
      sells5m: snapshot.sells5m,
      liquidityUsd: snapshot.liquidityUsd,
      fdvUsd: snapshot.fdvUsd,
      imageUrl: snapshot.imageUrl,
      axiomLink: buildAxiomLink(snapshot.mint),
    };

    // Written before publishing, so the alert has a durable id and the bot's
    // replay can recover it if nothing is listening right now.
    const [alert] = await this.db
      .insert(alerts)
      .values({ type: 'new_coin', refId: 0, payload })
      .returning();

    this.alertBus.publish({ id: alert.id, type: alert.type, refId: alert.refId, payload: alert.payload });
  }
}
