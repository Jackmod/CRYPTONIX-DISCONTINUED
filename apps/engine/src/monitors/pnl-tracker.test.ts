import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, wallets, walletTrades, pnlDaily } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import { PnlTracker } from './pnl-tracker';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

function swapTx(sig: string, ts: number, overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return { signature: sig, timestamp: ts, type: 'SWAP', tokenTransfers: [], nativeTransfers: [], ...overrides };
}

describe('PnlTracker', () => {
  let walletId: number;

  beforeEach(async () => {
    await db.execute('TRUNCATE pnl_daily, wallet_trades, wallets RESTART IDENTITY CASCADE');
    const [wallet] = await db.insert(wallets).values({ address: 'Addr1', label: 'Test' }).returning();
    walletId = wallet.id;
  });

  it('backfills trade history from Helius and computes daily realized PnL', async () => {
    const helius = {
      getTransactionHistory: vi.fn().mockResolvedValueOnce([
        swapTx('buy1', 1_735_000_000, {
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
        }),
        swapTx('sell1', 1_735_003_600, {
          tokenTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', amount: 3_000_000_000 }],
        }),
      ]).mockResolvedValueOnce([]),
    } as any;
    const tracker = new PnlTracker(db, helius);

    await tracker.backfillWallet(walletId, 'Addr1');

    const trades = await db.select().from(walletTrades);
    expect(trades).toHaveLength(2);

    const pnlRows = await db.select().from(pnlDaily);
    expect(pnlRows).toHaveLength(1);
    expect(pnlRows[0].realizedPnlSol).toBeCloseTo(1); // bought for 2, sold for 3
    expect(pnlRows[0].tradeCount).toBe(2);
  });

  it('breaks same-second ts ties by id, so a buy/sell recorded in the same second is always matched in insertion order', async () => {
    // Regression guard: Helius timestamps are unix SECONDS, so same-second
    // buy/sell pairs are common. Ordering by `ts` alone gives Postgres no
    // stable tie-break, so a sell can sort before its own buy — spuriously
    // "unmatched" (no tracked cost basis) instead of realizing its profit.
    // We force this: the sell is inserted PHYSICALLY FIRST (so a plain scan
    // ordered only by the tied `ts` tends to return it first) but is given
    // the LARGER explicit id, while the buy is inserted second but given the
    // SMALLER id. Only an explicit `.orderBy(ts, id)` tie-break reliably
    // puts the buy before the sell.
    const sameTs = new Date('2026-08-30T10:00:00Z');
    await db.insert(walletTrades).values({
      id: 2,
      walletId,
      signature: 'sell1',
      mint: 'Mint1',
      side: 'sell',
      solAmount: 3,
      tokenAmount: 1000,
      ts: sameTs,
    });
    await db.insert(walletTrades).values({
      id: 1,
      walletId,
      signature: 'buy1',
      mint: 'Mint1',
      side: 'buy',
      solAmount: 2,
      tokenAmount: 1000,
      ts: sameTs,
    });
    const tracker = new PnlTracker(db, {} as any);

    await tracker.recomputePnl(walletId);

    const pnlRows = await db.select().from(pnlDaily);
    expect(pnlRows).toHaveLength(1);
    // Correct FIFO order (buy before sell) realizes a profit of 1 SOL. If the
    // sell were processed first, it would find no cost basis and realize 0.
    expect(pnlRows[0].realizedPnlSol).toBeCloseTo(1);
  });

  it('recomputePnl is idempotent when run twice on the same trades', async () => {
    await db.insert(walletTrades).values([
      { walletId, signature: 'buy1', mint: 'Mint1', side: 'buy', solAmount: 2, tokenAmount: 1000, ts: new Date('2026-08-30T10:00:00Z') },
      { walletId, signature: 'sell1', mint: 'Mint1', side: 'sell', solAmount: 3, tokenAmount: 1000, ts: new Date('2026-08-30T11:00:00Z') },
    ]);
    const tracker = new PnlTracker(db, {} as any);

    await tracker.recomputePnl(walletId);
    await tracker.recomputePnl(walletId);

    const pnlRows = await db.select().from(pnlDaily);
    expect(pnlRows).toHaveLength(1);
    expect(pnlRows[0].realizedPnlSol).toBeCloseTo(1);
  });
});
