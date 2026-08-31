import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, walletTrades, alerts } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import { WalletMonitor } from './wallet-monitor';
import { AlertBus } from '../api/alert-bus';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

function fakeHelius(webhookId = 'wh_1') {
  return { createWalletWebhook: vi.fn().mockResolvedValue(webhookId) } as any;
}

function swapTx(overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return {
    signature: 'sig1',
    timestamp: 1_735_000_000,
    type: 'SWAP',
    tokenTransfers: [],
    nativeTransfers: [],
    ...overrides,
  };
}

describe('WalletMonitor', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE alerts, wallet_trades, wallets RESTART IDENTITY CASCADE');
  });

  it('tracks a wallet: registers a Helius webhook and inserts a row', async () => {
    const helius = fakeHelius('wh_42');
    const monitor = new WalletMonitor(db, helius, new AlertBus());

    const wallet = await monitor.trackWallet('Addr1', 'My Wallet', true);

    expect(helius.createWalletWebhook).toHaveBeenCalledWith('Addr1');
    expect(wallet.address).toBe('Addr1');
    expect(wallet.heliusWebhookId).toBe('wh_42');
    expect(wallet.isMine).toBe(true);
  });

  it('handles an incoming buy transaction: records the trade and publishes an alert', async () => {
    const helius = fakeHelius();
    const alertBus = new AlertBus();
    const published: unknown[] = [];
    alertBus.on('alert', (a) => published.push(a));
    const monitor = new WalletMonitor(db, helius, alertBus);
    const wallet = await monitor.trackWallet('Addr1', 'My Wallet', true);

    await monitor.handleWebhookPayload([
      swapTx({
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
      }),
    ]);

    const trades = await db.select().from(walletTrades);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('buy');
    expect(trades[0].solAmount).toBe(2);

    const alertRows = await db.select().from(alerts);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].type).toBe('wallet_buy');
    expect((alertRows[0].payload as any).axiomLink).toBe('https://axiom.trade/t/Mint1');

    expect(published).toHaveLength(1);
    expect((published[0] as any).type).toBe('wallet_buy');
  });

  it('is idempotent: the same signature delivered twice only records one trade', async () => {
    const monitor = new WalletMonitor(db, fakeHelius(), new AlertBus());
    await monitor.trackWallet('Addr1', 'My Wallet', true);
    const tx = swapTx({
      tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
      nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
    });

    await monitor.handleWebhookPayload([tx]);
    await monitor.handleWebhookPayload([tx]);

    const trades = await db.select().from(walletTrades);
    expect(trades).toHaveLength(1);
  });

  it('a transaction irrelevant to any tracked wallet produces no trade or alert', async () => {
    const monitor = new WalletMonitor(db, fakeHelius(), new AlertBus());
    await monitor.trackWallet('Addr1', 'My Wallet', true);

    await monitor.handleWebhookPayload([
      swapTx({
        tokenTransfers: [{ fromUserAccount: 'SomeoneElse', toUserAccount: 'AnotherWallet', mint: 'Mint1', tokenAmount: 10 }],
      }),
    ]);

    expect(await db.select().from(walletTrades)).toHaveLength(0);
  });
});
