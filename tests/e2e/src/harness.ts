import { createServer as createEngineApp, attachWebSocket, AlertBus, WalletMonitor, PnlTracker } from '@cryptonix/engine';
import { createDb } from '@cryptonix/db';
import { AlertStream, EngineClient, GuildConfigCache, fanOutAlert } from '@cryptonix/discord-bot';
import type { Server } from 'node:http';
import { vi } from 'vitest';

// Its own database: turbo runs the engine, db and e2e test tasks in parallel,
// and all three TRUNCATE the same table names.
export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL_E2E ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test_e2e';
export const WEBHOOK_SECRET = 'e2e-webhook-secret';
export const API_KEY = 'e2e-engine-api-key';

/** Genuine mainnet pubkeys — POST /wallets rejects anything that is not one. */
export const ADDRESSES = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
];

export interface E2EStack {
  baseUrl: string;
  wsUrl: string;
  engine: EngineClient;
  db: ReturnType<typeof createDb>;
  alertBus: AlertBus;
  helius: {
    createWalletWebhook: ReturnType<typeof vi.fn>;
    deleteWalletWebhook: ReturnType<typeof vi.fn>;
    getTransactionHistory: ReturnType<typeof vi.fn>;
  };
  /** Every message the fake Discord layer was asked to post. */
  posted: { channelId: string; message: unknown }[];
  guildConfigs: GuildConfigCache;
  /** Wires a live AlertStream to fan-out, exactly as the bot's index.ts does. */
  startBotAlertPipeline(): AlertStream;
  close(): Promise<void>;
}

/**
 * Boots a real engine — real Express, real WebSocket server, real Postgres —
 * on an ephemeral port, and wires the real bot-side alert pipeline to it.
 *
 * Only two things are faked, and only because they are third parties we must
 * not call from a test: Helius, and the final Discord `send`. Everything
 * between them is the production code path.
 */
export async function startStack(): Promise<E2EStack> {
  const db = createDb(TEST_DB_URL);
  await db.execute(
    'TRUNCATE alerts, pnl_daily, wallet_trades, wallets, discord_guilds RESTART IDENTITY CASCADE'
  );

  const helius = {
    createWalletWebhook: vi.fn(async () => `wh_${Math.random().toString(36).slice(2)}`),
    deleteWalletWebhook: vi.fn(async () => undefined),
    getTransactionHistory: vi.fn(async () => []),
  };

  const alertBus = new AlertBus();
  const walletMonitor = new WalletMonitor(db, helius as never, alertBus);
  const pnlTracker = new PnlTracker(db, helius as never);
  const solanaRpc = { getBalanceSol: vi.fn(async () => 1.5) };

  const app = createEngineApp(db, walletMonitor, pnlTracker, alertBus, solanaRpc, WEBHOOK_SECRET, API_KEY);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const wss = attachWebSocket(server, alertBus, API_KEY);

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const engine = new EngineClient(baseUrl, API_KEY);
  const guildConfigs = new GuildConfigCache(engine);
  const posted: { channelId: string; message: unknown }[] = [];
  const streams: AlertStream[] = [];
  // A test file's afterEach may call close() on a stack a later test never
  // replaced, and pg throws "Called end on pool more than once".
  let closed = false;

  function startBotAlertPipeline(): AlertStream {
    const stream = new AlertStream({ url: wsUrl, apiKey: API_KEY, initialDelayMs: 20, maxDelayMs: 50 });
    stream.onAlert((alert) => {
      void fanOutAlert(alert, guildConfigs, async (channelId, message) => {
        posted.push({ channelId, message });
      });
    });
    stream.start();
    streams.push(stream);
    return stream;
  }

  return {
    baseUrl,
    wsUrl,
    engine,
    db,
    alertBus,
    helius,
    posted,
    guildConfigs,
    startBotAlertPipeline,
    async close() {
      if (closed) return;
      closed = true;
      for (const stream of streams) stream.stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // createDb opens a pg.Pool per stack. Every `it` builds a stack, so
      // without this each one leaks a pool: the vitest worker accumulates open
      // handles and a long run can exhaust Postgres connections.
      await (db as unknown as { $client?: { end(): Promise<void> } }).$client?.end();
    },
  };
}

/** A Helius enhanced-transaction fixture representing a buy of `mint` for SOL. */
export function buyTx(address: string, signature: string, mint: string, sol: number, tokens: number, tsSeconds: number) {
  return {
    signature,
    timestamp: tsSeconds,
    type: 'SWAP',
    tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: address, mint, tokenAmount: tokens }],
    nativeTransfers: [{ fromUserAccount: address, toUserAccount: 'Pool', amount: Math.round(sol * 1_000_000_000) }],
  };
}

/** The mirror image: selling `tokens` of `mint` back for SOL. */
export function sellTx(address: string, signature: string, mint: string, sol: number, tokens: number, tsSeconds: number) {
  return {
    signature,
    timestamp: tsSeconds,
    type: 'SWAP',
    tokenTransfers: [{ fromUserAccount: address, toUserAccount: 'Pool', mint, tokenAmount: tokens }],
    nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: address, amount: Math.round(sol * 1_000_000_000) }],
  };
}

/** Polls until `predicate` holds or the budget runs out. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for condition`);
}

export function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...extra };
}
