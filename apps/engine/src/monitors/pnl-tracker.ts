import { eq } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { walletTrades, pnlDaily } from '@cryptonix/db';
import { parseSwap, applyFifo, type Lot, type HeliusEnhancedTransaction } from '@cryptonix/core';
import type { HeliusClient } from '../helius/client.js';

const MAX_BACKFILL_PAGES = 20;

export class PnlTracker {
  constructor(private db: Db, private helius: Pick<HeliusClient, 'getTransactionHistory'>) {}

  async backfillWallet(walletId: number, address: string) {
    const collected: HeliusEnhancedTransaction[] = [];
    let before: string | undefined;

    for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
      const batch = await this.helius.getTransactionHistory(address, before);
      if (batch.length === 0) break;
      collected.push(...batch);
      before = batch[batch.length - 1].signature;
      if (batch.length < 100) break;
    }

    collected.reverse(); // oldest first, so FIFO lots build up chronologically

    for (const tx of collected) {
      const parsed = parseSwap(tx, address);
      if (!parsed) continue;
      await this.db
        .insert(walletTrades)
        .values({
          walletId,
          signature: parsed.signature,
          mint: parsed.mint,
          side: parsed.side,
          solAmount: parsed.solAmount,
          tokenAmount: parsed.tokenAmount,
          ts: parsed.ts,
        })
        .onConflictDoNothing();
    }

    await this.recomputePnl(walletId);
  }

  async recomputePnl(walletId: number) {
    // Helius timestamps are unix SECONDS, so same-second buy/sell pairs are
    // common, and ordering by ts alone gives Postgres no stable tie-break —
    // a sell could sort before its own buy, producing spurious
    // unmatchedTokenAmount and understating PnL non-reproducibly between
    // runs. `id` is insertion order, which for our own inserts (backfill
    // page-by-page, then live trades as they arrive) matches chronological
    // order even within the same second.
    const trades = await this.db
      .select()
      .from(walletTrades)
      .where(eq(walletTrades.walletId, walletId))
      .orderBy(walletTrades.ts, walletTrades.id);

    const lotsByMint = new Map<string, Lot[]>();
    const dailyPnl = new Map<string, { realizedPnlSol: number; tradeCount: number }>();

    for (const trade of trades) {
      const day = trade.ts.toISOString().slice(0, 10);
      const dayEntry = dailyPnl.get(day) ?? { realizedPnlSol: 0, tradeCount: 0 };
      dayEntry.tradeCount += 1;

      const lots = lotsByMint.get(trade.mint) ?? [];
      if (trade.side === 'buy') {
        lots.push({ solCost: trade.solAmount, tokenAmount: trade.tokenAmount });
        lotsByMint.set(trade.mint, lots);
      } else {
        const { remainingLots, realizedPnlSol, unmatchedTokenAmount } = applyFifo(
          lots,
          trade.tokenAmount,
          trade.solAmount
        );
        lotsByMint.set(trade.mint, remainingLots);
        dayEntry.realizedPnlSol += realizedPnlSol;
        if (unmatchedTokenAmount > 0) {
          // Expected on a first backfill: the wallet already held this token
          // before our history window. Those proceeds are excluded from PnL
          // rather than counted as pure profit.
          console.warn(
            `pnl: wallet ${walletId} sold ${unmatchedTokenAmount} ${trade.mint} with no tracked cost basis (tx ${trade.signature})`
          );
        }
      }

      dailyPnl.set(day, dayEntry);
    }

    for (const [date, { realizedPnlSol, tradeCount }] of dailyPnl) {
      await this.db
        .insert(pnlDaily)
        .values({ walletId, date, realizedPnlSol, tradeCount })
        .onConflictDoUpdate({
          target: [pnlDaily.walletId, pnlDaily.date],
          set: { realizedPnlSol, tradeCount },
        });
    }
  }
}
