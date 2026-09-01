import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createDb } from '@cryptonix/db';
import { createServer } from './server';
import { WalletMonitor } from '../monitors/wallet-monitor';
import { PnlTracker } from '../monitors/pnl-tracker';
import { AlertBus } from './alert-bus';
import { HeliusError } from '../helius/client';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);
const WEBHOOK_SECRET = 'test-webhook-secret';
const API_KEY = 'test-engine-api-key';
/** A genuine mainnet pubkey: POST /wallets now rejects anything that is not one. */
const VALID_ADDRESS = 'So11111111111111111111111111111111111111112';
const SECOND_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
    patch: (path: string) => auth(r.patch(path)),
    delete: (path: string) => auth(r.delete(path)),
  };
}

describe('engine API', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE alerts, pnl_daily, wallet_trades, wallets, discord_guilds, client_state RESTART IDENTITY CASCADE');
  });

  /** Like buildApp, but exposes the mocks so a test can assert on Helius calls. */
  function buildAppWithMocks({ alertSettleMs = 0 }: { alertSettleMs?: number } = {}) {
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
      app: createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY, alertSettleMs),
      helius,
      pnlTracker,
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
    return createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY, 0);
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
    const app = createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY, 0);

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
      API_KEY,
      0
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
      .send({ alertChannelId: '900000000000000001', setupBy: 'user1' });
    expect(putRes.status).toBe(200);
    expect(putRes.body.alertChannelId).toBe('900000000000000001');

    const listRes = await api(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].guildId).toBe('111111111111111111');
  });

  it('PUT /discord/guilds/:id twice moves the channel instead of erroring', async () => {
    // Re-running /setup is normal, not an error case.
    const app = buildApp();

    await api(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: '900000000000000001' });
    const second = await api(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: '900000000000000002' });

    expect(second.status).toBe(200);
    const listRes = await api(app).get('/discord/guilds');
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].alertChannelId).toBe('900000000000000002');
  });

  it('PUT /discord/guilds/:id without a channel returns 400', async () => {
    const app = buildApp();
    const res = await api(app).put('/discord/guilds/111111111111111111').send({});
    expect(res.status).toBe(400);
  });

  it('DELETE /discord/guilds/:id removes the config and is idempotent', async () => {
    const app = buildApp();
    await api(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: '900000000000000001' });

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
    const res = await api(app).put('/discord/guilds/not-a-snowflake').send({ alertChannelId: '900000000000000001' });
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
    expect((await request(app).put('/discord/guilds/111111111111111111').send({ alertChannelId: '900000000000000001' })).status).toBe(401);
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

  it('POST /wallets answers 502 with the Helius reason, not a bare 500', async () => {
    // The common cause is a WEBHOOK_BASE_URL Helius cannot reach. Reporting
    // that as "internal error" sends the operator hunting in the database.
    const { app, helius } = buildAppWithMocks();
    helius.createWalletWebhook.mockRejectedValue(
      new HeliusError('Helius webhook create failed: Invalid webhook URL format', 400)
    );

    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'X' });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Invalid webhook URL format');
  });

  it('still answers 500 for a failure that is not from Helius', async () => {
    const { app, helius } = buildAppWithMocks();
    helius.createWalletWebhook.mockRejectedValue(new Error('something else entirely'));

    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'X' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal error');
  });

  it('POST /wallets rejects a non-string label or address', async () => {
    // [] and {} are truthy and their .length clears the cap (0 and undefined),
    // so they used to reach the database and render as '' or '[object Object]'
    // in a Discord embed.
    const app = buildApp();
    for (const body of [
      { address: VALID_ADDRESS, label: [] },
      { address: VALID_ADDRESS, label: {} },
      { address: VALID_ADDRESS, label: 123 },
      { address: [], label: 'X' },
      { address: {}, label: 'X' },
    ]) {
      const res = await api(app).post('/wallets').send(body as any);
      expect(res.status, `${JSON.stringify(body)} must be rejected`).toBe(400);
    }
  });

  it('re-registers and backfills a wallet left holding no webhook', async () => {
    // This is the half-untracked state: untrack released the webhook, then a
    // row delete failed. Answering a plain 409 would re-webhook the wallet and
    // leave it permanently empty, because its trades may already be gone.
    const { app, helius } = buildAppWithMocks();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    await db.execute(`UPDATE wallets SET helius_webhook_id = NULL WHERE id = ${created.body.id}`);
    helius.createWalletWebhook.mockClear();
    helius.getTransactionHistory.mockClear();

    const res = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });

    expect(res.status).toBe(200); // repaired, not created, not a bare conflict
    expect(helius.createWalletWebhook).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(helius.getTransactionHistory).toHaveBeenCalled();
  });

  it('PUT /discord/guilds rejects a channel id that is not a snowflake', async () => {
    // This row drives every alert for the guild. A non-string would persist as
    // '[object Object]' and permanently break fan-out with no obvious cause.
    const app = buildApp();
    for (const alertChannelId of ['not-a-snowflake', '', 123, {}, [], null]) {
      const res = await api(app)
        .put('/discord/guilds/111111111111111111')
        .send({ alertChannelId } as any);
      expect(res.status, `${JSON.stringify(alertChannelId)} must be rejected`).toBe(400);
    }
  });

  it('answers malformed JSON with JSON, never an HTML stack trace', async () => {
    // body-parser used to throw past every handler into Express's default
    // error page, which renders absolute filesystem paths and pinned
    // dependency versions -- to unauthenticated callers, on a service that is
    // publicly reachable by design.
    const app = buildApp();

    const res = await api(app).post('/wallets').set('Content-Type', 'application/json').send('{bad');

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('node_modules');
    expect(res.text).not.toContain('SyntaxError');
    expect(res.body.error).toBe('request body is not valid JSON');
  });

  it('rejects an unauthenticated malformed body before it is ever parsed', async () => {
    const app = buildApp();

    const res = await request(app).post('/wallets').set('Content-Type', 'application/json').send('{bad');

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('node_modules');
  });

  it('registers exactly one webhook when two requests heal the same wallet at once', async () => {
    // Both see helius_webhook_id IS NULL and both create a webhook. Only the
    // conditional UPDATE stops the loser's from being orphaned.
    const { app, helius } = buildAppWithMocks();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    await db.execute(`UPDATE wallets SET helius_webhook_id = NULL WHERE id = ${created.body.id}`);
    helius.createWalletWebhook.mockClear();
    helius.deleteWalletWebhook.mockClear();

    await Promise.all([
      api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' }),
      api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' }),
      api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' }),
    ]);

    const created_ = helius.createWalletWebhook.mock.calls.length;
    const deleted = helius.deleteWalletWebhook.mock.calls.length;
    // Every webhook beyond the one the winner kept must have been handed back.
    expect(created_ - deleted).toBe(1);
  });

  it('rejects a forged webhook before its body is ever parsed', async () => {
    // A forged delivery used to reach body-parser, which would read and parse
    // up to 2mb of attacker-supplied JSON before the route's own check ran.
    const app = buildApp();

    const res = await request(app)
      .post('/webhooks/helius')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'wrong-secret')
      .send('{bad');

    expect(res.status).toBe(401); // not 400: never parsed
    expect(res.body.error).toBe('invalid webhook authorization');
  });

  it('GET /alerts returns only alerts after `since`, oldest first', async () => {
    // The socket only reaches clients connected at publication time, so a
    // trade landing during a restart or reconnect backoff was recorded and
    // never delivered. This is how a reconnecting bot catches up.
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });

    for (const sig of ['a', 'b', 'c']) {
      await request(app)
        .post('/webhooks/helius')
        .set('Authorization', WEBHOOK_SECRET)
        .send([
          {
            signature: `alert-${sig}`,
            timestamp: 1_787_000_000,
            type: 'SWAP',
            tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
            nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
          },
        ]);
    }

    const all = await api(app).get('/alerts?since=0');
    expect(all.body).toHaveLength(3);
    expect(all.body[0].id).toBeLessThan(all.body[2].id);

    const after = await api(app).get(`/alerts?since=${all.body[0].id}`);
    expect(after.body).toHaveLength(2);
    expect(after.body.every((a: { id: number }) => a.id > all.body[0].id)).toBe(true);
  });

  it('GET /alerts rejects a nonsense since value', async () => {
    const app = buildApp();
    for (const since of ['abc', '-1', '1.5']) {
      const res = await api(app).get(`/alerts?since=${since}`);
      expect(res.status, `since=${since} must be rejected`).toBe(400);
    }
  });

  it('publishes the alert row id so a client can resume from it', async () => {
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    await request(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'id-check',
          timestamp: 1_787_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
        },
      ]);

    const alertsRes = await api(app).get('/alerts?since=0');
    expect(alertsRes.body[0].id).toBeGreaterThan(0);
  });

  it('GET /alerts/head reports the NEWEST id, not the oldest', async () => {
    // listAlertsSince(0) cannot serve this: it returns an ascending, capped
    // page, so a client using it as the head would resume from the oldest row
    // and replay real history.
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });

    expect((await api(app).get('/alerts/head')).body.id).toBe(0);

    for (const sig of ['h1', 'h2', 'h3']) {
      await request(app)
        .post('/webhooks/helius')
        .set('Authorization', WEBHOOK_SECRET)
        .send([
          {
            signature: sig,
            timestamp: 1_787_000_000,
            type: 'SWAP',
            tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
            nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
          },
        ]);
    }

    const all = await api(app).get('/alerts?since=0');
    const head = await api(app).get('/alerts/head');

    expect(head.body.id).toBe(Math.max(...all.body.map((a: { id: number }) => a.id)));
    // Resuming from the head yields nothing, which is the whole point.
    expect((await api(app).get(`/alerts?since=${head.body.id}`)).body).toHaveLength(0);
  });

  it('answers a browser preflight without demanding the api key', async () => {
    // A preflight carries no Authorization header at all, so authenticating it
    // would 401 every one — and the desktop app, whose origin is never the
    // engine's, would then be unable to make a single REST call.
    const app = buildApp();
    const res = await request(app).options('/wallets');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
  });

  it('lets a browser read a real response, not only the preflight', async () => {
    const app = buildApp();
    const res = await api(app).get('/wallets');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('marks an error response readable too, so the app can show the reason', async () => {
    // Without the header on a 401 the browser hides the body, and the app can
    // only report "cannot reach the engine" for a wrong key.
    const app = buildApp();
    const res = await request(app).get('/wallets');
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('does not allow credentials, which is what makes the wildcard origin legal', () => {
    // This API is bearer-token only; a cookie must never ride along.
    return request(buildApp())
      .options('/wallets')
      .expect((res) => {
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      });
  });

  it('still refuses a real request with no key, preflight or not', async () => {
    const app = buildApp();
    expect((await request(app).post('/wallets').send({ address: 'x', label: 'y' })).status).toBe(401);
  });

  it('PATCH /wallets/:id renames a wallet without touching its history', async () => {
    // Untracking was the only way to fix a label, and that deletes the trades
    // and the PnL under it, then costs a fresh Helius backfill to recover.
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'Unkown Whale' });
    await request(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'rename-1',
          timestamp: 1_787_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
        },
      ]);

    const before = await api(app).get(`/wallets/${created.body.id}/trades`);
    expect(before.body).toHaveLength(1);

    const patched = await api(app).patch(`/wallets/${created.body.id}`).send({ label: 'Ansem' });
    expect(patched.status).toBe(200);
    expect(patched.body.label).toBe('Ansem');
    expect(patched.body.address).toBe(VALID_ADDRESS);

    const after = await api(app).get(`/wallets/${created.body.id}/trades`);
    expect(after.body).toHaveLength(1);
  });

  it('PATCH /wallets/:id can mark a wallet as yours, or unmark it', async () => {
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    expect(created.body.isMine).toBe(false);

    expect((await api(app).patch(`/wallets/${created.body.id}`).send({ isMine: true })).body.isMine).toBe(true);
    expect((await api(app).patch(`/wallets/${created.body.id}`).send({ isMine: false })).body.isMine).toBe(false);
  });

  it('PATCH /wallets/:id leaves the field that was not sent alone', async () => {
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W', isMine: true });

    const patched = await api(app).patch(`/wallets/${created.body.id}`).send({ label: 'Renamed' });
    expect(patched.body.label).toBe('Renamed');
    expect(patched.body.isMine).toBe(true);
  });

  it('PATCH /wallets/:id refuses a change that would say nothing', async () => {
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    expect((await api(app).patch(`/wallets/${created.body.id}`).send({})).status).toBe(400);
  });

  it('PATCH /wallets/:id refuses a label the embeds could not carry', async () => {
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    for (const label of ['', '   ', 42, {}, 'x'.repeat(101)]) {
      const res = await api(app).patch(`/wallets/${created.body.id}`).send({ label });
      expect(res.status, `label ${JSON.stringify(label)} must be rejected`).toBe(400);
    }
  });

  it('PATCH /wallets/:id refuses a non-boolean isMine rather than coercing it', async () => {
    // Boolean('false') is true, so coercion would flip the flag the wrong way.
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    expect((await api(app).patch(`/wallets/${created.body.id}`).send({ isMine: 'false' })).status).toBe(400);
    expect((await api(app).get('/wallets')).body[0].isMine).toBe(false);
  });

  it('PATCH /wallets/:id does not let the address be rewritten', async () => {
    // Changing it would point a wallet's whole recorded history at another account.
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    const patched = await api(app)
      .patch(`/wallets/${created.body.id}`)
      .send({ label: 'W2', address: 'So11111111111111111111111111111111111111112' });
    expect(patched.body.address).toBe(VALID_ADDRESS);
  });

  it('PATCH /wallets/:id answers 404 for a wallet that is not there', async () => {
    const app = buildApp();
    expect((await api(app).patch('/wallets/99999').send({ label: 'x' })).status).toBe(404);
  });

  it('PATCH /wallets/:id needs the api key', async () => {
    const app = buildApp();
    expect((await request(app).patch('/wallets/1').send({ label: 'x' })).status).toBe(401);
  });

  it('GET /alerts/recent returns the NEWEST alerts, newest first', async () => {
    // Regression: the desktop rail seeded itself with `/alerts?since=0`, which
    // is an ascending capped page — so it opened on the oldest alerts in the
    // whole history rather than on what had just happened.
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });

    for (const sig of ['r1', 'r2', 'r3', 'r4']) {
      await request(app)
        .post('/webhooks/helius')
        .set('Authorization', WEBHOOK_SECRET)
        .send([
          {
            signature: sig,
            timestamp: 1_787_000_000,
            type: 'SWAP',
            tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
            nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
          },
        ]);
    }

    const recent = await api(app).get('/alerts/recent?limit=2');
    const head = await api(app).get('/alerts/head');

    expect(recent.body).toHaveLength(2);
    expect(recent.body[0].id).toBe(head.body.id);
    expect(recent.body[0].id).toBeGreaterThan(recent.body[1].id);
  });

  it('GET /alerts/recent defaults to a page rather than everything', async () => {
    const app = buildApp();
    expect((await api(app).get('/alerts/recent')).status).toBe(200);
  });

  it('GET /alerts/recent caps the limit a caller can ask for', async () => {
    const app = buildApp();
    // Larger than the cap is clamped, not refused: a viewer asking for more
    // than the server will give is not an error.
    expect((await api(app).get('/alerts/recent?limit=100000')).status).toBe(200);
  });

  it('GET /alerts/recent rejects a nonsense limit', async () => {
    const app = buildApp();
    for (const limit of ['abc', '0', '-1', '1.5', '']) {
      const res = await api(app).get(`/alerts/recent?limit=${limit}`);
      expect(res.status, `limit=${limit} must be rejected`).toBe(400);
    }
  });

  it('GET /alerts/recent needs the api key like everything else', async () => {
    const app = buildApp();
    expect((await request(app).get('/alerts/recent')).status).toBe(401);
  });

  it('untracking a wallet also removes its alerts', async () => {
    // alerts.ref_id has no foreign key, so nothing else would delete them and
    // the replay endpoint could push an untracked wallet's trades to Discord.
    const app = buildApp();
    const created = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    await request(app)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'to-be-removed',
          timestamp: 1_787_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
        },
      ]);
    expect((await api(app).get('/alerts?since=0')).body).toHaveLength(1);

    await api(app).delete(`/wallets/${created.body.id}`);

    expect((await api(app).get('/alerts?since=0')).body).toHaveLength(0);
  });

  it('GET /alerts rejects a repeated since parameter instead of treating it as 0', async () => {
    // A repeated query param arrives as an array; coercing it to 0 silently
    // returned the OLDEST alerts, and a client resuming from there replays
    // history into live channels.
    const app = buildApp();

    const res = await api(app).get('/alerts?since=1&since=2');

    expect(res.status).toBe(400);
  });

  it('stores and reads back client state', async () => {
    // The bot's alert cursor lives here. Held only in memory it reset to the
    // head on every start, so alerts published while the bot was DOWN were
    // never replayed.
    const app = buildApp();

    expect((await api(app).get('/state/discord-bot:1:alert-cursor')).body.value).toBeNull();

    const put = await api(app).put('/state/discord-bot:1:alert-cursor').send({ value: '42' });
    expect(put.status).toBe(200);

    expect((await api(app).get('/state/discord-bot:1:alert-cursor')).body.value).toBe('42');

    await api(app).put('/state/discord-bot:1:alert-cursor').send({ value: '77' });
    expect((await api(app).get('/state/discord-bot:1:alert-cursor')).body.value).toBe('77');
  });

  it('rejects a hostile or oversized state key or value', async () => {
    const app = buildApp();

    for (const key of ['../../etc/passwd', 'has space', '', 'k'.repeat(200)]) {
      const res = await api(app).put(`/state/${encodeURIComponent(key)}`).send({ value: 'x' });
      expect([400, 404], `key ${key}`).toContain(res.status);
    }

    for (const value of [123, {}, [], null, 'v'.repeat(5000)]) {
      const res = await api(app).put('/state/ok-key').send({ value } as never);
      expect(res.status, `value ${JSON.stringify(value)}`).toBe(400);
    }
  });

  it('GET /alerts rejects an empty since value', async () => {
    // `?since=` slipped through `?? '0'` as '' and Number('') is 0, returning
    // the OLDEST alerts to a caller that asked to resume.
    const app = buildApp();
    expect((await api(app).get('/alerts?since=')).status).toBe(400);
  });

  it('retries a failed recompute on the redelivery its own 500 triggers', async () => {
    // The route answers 500 so Helius redelivers. On redelivery every trade
    // hits onConflictDoNothing and looks like a duplicate, so a 'new trades
    // only' rule skipped the recompute and answered 200 -- leaving pnl_daily
    // stale and /pnl wrong until some unrelated future trade arrived.
    const { app, pnlTracker } = buildAppWithMocks();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });

    const batch = [
      {
        signature: 'retry-recompute-sig',
        timestamp: 1_787_000_000,
        type: 'SWAP',
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 100 }],
        nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
      },
    ];

    const spy = vi.spyOn(pnlTracker, 'recomputePnl').mockRejectedValueOnce(new Error('transient db failure'));

    const first = await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    expect(first.status).toBe(500); // so Helius will redeliver

    // The redelivery carries no NEW trades, yet the recompute must still run.
    const second = await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    expect(second.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);

    const wallets = await api(app).get('/wallets');
    expect((await api(app).get(`/wallets/${wallets.body[0].id}/pnl`)).body.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('does not re-walk a wallet on an ordinary redelivery that never failed', async () => {
    // Recomputing on EVERY redelivery re-walks a long-history wallet's whole
    // trade table inline before the 200, which can exceed Helius's own
    // delivery timeout.
    const { app, pnlTracker } = buildAppWithMocks();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });

    const batch = [
      {
        signature: 'no-rewalk-sig',
        timestamp: 1_787_000_000,
        type: 'SWAP',
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 100 }],
        nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
      },
    ];

    await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    const spy = vi.spyOn(pnlTracker, 'recomputePnl');

    await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still records a redelivered trade only once', async () => {
    // Recomputing on redelivery must not come at the cost of duplicate trades.
    const app = buildApp();
    await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    const batch = [
      {
        signature: 'dupe-guard-sig',
        timestamp: 1_787_000_000,
        type: 'SWAP',
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 100 }],
        nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
      },
    ];

    await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);

    const wallets = await api(app).get('/wallets');
    const trades = await api(app).get(`/wallets/${wallets.body[0].id}/trades`);
    expect(trades.body).toHaveLength(1);
  });

  it('retries every wallet in a batch, not just the first that failed', async () => {
    // Throwing from inside the loop meant a batch touching A and B, where A
    // failed, never reached B -- and on the redelivery B had no new trades and
    // was not in the retry set either, so its pnl_daily stayed stale for good.
    const { app, pnlTracker } = buildAppWithMocks();
    const a = await api(app).post('/wallets').send({ address: VALID_ADDRESS, label: 'A' });
    const b = await api(app).post('/wallets').send({ address: SECOND_ADDRESS, label: 'B' });

    const swap = (address: string, signature: string) => ({
      signature,
      timestamp: 1_787_000_000,
      type: 'SWAP',
      tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: address, mint: 'M', tokenAmount: 100 }],
      nativeTransfers: [{ fromUserAccount: address, toUserAccount: 'Pool', amount: 1_000_000_000 }],
    });
    const batch = [swap(VALID_ADDRESS, 'batch-a'), swap(SECOND_ADDRESS, 'batch-b')];

    // Wallet A's recompute fails on the first delivery.
    const spy = vi
      .spyOn(pnlTracker, 'recomputePnl')
      .mockImplementationOnce(async () => {
        throw new Error('transient failure for A');
      });

    const first = await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    expect(first.status).toBe(500);

    // B must still have been attempted in that same pass.
    expect(spy.mock.calls.map((c) => c[0])).toContain(b.body.id);
    spy.mockRestore();

    // And the redelivery retries A even though it carries no new trades.
    const second = await request(app).post('/webhooks/helius').set('Authorization', WEBHOOK_SECRET).send(batch);
    expect(second.status).toBe(200);
    expect((await api(app).get(`/wallets/${a.body.id}/pnl`)).body.length).toBeGreaterThan(0);
  });

  it('GET /alerts withholds an alert until it has settled', async () => {
    // Postgres allocates a serial before commit, so a higher id can be visible
    // while a lower one is still in flight; a client walking in that window
    // would advance past the lower id and never see it.
    const { app: settling } = buildAppWithMocks({ alertSettleMs: 60_000 });
    await api(settling).post('/wallets').send({ address: VALID_ADDRESS, label: 'W' });
    await request(settling)
      .post('/webhooks/helius')
      .set('Authorization', WEBHOOK_SECRET)
      .send([
        {
          signature: 'settle-sig',
          timestamp: 1_787_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: VALID_ADDRESS, mint: 'M', tokenAmount: 1 }],
          nativeTransfers: [{ fromUserAccount: VALID_ADDRESS, toUserAccount: 'Pool', amount: 1_000_000_000 }],
        },
      ]);

    // Just written, so still inside the settle window.
    expect((await api(settling).get('/alerts?since=0')).body).toHaveLength(0);
    // The head is unaffected: it is about resuming, not about replaying.
    expect((await api(settling).get('/alerts/head')).body.id).toBeGreaterThan(0);
  });
});
