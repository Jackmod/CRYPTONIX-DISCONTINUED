import { describe, it, expect, afterEach } from 'vitest';
import { startStack, buyTx, sellTx, waitFor, authHeaders, ADDRESSES, WEBHOOK_SECRET, type E2EStack } from './harness.js';
import { RateLimiter } from '@cryptonix/engine';

let stack: E2EStack;

afterEach(async () => {
  await stack?.close();
  // Drop the reference so a test that never builds a stack does not inherit
  // the previous one and close it a second time.
  stack = undefined as unknown as E2EStack;
});

async function deliver(baseUrl: string, transactions: unknown[]) {
  return fetch(`${baseUrl}/webhooks/helius`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: WEBHOOK_SECRET },
    body: JSON.stringify(transactions),
  });
}

describe('stress: sustained delivery', () => {
  it('records 200 trades delivered in one batch without loss', async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Busy', false);

    const batch = Array.from({ length: 200 }, (_, i) =>
      buyTx(ADDRESSES[0], `stress-sig-${i}`, `Mint${i % 7}`, 0.1, 100, 1_787_000_000 + i)
    );

    const res = await deliver(stack.baseUrl, batch);
    expect(res.status).toBe(200);

    const trades = await fetch(`${stack.baseUrl}/wallets/${wallet.id}/trades`, { headers: authHeaders() }).then((r) =>
      r.json()
    );
    expect(trades).toHaveLength(200);
  }, 60_000);

  it('handles 30 concurrent deliveries without dropping or duplicating a trade', async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Busy', false);

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        deliver(stack.baseUrl, [buyTx(ADDRESSES[0], `conc-sig-${i}`, 'MintC', 0.5, 50, 1_787_100_000 + i)])
      )
    );

    const trades: { signature: string }[] = await fetch(`${stack.baseUrl}/wallets/${wallet.id}/trades`, {
      headers: authHeaders(),
    }).then((r) => r.json());

    expect(trades).toHaveLength(30);
    expect(new Set(trades.map((t) => t.signature)).size).toBe(30);
  }, 60_000);

  it('deduplicates a batch Helius redelivers', async () => {
    // Helius retries a batch it did not see a 2xx for. The unique index on
    // (wallet_id, signature) is what stops a retry from double-counting PnL.
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Busy', false);

    const batch = [buyTx(ADDRESSES[0], 'dup-sig', 'MintD', 1, 100, 1_787_200_000)];
    await deliver(stack.baseUrl, batch);
    await deliver(stack.baseUrl, batch);
    await deliver(stack.baseUrl, batch);

    const trades = await fetch(`${stack.baseUrl}/wallets/${wallet.id}/trades`, { headers: authHeaders() }).then((r) =>
      r.json()
    );
    expect(trades).toHaveLength(1);
  }, 30_000);

  it('does not double-count PnL when a redelivery arrives', async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Me', true);

    const buy = [buyTx(ADDRESSES[0], 'pnl-dup-buy', 'MintX', 2, 1000, 1_787_000_000)];
    const sell = [sellTx(ADDRESSES[0], 'pnl-dup-sell', 'MintX', 5, 1000, 1_787_003_600)];
    await deliver(stack.baseUrl, buy);
    await deliver(stack.baseUrl, sell);
    await deliver(stack.baseUrl, buy); // duplicate
    await deliver(stack.baseUrl, sell); // duplicate

    await new Promise((r) => setTimeout(r, 400));

    const rows = await stack.engine.getPnl(wallet.id);
    const total = rows.reduce((sum, row) => sum + row.realizedPnlSol, 0);
    expect(total).toBeCloseTo(3, 5); // not 6
  }, 30_000);

  it('keeps serving reads while deliveries are in flight', async () => {
    stack = await startStack();
    const wallet = await stack.engine.trackWallet(ADDRESSES[0], 'Busy', false);

    const writes = Array.from({ length: 20 }, (_, i) =>
      deliver(stack.baseUrl, [buyTx(ADDRESSES[0], `mixed-sig-${i}`, 'MintM', 0.2, 20, 1_787_300_000 + i)])
    );
    const reads = Array.from({ length: 20 }, () =>
      fetch(`${stack.baseUrl}/wallets/${wallet.id}/pnl`, { headers: authHeaders() })
    );

    const results = await Promise.all([...writes, ...reads]);
    expect(results.every((r) => r.status < 500)).toBe(true);
  }, 60_000);

  it('fans a burst of alerts out to several servers without losing any', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();

    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011');
    await stack.engine.setGuildConfig('222222222222222222', '900000000000000012');
    await stack.guildConfigs.load();

    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    await new Promise((r) => setTimeout(r, 200));

    const batch = Array.from({ length: 25 }, (_, i) =>
      buyTx(ADDRESSES[0], `burst-sig-${i}`, 'MintB', 0.3, 30, 1_787_400_000 + i)
    );
    await deliver(stack.baseUrl, batch);

    // 25 trades x 2 configured servers.
    await waitFor(() => stack.posted.length === 50, 15_000);
    expect(stack.posted.filter((p) => p.channelId === '900000000000000011')).toHaveLength(25);
    expect(stack.posted.filter((p) => p.channelId === '900000000000000012')).toHaveLength(25);
  }, 60_000);
});

describe('stress: many wallets', () => {
  it('tracks several wallets and keeps their trades separate', async () => {
    stack = await startStack();

    const wallets = [];
    for (const [i, address] of ADDRESSES.slice(0, 4).entries()) {
      wallets.push(await stack.engine.trackWallet(address, `W${i}`, false));
    }

    for (const [i, address] of ADDRESSES.slice(0, 4).entries()) {
      await deliver(stack.baseUrl, [
        buyTx(address, `multi-${i}-a`, 'MintZ', 1, 10, 1_787_500_000),
        buyTx(address, `multi-${i}-b`, 'MintZ', 1, 10, 1_787_500_100),
      ]);
    }

    for (const wallet of wallets) {
      const trades = await fetch(`${stack.baseUrl}/wallets/${wallet.id}/trades`, { headers: authHeaders() }).then((r) =>
        r.json()
      );
      expect(trades).toHaveLength(2);
    }
  }, 60_000);

  it('ignores a delivery for an address nobody tracks', async () => {
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Tracked', false);

    const res = await deliver(stack.baseUrl, [buyTx(ADDRESSES[4], 'untracked-sig', 'MintU', 1, 10, 1_787_600_000)]);

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(stack.posted).toHaveLength(0);
  }, 30_000);
});

describe('rate limiting under load', () => {
  it('keeps a burst of 50 acquisitions within the configured budget', async () => {
    // 8 requests/second is what HeliusClient configures; 50 calls must
    // therefore span at least ~6.1s of scheduled time. Asserting on the
    // schedule rather than real elapsed time keeps this fast and stable.
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(125, {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    await Promise.all(Array.from({ length: 50 }, () => limiter.acquire()));

    expect(Math.max(...sleeps)).toBe(125 * 49);
  });
});
