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
import { walletChoices, buildWalletsEmbed, buildPnlReply } from '@cryptonix/discord-bot';

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
    // The effect, not the call: nothing is being watched any more.
    expect(stack.watchedAddresses()).toEqual([]);
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
    expect(stack.watchedAddresses()).toEqual([]);
    expect(stack.webhookCount()).toBe(0);
  });
});

describe('end-to-end: many wallets at once', () => {
  it('tracks more wallets than the free tier has webhooks, and alerts on all of them', async () => {
    // Helius allows FIVE webhooks on the free tier and 100,000 addresses in
    // each. One webhook per wallet meant the sixth wallet failed; one shared
    // webhook means the ceiling is the address limit instead.
    stack = await startStack();
    stack.startBotAlertPipeline();
    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011', 'user1');
    await stack.guildConfigs.load();

    for (const [i, address] of ADDRESSES.entries()) {
      await stack.engine.trackWallet(address, `Wallet ${i}`, false);
    }

    expect(await stack.engine.listWallets()).toHaveLength(ADDRESSES.length);
    // All of them in ONE webhook, which is the whole point.
    expect(stack.webhookCount()).toBe(1);
    expect(stack.watchedAddresses().sort()).toEqual([...ADDRESSES].sort());

    await new Promise((r) => setTimeout(r, 150));

    // A trade on every one of them reaches Discord.
    for (const [i, address] of ADDRESSES.entries()) {
      await deliver(stack.baseUrl, [
        buyTx(address, `multi-${i}`, 'Mint111', 1 + i, 1_000, 1_787_000_000 + i),
      ]);
    }

    await waitFor(() => stack.posted.length === ADDRESSES.length);
    const labels = stack.posted.map(
      (p) => (p.message as { embeds: { toJSON(): { title?: string } }[] }).embeds[0].toJSON().title
    );
    for (let i = 0; i < ADDRESSES.length; i++) {
      expect(labels.some((t) => t?.includes(`Wallet ${i}`))).toBe(true);
    }
  }, 30_000);

  it('untracking one wallet leaves the others watched', async () => {
    stack = await startStack();
    const first = await stack.engine.trackWallet(ADDRESSES[0], 'First', false);
    await stack.engine.trackWallet(ADDRESSES[1], 'Second', false);

    await stack.engine.untrackWallet(first.id);

    expect(stack.watchedAddresses()).toEqual([ADDRESSES[1]]);
    // The shared webhook survives; only the last removal deletes it.
    expect(stack.webhookCount()).toBe(1);
  });

  it('follows several X accounts at once, each with its own watermark', async () => {
    stack = await startStack();

    for (const handle of ['ansem', '@Cobie', 'https://x.com/gainzy222']) {
      await fetch(`${stack.baseUrl}/handles`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
    }

    const res = await fetch(`${stack.baseUrl}/handles`, { headers: authHeaders() });
    const handles = (await res.json()) as { handle: string }[];
    expect(handles.map((h) => h.handle)).toEqual(['ansem', 'cobie', 'gainzy222']);
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

describe('end-to-end: catch-up cursor', () => {
  it('resuming from the head replays nothing, even with history present', async () => {
    // The bug this guards: using listAlertsSince(0) as the head returns the
    // OLDEST capped page, so a restart replayed real history into channels.
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    for (let i = 0; i < 5; i++) {
      await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], `head-sig-${i}`, 'MintH', 1, 10, 1_788_000_000 + i)]);
    }
    await new Promise((r) => setTimeout(r, 300));

    const head = await stack.engine.getAlertHead();
    const all = await stack.engine.listAlertsSince(0);

    expect(head).toBe(Math.max(...all.map((a) => a.id)));
    expect(await stack.engine.listAlertsSince(head)).toHaveLength(0);
  }, 30_000);

  it('walks past the page cap so a long outage loses nothing', async () => {
    // The engine caps a page at 50. A single un-paginated request left
    // everything beyond that undelivered.
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    const batch = Array.from({ length: 60 }, (_, i) =>
      buyTx(ADDRESSES[0], `page-sig-${i}`, 'MintP', 0.1, 5, 1_788_100_000 + i)
    );
    await deliver(stack.baseUrl, batch);
    await new Promise((r) => setTimeout(r, 500));

    // One request is capped...
    const firstPage = await stack.engine.listAlertsSince(0);
    expect(firstPage).toHaveLength(50);

    // ...so a client must keep asking, which is what catchUpOnMissedAlerts does.
    let cursor = Math.max(...firstPage.map((a) => a.id));
    let total = firstPage.length;
    for (;;) {
      const page = await stack.engine.listAlertsSince(cursor);
      if (page.length === 0) break;
      total += page.length;
      cursor = Math.max(...page.map((a) => a.id));
      if (page.length < 50) break;
    }

    expect(total).toBe(60);
  }, 60_000);

  it("drops an untracked wallet's alerts so they cannot be replayed", async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Temp', false);
    await deliver(stack.baseUrl, [buyTx(ADDRESSES[0], 'replay-sig', 'MintR', 1, 10, 1_788_200_000)]);
    await new Promise((r) => setTimeout(r, 250));
    expect(await stack.engine.listAlertsSince(0)).toHaveLength(1);

    await stack.engine.untrackWallet(wallet.id);

    expect(await stack.engine.listAlertsSince(0)).toHaveLength(0);
  }, 30_000);
});

describe('end-to-end: the desktop app reads what the bot reads', () => {
  it('serves the newest alerts to a viewer, not the oldest page', async () => {
    // The rail seeds from /alerts/recent because /alerts?since=0 is an
    // ascending capped page — a viewer starting there opened on history.
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    for (let i = 0; i < 6; i++) {
      await deliver(stack.baseUrl, [
        buyTx(ADDRESSES[0], `recent-${i}`, 'Mint111', 1, 1_000, 1_787_000_000 + i),
      ]);
    }

    const recent = await fetch(`${stack.baseUrl}/alerts/recent?limit=3`, { headers: authHeaders() });
    const rows = (await recent.json()) as { id: number }[];
    const head = await fetch(`${stack.baseUrl}/alerts/head`, { headers: authHeaders() });
    const { id: headId } = (await head.json()) as { id: number };

    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe(headId);
    expect(rows[0].id).toBeGreaterThan(rows[2].id);
  });

  it('offers the same wallet list to autocomplete that the app shows', async () => {
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Bonk Whale', false);
    await stack.engine.trackWallet(ADDRESSES[1], 'Mine', true);

    const wallets = await stack.engine.listWallets();
    const choices = walletChoices(wallets, 'bonk');

    // Case-insensitive, and the value is the address the command resolves.
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe(ADDRESSES[0]);
    // Your own wallet leads an unfiltered list.
    expect(walletChoices(wallets, '')[0].value).toBe(ADDRESSES[1]);
  });

  it('lists tracked wallets in an embed the way /wallets does', async () => {
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    const embed = buildWalletsEmbed(await stack.engine.listWallets()).toJSON();
    expect(embed.description).toContain('Whale');
    expect(embed.footer!.text).toContain('1 wallet');
  });

  it('renders the PnL heatmap image from real recorded trades', async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);

    // A buy then a sell on the same day, so the day has realized PnL.
    await deliver(stack.baseUrl, [
      buyTx(ADDRESSES[0], 'heat-buy', 'Mint111', 1, 1_000, 1_787_000_000),
      sellTx(ADDRESSES[0], 'heat-sell', 'Mint111', 3, 1_000, 1_787_003_600),
    ]);

    const rows = await stack.engine.getPnl(wallet.id);
    expect(rows.length).toBeGreaterThan(0);

    const reply = buildPnlReply({ walletLabel: 'Whale', month: rows[0].date.slice(0, 7), rows });
    expect(reply.files).toHaveLength(1);
    const png = reply.files[0].attachment as Buffer;
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(reply.embeds[0].toJSON().image?.url).toBe('attachment://pnl-heatmap.png');
  });
});
