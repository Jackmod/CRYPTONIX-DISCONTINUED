import { describe, it, expect, afterEach } from 'vitest';
import {
  startStack,
  buyTx,
  sellTx,
  waitFor,
  authHeaders,
  ADDRESSES,
  WEBHOOK_SECRET,
  type E2EStack,
} from './harness.js';

let stack: E2EStack;

afterEach(async () => {
  await stack?.close();
  // Drop the reference so a test that never builds a stack does not inherit
  // the previous one and close it a second time.
  stack = undefined as unknown as E2EStack;
});

/** Posts a Helius delivery the way Helius itself would. */
async function deliver(baseUrl: string, transactions: unknown[]) {
  return fetch(`${baseUrl}/webhooks/helius`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: WEBHOOK_SECRET },
    body: JSON.stringify(transactions),
  });
}

describe('end-to-end: wallet trade reaches Discord', () => {
  it('carries a trade from Helius delivery all the way to a rendered embed', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();

    // A server runs /setup, which the bot stores through the engine.
    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011', 'user1');
    await stack.guildConfigs.load();

    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    expect(wallet.id).toBeGreaterThan(0);

    // Give the WebSocket a moment to connect before the alert fires.
    await new Promise((r) => setTimeout(r, 150));

    const res = await deliver(stack.baseUrl, [
      buyTx(ADDRESSES[0], 'e2e-sig-1', 'Mint111', 2.5, 1_250_000, 1_787_000_000),
    ]);
    expect(res.status).toBe(200);

    await waitFor(() => stack.posted.length === 1);

    const { channelId, message } = stack.posted[0];
    expect(channelId).toBe('900000000000000011');

    const payload = message as { embeds: { toJSON(): { title?: string } }[]; components: unknown[] };
    expect(payload.embeds[0].toJSON().title).toContain('Whale');
    expect(payload.components).toHaveLength(1);
  });

  it('fans one alert out to every configured server, each in its own channel', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();

    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011');
    await stack.engine.setGuildConfig('222222222222222222', '900000000000000012');
    await stack.engine.setGuildConfig('333333333333333333', '900000000000000013');
    await stack.guildConfigs.load();

    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    await new Promise((r) => setTimeout(r, 150));

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'fan-sig-1', 'Mint111', 1, 100, 1_787_000_100)]);

    await waitFor(() => stack.posted.length === 3);
    expect(stack.posted.map((p) => p.channelId).sort()).toEqual(['900000000000000011', '900000000000000012', '900000000000000013']);
  });

  it('delivers nothing to a server that has not run /setup', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();
    await stack.guildConfigs.load(); // no configs at all

    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    await new Promise((r) => setTimeout(r, 150));
    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'nosetup-sig', 'Mint111', 1, 100, 1_787_000_200)]);

    await new Promise((r) => setTimeout(r, 300));
    expect(stack.posted).toHaveLength(0);
  });

  it('moves alerts when a server re-runs /setup with a different channel', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();

    await stack.engine.setGuildConfig('111111111111111111', '900000000000000021');
    await stack.guildConfigs.load();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    await new Promise((r) => setTimeout(r, 150));

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'move-sig-1', 'Mint111', 1, 100, 1_787_000_300)]);
    await waitFor(() => stack.posted.length === 1);

    await stack.engine.setGuildConfig('111111111111111111', '900000000000000022');
    stack.guildConfigs.set('111111111111111111', '900000000000000022');

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'move-sig-2', 'Mint111', 1, 100, 1_787_000_400)]);
    await waitFor(() => stack.posted.length === 2);

    expect(stack.posted[0].channelId).toBe('900000000000000021');
    expect(stack.posted[1].channelId).toBe('900000000000000022');
  });
});

describe('end-to-end: PnL', () => {
  it('computes realized PnL across a buy and a sell delivered live', async () => {
    stack = await startStack();

    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Me', true);

    // Buy 1000 tokens for 2 SOL, later sell all 1000 for 5 SOL: +3 SOL.
    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'pnl-buy', 'MintP', 2, 1000, 1_787_000_000)]);
    await deliver(stack.baseUrl, [sellTx(ADDRESSES[0], 'pnl-sell', 'MintP', 5, 1000, 1_787_003_600)]);

    await new Promise((r) => setTimeout(r, 300));

    const rows = await stack.engine.getPnl(wallet.id);
    const total = rows.reduce((sum, row) => sum + row.realizedPnlSol, 0);
    expect(total).toBeCloseTo(3, 5);
  });

  it('serves a PnL view the desktop app and the bot would both read', async () => {
    // "Sync" is not a feature: both clients read the same rows through the
    // same route. This asserts that, rather than any syncing machinery.
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Me', true);

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'sync-buy', 'MintS', 1, 500, 1_787_000_000)]);
    await new Promise((r) => setTimeout(r, 250));

    const viaBotClient = await stack.engine.getPnl(wallet.id);
    const viaRawHttp = await fetch(`${stack.baseUrl}/wallets/${wallet.id}/pnl`, { headers: authHeaders() }).then(
      (r) => r.json()
    );

    expect(viaBotClient).toEqual(viaRawHttp);
  });
});

describe('end-to-end: wallet list is shared, not synced', () => {
  it('shows a wallet added over raw HTTP to the bot client immediately', async () => {
    stack = await startStack();

    // Stand-in for the Phase 4 desktop app: a plain authenticated POST.
    await fetch(`${stack.baseUrl}/wallets`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ address: ADDRESSES[1], label: 'FromApp', isMine: true }),
    });

    const viaBot = await stack.engine.listWallets();
    expect(viaBot.map((w) => w.label)).toContain('FromApp');
  });

  it('removes a wallet for every client at once, and releases its webhook', async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[2], 'Temp', false);

    await stack.engine.untrackWallet(wallet.id);

    expect(await stack.engine.listWallets()).toHaveLength(0);
    expect(stack.helius.deleteWalletWebhook).toHaveBeenCalledTimes(1);
  });

  it('does not leak a Helius webhook when a wallet with history is removed', async () => {
    // wallet_trades and pnl_daily hold foreign keys onto wallets.id, so this
    // is the path where a naive delete raises a constraint error and the
    // webhook is never released.
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[3], 'Busy', false);

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[3], 'hist-1', 'MintH', 1, 10, 1_787_000_000)]);
    await new Promise((r) => setTimeout(r, 250));

    await stack.engine.untrackWallet(wallet.id);

    expect(await stack.engine.listWallets()).toHaveLength(0);
    expect(stack.helius.deleteWalletWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('end-to-end: alerts missed while disconnected', () => {
  it('replays a trade that landed while the bot was not listening', async () => {
    // The socket only delivers what is published while it is open. A trade
    // landing during a restart or inside the reconnect backoff was recorded by
    // the engine and then never posted to Discord.
    stack = await startStack();
    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011');
    await stack.guildConfigs.load();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    // Nothing is listening yet: this alert is published to zero sockets.
    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'missed-sig', 'MintM', 1, 100, 1_787_900_000)]);
    await new Promise((r) => setTimeout(r, 200));
    expect(stack.posted).toHaveLength(0);

    // What a reconnecting bot does: ask for everything after what it last saw.
    const missed = await stack.engine.listAlertsSince(0);
    expect(missed).toHaveLength(1);
    expect(missed[0].id).toBeGreaterThan(0);
    expect(missed[0].type).toBe('wallet_buy');
  });

  it('does not re-deliver alerts a client has already seen', async () => {
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'seen-1', 'MintS', 1, 10, 1_787_910_000)]);
    await new Promise((r) => setTimeout(r, 150));

    const first = await stack.engine.listAlertsSince(0);
    expect(first).toHaveLength(1);

    // Resuming from the highest id already handled returns nothing new.
    expect(await stack.engine.listAlertsSince(first[0].id)).toHaveLength(0);

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'seen-2', 'MintS', 1, 10, 1_787_920_000)]);
    await new Promise((r) => setTimeout(r, 150));

    const second = await stack.engine.listAlertsSince(first[0].id);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBeGreaterThan(first[0].id);
  });

  it('carries the alert row id over the live socket too', async () => {
    // Catch-up resumes from this id, so it has to be present on the live path
    // as well as in the REST replay.
    stack = await startStack();
    stack.startBotAlertPipeline();
    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011');
    await stack.guildConfigs.load();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    await new Promise((r) => setTimeout(r, 200));

    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'live-id-sig', 'MintL', 1, 10, 1_787_930_000)]);
    await waitFor(() => stack.posted.length === 1);

    const viaRest = await stack.engine.listAlertsSince(0);
    expect(viaRest[0].id).toBeGreaterThan(0);
  });
});
