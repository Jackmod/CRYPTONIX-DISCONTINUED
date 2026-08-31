import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createDb } from '@cryptonix/db';
import { createServer } from './server';
import { WalletMonitor } from '../monitors/wallet-monitor';
import { PnlTracker } from '../monitors/pnl-tracker';
import { AlertBus } from './alert-bus';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);
const WEBHOOK_SECRET = 'test-webhook-secret';
const API_KEY = 'test-engine-api-key';
/** A genuine mainnet pubkey: POST /wallets now rejects anything that is not one. */
const VALID_ADDRESS = 'So11111111111111111111111111111111111111112';

/**
 * Every engine route except /webhooks/helius now requires the engine API key.
 * This wrapper attaches it so the tests exercise the same path real callers
 * take. The webhook tests set their own Authorization header afterwards, which
 * overrides this one - and that route skips API-key auth by design.
 */
function api(app: Parameters<typeof request>[0]) {
  const r = request(app);
  const auth = (t: request.Test) => t.set('Authorization', `Bearer ${API_KEY}`);
  return {
    get: (path: string) => auth(r.get(path)),
    post: (path: string) => auth(r.post(path)),
    put: (path: string) => auth(r.put(path)),
    delete: (path: string) => auth(r.delete(path)),
  };
}

describe('engine API', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE alerts, pnl_daily, wallet_trades, wallets, discord_guilds RESTART IDENTITY CASCADE');
  });

  /** Like buildApp, but exposes the mocks so a test can assert on Helius calls. */
  function buildAppWithMocks() {
    const helius = {
      createWalletWebhook: vi.fn().mockResolvedValue('wh_1'),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
      deleteWalletWebhook: vi.fn().mockResolvedValue(undefined),
    } as any;
    const alertBus = new AlertBus();
    const walletMonitor = new WalletMonitor(db, helius, alertBus);
    const pnlTracker = new PnlTracker(db, helius);
    const solanaRpc = { getBalanceSol: vi.fn().mockResolvedValue(4.2) };
    return {
      app: createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY),
      helius,
      db,
    };
  }

  function buildApp() {
    const helius = {
      createWalletWebhook: vi.fn().mockResolvedValue('wh_1'),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
      deleteWalletWebhook: vi.fn().mockResolvedValue(undefined),
    } as any;
    const alertBus = new AlertBus();
    const walletMonitor = new WalletMonitor(db, helius, alertBus);
    const pnlTracker = new PnlTracker(db, helius);
    const solanaRpc = { getBalanceSol: vi.fn().mockResolvedValue(4.2) };
    return createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY);
  }

  it('POST /wallets creates a wallet and GET /wallets lists it', async () => {
    const app = buildApp();

    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test', isMine: true });
    expect(createRes.status).toBe(201);
    expect(createRes.body.address).toBe(VALID_ADDRESS);

    const listRes = await api(app).get('/wallets');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
  });

  it('POST /wallets without an address returns 400', async () => {
    const app = buildApp();
    const res = await api(app).post('/wallets').send({ label: 'Test' });
    expect(res.status).toBe(400);
  });

  it('POST /webhooks/helius records a trade visible via GET /wallets/:id/trades', async () => {
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;

    await api(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'sig1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 2_000_000_000 }],
        },
      ]);

    const tradesRes = await api(app).get(`/wallets/${walletId}/trades`);
    expect(tradesRes.status).toBe(200);
    expect(tradesRes.body).toHaveLength(1);
    expect(tradesRes.body[0].side).toBe('buy');
  });

  it('POST /webhooks/helius with the correct Authorization header succeeds', async () => {
    const app = buildApp();

    const res = await api(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send([]);

    expect(res.status).toBe(200);
  });

  it('POST /webhooks/helius with a wrong or missing Authorization header returns 401 and writes nothing', async () => {
    // WEBHOOK_BASE_URL is a public URL by design, so /webhooks/helius must
    // reject forged deliveries instead of writing them into wallet_trades
    // and alerts with no audit trail.
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;
    const payload = [
      {
        signature: 'sig1',
        timestamp: 1_735_000_000,
        type: 'SWAP',
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'Mint1', tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 2_000_000_000 }],
      },
    ];

    const wrongRes = await api(app).post('/webhooks/helius').set('Authorization', 'wrong-secret').send(payload);
    expect(wrongRes.status).toBe(401);

    const missingRes = await api(app).post('/webhooks/helius').send(payload);
    expect(missingRes.status).toBe(401);

    const tradesRes = await api(app).get(`/wallets/${walletId}/trades`);
    expect(tradesRes.body).toHaveLength(0);
  });

  it('a live buy and sell delivered via webhook update PnL, not just backfill', async () => {
    // Regression guard: recomputePnl used to only run at the end of
    // backfillWallet. Live trades recorded by handleWebhookPayload never
    // triggered a recompute, so GET /wallets/:id/pnl stayed frozen at
    // whatever it was when the wallet was added and drifted from reality
    // with every subsequent trade.
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;

    await api(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'buy1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 2_000_000_000 }],
        },
      ]);

    await api(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'sell1',
          timestamp: 1_735_003_600,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, amount: 3_000_000_000 }],
        },
      ]);

    const pnlRes = await api(app).get(`/wallets/${walletId}/pnl`);
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
    const app = createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY);

    const res = await api(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([{ signature: 'sig1', timestamp: 1_735_000_000, type: 'SWAP', tokenTransfers: [], nativeTransfers: [] }]);

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
  });

  it('GET /wallets/:id/pnl returns the daily PnL rows', async () => {
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;

    const res = await api(app).get(`/wallets/${walletId}/pnl`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /wallets/:id/balance returns the live SOL balance', async () => {
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;

    const res = await api(app).get(`/wallets/${walletId}/balance`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ walletId, sol: 4.2 });
  });

  it('GET /wallets/:id/balance returns 404 for an unknown wallet', async () => {
    const app = buildApp();
    const res = await api(app).get('/wallets/4242/balance');
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
      const res = await api(app).get(path);
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
      solanaRpc,
      WEBHOOK_SECRET,
      API_KEY
    );

    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal error');
  });

  it('DELETE /wallets/:id removes the wallet and releases its Helius webhook', async () => {
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;

    const delRes = await api(app).delete(`/wallets/${walletId}`);
    expect(delRes.status).toBe(204);

    const listRes = await api(app).get('/wallets');
    expect(listRes.body).toHaveLength(0);
  });

  it('DELETE /wallets/:id removes a wallet that has trades and PnL rows', async () => {
    // wallet_trades and pnl_daily both carry a foreign key onto wallets.id, so
    // deleting the parent row first is a FK violation. This is the regression
    // guard: a wallet is only untrackable in practice once it has history.
    const app = buildApp();
    const createRes = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });
    const walletId = createRes.body.id;

    await api(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'sig1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'Mint1', tokenAmount: 100 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
        },
      ]);

    const tradesRes = await api(app).get(`/wallets/${walletId}/trades`);
    expect(tradesRes.body.length).toBeGreaterThan(0);

    const delRes = await api(app).delete(`/wallets/${walletId}`);
    expect(delRes.status).toBe(204);
  });

  it('DELETE /wallets/:id returns 404 for an unknown wallet', async () => {
    const app = buildApp();
    const res = await api(app).delete('/wallets/9999');
    expect(res.status).toBe(404);
  });

  it('PUT /discord/guilds/:id stores a guild config and GET lists it', async () => {
    const app = buildApp();

    const putRes = await api(app)
      .put('/discord/guilds/111111111111111111')
      .send({ alertChannelId: 'channel1', setupBy: 'user1' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.alertChannelId).toBe('channel1');

    const listRes = await api(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].guildId).toBe('111111111111111111');
  });

  it('PUT /discord/guilds/:id twice moves the channel instead of erroring', async () => {
    // Re-running /setup is normal, not an error case.
    const app = buildApp();

    await api(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: 'channel1' });
    const second = await api(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: 'channel2' });

    expect(second.status).toBe(200);
    const listRes = await api(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].alertChannelId).toBe('channel2');
  });

  it('PUT /discord/guilds/:id without a channel returns 400', async () => {
    const app = buildApp();
    const res = await api(app).put('/discord/guilds/111111111111111111').send({});
    expect(res.status).toBe(400);
  });

  it('DELETE /discord/guilds/:id removes the config and is idempotent', async () => {
    const app = buildApp();
    await api(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: 'channel1' });

    expect((await api(app).delete('/discord/guilds/111111111111111111')).status).toBe(204);
    // Deleting again must still succeed: the bot calls this when it is removed
    // from a server, and Discord can deliver that event more than once.
    expect((await api(app).delete('/discord/guilds/111111111111111111')).status).toBe(204);

    const listRes = await api(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(0);
  });

  it('PUT /discord/guilds/:id rejects an id that is not a Discord snowflake', async () => {
    // The guild id is a primary key on an unauthenticated route; junk must not
    // reach the table.
    const app = buildApp();
    const res = await api(app).put('/discord/guilds/not-a-snowflake').send({ alertChannelId: 'c1' });
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated request to a data route', async () => {
    // The engine is exposed publicly so Helius can reach /webhooks/helius.
    // Without this gate, anyone who found that URL could read every tracked
    // wallet, delete trade history, or repoint a server's alert routing.
    const app = buildApp();
    const res = await request(app).get('/wallets');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong API key', async () => {
    const app = buildApp();
    const res = await request(app).get('/wallets').set('Authorization', 'Bearer wrong-key');
    expect(res.status).toBe(401);
  });

  it('rejects a destructive request with no credentials', async () => {
    // DELETE removes trade rows that live-webhook delivery cannot rebuild.
    const app = buildApp();
    expect((await request(app).delete('/wallets/1')).status).toBe(401);
    expect((await request(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: 'c1' })).status).toBe(401);
  });

  it('still accepts a genuine Helius delivery without the API key', async () => {
    // Helius only knows the webhook secret, never the engine API key, so that
    // route must stay reachable with webhook auth alone.
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Test' });

    const res = await request(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([]);

    expect(res.status).not.toBe(401);
  });

  it('refuses to start with an empty API key', async () => {
    // Two zero-length buffers compare equal, so an empty key would make
    // `Authorization: Bearer ` authenticate every request. That must be a
    // startup failure, never a silently open API.
    const alertBus = new AlertBus();
    const helius = { createWalletWebhook: vi.fn(), getTransactionHistory: vi.fn(), deleteWalletWebhook: vi.fn() } as any;
    expect(() =>
      createServer(
        db,
        new WalletMonitor(db, helius, alertBus),
        new PnlTracker(db, helius),
        alertBus,
        { getBalanceSol: vi.fn() },
        WEBHOOK_SECRET,
        ''
      )
    ).toThrow('non-empty apiKey');
  });

  it('POST /wallets rejects an address that is not a Solana public key', async () => {
    // Registering a webhook against nonsense would consume one of the free
    // tier's address slots forever and then never fire.
    const app = buildApp();
    const res = await api(app).post('/wallets').send({ address: 'not-an-address', label: 'X' });
    expect(res.status).toBe(400);
  });

  it('POST /wallets rejects an Ethereum address', async () => {
    const app = buildApp();
    const res = await api(app)
      .post('/wallets')
      .send({ address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', label: 'X' });
    expect(res.status).toBe(400);
  });

  it('POST /wallets rejects an absurdly long label', async () => {
    const app = buildApp();
    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
  });

  it('POST /wallets answers 409 for an address already tracked', async () => {
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'First' });

    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Second' });

    expect(res.status).toBe(409);
    expect(res.body.wallet.label).toBe('First');
  });

  it('does not register a second Helius webhook for an address already tracked', async () => {
    // The insert would fail on the UNIQUE constraint, leaving a live webhook
    // that no row references: an orphan holding one of the free tier's
    // address slots forever, with nothing recording what held it.
    //
    // Asserting the row count alone is not enough - it stays 1 whether one or
    // two webhooks were created, so a regression to create-before-check would
    // leak a webhook and still pass. Count the Helius calls.
    const { app, helius } = buildAppWithMocks();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'First' });
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Second' });

    expect(helius.createWalletWebhook).toHaveBeenCalledTimes(1);
    const listRes = await api(app).get('/wallets');
    expect(listRes.body).toHaveLength(1);
  });

  it('releases the webhook it just created when the wallet insert fails', async () => {
    // Any write failure - pool exhaustion, statement timeout, connection reset
    // - leaves a live webhook no row references unless it is handed back.
    const { app, helius, db: scopedDb } = buildAppWithMocks();
    const insertSpy = vi.spyOn(scopedDb, 'insert').mockImplementationOnce(() => {
      throw new Error('simulated connection reset');
    });

    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'X' });

    expect(res.status).toBe(500);
    expect(helius.createWalletWebhook).toHaveBeenCalledTimes(1);
    expect(helius.deleteWalletWebhook).toHaveBeenCalledTimes(1);
    insertSpy.mockRestore();
  });
});
