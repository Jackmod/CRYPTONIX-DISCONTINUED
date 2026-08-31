import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createDb } from '@cryptonix/db';
import { createServer } from './server';
import { WalletMonitor } from '../monitors/wallet-monitor';
import { PnlTracker } from '../monitors/pnl-tracker';
import { AlertBus } from './alert-bus';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

describe('engine API', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE alerts, pnl_daily, wallet_trades, wallets RESTART IDENTITY CASCADE');
  });

  function buildApp() {
    const helius = {
      createWalletWebhook: vi.fn().mockResolvedValue('wh_1'),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
    } as any;
    const alertBus = new AlertBus();
    const walletMonitor = new WalletMonitor(db, helius, alertBus);
    const pnlTracker = new PnlTracker(db, helius);
    const solanaRpc = { getBalanceSol: vi.fn().mockResolvedValue(4.2) };
    return createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc);
  }

  it('POST /wallets creates a wallet and GET /wallets lists it', async () => {
    const app = buildApp();

    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test', isMine: true });
    expect(createRes.status).toBe(201);
    expect(createRes.body.address).toBe('Addr1');

    const listRes = await request(app).get('/wallets');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
  });

  it('POST /wallets without an address returns 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/wallets').send({ label: 'Test' });
    expect(res.status).toBe(400);
  });

  it('POST /webhooks/helius records a trade visible via GET /wallets/:id/trades', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    await request(app)
      .post('/webhooks/helius')
      .send([
        {
          signature: 'sig1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
        },
      ]);

    const tradesRes = await request(app).get(`/wallets/${walletId}/trades`);
    expect(tradesRes.status).toBe(200);
    expect(tradesRes.body).toHaveLength(1);
    expect(tradesRes.body[0].side).toBe('buy');
  });

  it('a live buy and sell delivered via webhook update PnL, not just backfill', async () => {
    // Regression guard: recomputePnl used to only run at the end of
    // backfillWallet. Live trades recorded by handleWebhookPayload never
    // triggered a recompute, so GET /wallets/:id/pnl stayed frozen at
    // whatever it was when the wallet was added and drifted from reality
    // with every subsequent trade.
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    await request(app)
      .post('/webhooks/helius')
      .send([
        {
          signature: 'buy1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
        },
      ]);

    await request(app)
      .post('/webhooks/helius')
      .send([
        {
          signature: 'sell1',
          timestamp: 1_735_003_600,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', amount: 3_000_000_000 }],
        },
      ]);

    const pnlRes = await request(app).get(`/wallets/${walletId}/pnl`);
    expect(pnlRes.status).toBe(200);
    expect(pnlRes.body).toHaveLength(1);
    expect(pnlRes.body[0].realizedPnlSol).toBeCloseTo(1); // bought for 2, sold for 3
  });

  it('a DB failure while loading tracked wallets returns a non-2xx so Helius retries, instead of 200', async () => {
    // Regression guard: handleWebhookPayload used to swallow this failure
    // and log-and-return, so the route always responded 200 regardless.
    // Helius then considered the batch delivered and never retried it,
    // permanently losing those trades with no re-backfill path.
    const alertBus = new AlertBus();
    const helius = { createWalletWebhook: vi.fn(), getTransactionHistory: vi.fn() } as any;
    const failingDb = {
      select: () => ({ from: () => Promise.reject(new Error('simulated db outage')) }),
    } as any;
    const walletMonitor = new WalletMonitor(failingDb, helius, alertBus);
    const pnlTracker = new PnlTracker(db, helius);
    const solanaRpc = { getBalanceSol: vi.fn() };
    const app = createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc);

    const res = await request(app)
      .post('/webhooks/helius')
      .send([{ signature: 'sig1', timestamp: 1_735_000_000, type: 'SWAP', tokenTransfers: [], nativeTransfers: [] }]);

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
  });

  it('GET /wallets/:id/pnl returns the daily PnL rows', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    const res = await request(app).get(`/wallets/${walletId}/pnl`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /wallets/:id/balance returns the live SOL balance', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    const res = await request(app).get(`/wallets/${walletId}/balance`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ walletId, sol: 4.2 });
  });

  it('GET /wallets/:id/balance returns 404 for an unknown wallet', async () => {
    const app = buildApp();
    const res = await request(app).get('/wallets/4242/balance');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('wallet not found');
  });

  it('rejects a non-numeric wallet id with 400 instead of hanging the request', async () => {
    // Regression guard: Number('abc') is NaN, which Postgres rejects with
    // "invalid input syntax for type integer". Under Express 4 that rejection
    // escaped as an unhandled rejection — the request hung forever and the
    // process was killed under Node's default policy.
    const app = buildApp();

    for (const path of ['/wallets/abc/trades', '/wallets/abc/pnl']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/positive integer/);
    }
  });

  it('returns 500 rather than crashing when a route throws', async () => {
    const alertBus = new AlertBus();
    const helius = {
      createWalletWebhook: vi.fn().mockRejectedValue(new Error('helius is down')),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
    } as any;
    const solanaRpc = { getBalanceSol: vi.fn().mockResolvedValue(0) };
    const app = createServer(
      db,
      new WalletMonitor(db, helius, alertBus),
      new PnlTracker(db, helius),
      alertBus,
      solanaRpc
    );

    const res = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal error');
  });
});
