import { describe, it, expect, afterEach } from 'vitest';
import { startStack, buyTx, authHeaders, ADDRESSES, WEBHOOK_SECRET, API_KEY, waitFor, type E2EStack } from './harness.js';
import WebSocket from 'ws';

/** Resolves to 'open' or 'rejected' for a raw upgrade attempt. */
function tryConnect(url: string, headers?: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    let settled = false;
    const settle = (outcome: 'open' | 'rejected') => {
      if (settled) return;
      settled = true;
      // terminate() on a socket that never finished its handshake emits
      // "WebSocket was closed before the connection was established"
      // ASYNCHRONOUSLY, so try/catch cannot contain it. Leave a no-op 'error'
      // listener attached or Node rethrows it as an unhandled error.
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
      resolve(outcome);
    };
    // Keep a listener attached: an 'error' with none is rethrown by Node.
    socket.on('error', () => settle('rejected'));
    socket.on('open', () => settle('open'));
    socket.on('unexpected-response', () => settle('rejected'));
    setTimeout(() => settle('rejected'), 2_000);
  });
}

let stack: E2EStack;

afterEach(async () => {
  await stack?.close();
});

/** Every route that must never answer without the engine API key. */
const PROTECTED_ROUTES: [string, string][] = [
  ['GET', '/wallets'],
  ['POST', '/wallets'],
  ['GET', '/wallets/1/trades'],
  ['GET', '/wallets/1/pnl'],
  ['GET', '/wallets/1/balance'],
  ['DELETE', '/wallets/1'],
  ['GET', '/discord/guilds'],
  ['PUT', '/discord/guilds/111111111111111111'],
  ['DELETE', '/discord/guilds/111111111111111111'],
];

describe('authentication', () => {
  it('rejects every protected route with no credentials', async () => {
    stack = await startStack();

    for (const [method, path] of PROTECTED_ROUTES) {
      const res = await fetch(`${stack.baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' } });
      expect(res.status, `${method} ${path} must require auth`).toBe(401);
    }
  }, 30_000);

  it('rejects a wrong key, a blank Bearer, and a non-Bearer scheme', async () => {
    stack = await startStack();

    const badHeaders = [
      'Bearer wrong-key',
      'Bearer ',
      'Bearer',
      `Basic ${API_KEY}`,
      API_KEY, // raw, no scheme
      '',
    ];

    for (const header of badHeaders) {
      const res = await fetch(`${stack.baseUrl}/wallets`, { headers: { Authorization: header } });
      expect(res.status, `header "${header}" must not authenticate`).toBe(401);
    }
  }, 30_000);

  it('does not leak the API key or a stack trace in any error body', async () => {
    stack = await startStack();

    const bodies = await Promise.all([
      fetch(`${stack.baseUrl}/wallets`).then((r) => r.text()),
      fetch(`${stack.baseUrl}/wallets`, { headers: { Authorization: 'Bearer nope' } }).then((r) => r.text()),
      fetch(`${stack.baseUrl}/wallets/abc/trades`, { headers: authHeaders() }).then((r) => r.text()),
    ]);

    for (const body of bodies) {
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain(WEBHOOK_SECRET);
      expect(body.toLowerCase()).not.toContain('at object.');
      expect(body).not.toContain('node_modules');
    }
  }, 30_000);

  it('rejects a forged webhook delivery without the shared secret', async () => {
    // WEBHOOK_BASE_URL is public by design, so this endpoint is discoverable.
    // Unauthenticated, a forged SWAP would corrupt realized PnL permanently.
    stack = await startStack();
    await stack.engine.trackWallet(ADDRESSES[0], 'Victim', true);

    const forged = [buyTx(ADDRESSES[0], 'forged-sig', 'MintF', 999, 1, 1_787_000_000)];

    const noAuth = await fetch(`${stack.baseUrl}/webhooks/helius`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forged),
    });
    const wrongAuth = await fetch(`${stack.baseUrl}/webhooks/helius`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'not-the-secret' },
      body: JSON.stringify(forged),
    });

    expect(noAuth.status).toBe(401);
    expect(wrongAuth.status).toBe(401);

    const wallets = await stack.engine.listWallets();
    const trades = await fetch(`${stack.baseUrl}/wallets/${wallets[0].id}/trades`, { headers: authHeaders() }).then(
      (r) => r.json()
    );
    expect(trades).toHaveLength(0);
  }, 30_000);

  it('does not let the engine API key authenticate a webhook delivery', async () => {
    // The two secrets are for different callers and must not be
    // interchangeable: Helius never learns the engine key.
    stack = await startStack();

    const res = await fetch(`${stack.baseUrl}/webhooks/helius`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify([]),
    });

    expect(res.status).toBe(401);
  }, 30_000);
});

describe('input validation', () => {
  it('rejects injection-shaped wallet ids without a 500', async () => {
    stack = await startStack();

    const hostileIds = [
      "1' OR '1'='1",
      '1; DROP TABLE wallets;--',
      '../../etc/passwd',
      '%2e%2e%2f',
      '1e999',
      'NaN',
      '-1',
      '0',
      'null',
      '<script>alert(1)</script>',
    ];

    for (const id of hostileIds) {
      const res = await fetch(`${stack.baseUrl}/wallets/${encodeURIComponent(id)}/trades`, { headers: authHeaders() });
      expect(res.status, `id ${id} should be a clean 400`).toBe(400);
    }

    // The table is still there.
    expect(await stack.engine.listWallets()).toEqual([]);
  }, 30_000);

  it('rejects hostile guild ids without a 500', async () => {
    stack = await startStack();

    const hostileGuilds = ["1' OR '1'='1", '../../secret', 'not-a-snowflake', '1'.repeat(64), '', ' '];

    for (const guildId of hostileGuilds) {
      const res = await fetch(`${stack.baseUrl}/discord/guilds/${encodeURIComponent(guildId)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ alertChannelId: 'c1' }),
      });
      expect([400, 404]).toContain(res.status);
    }
  }, 30_000);

  it('survives malformed and hostile request bodies', async () => {
    stack = await startStack();

    const bodies = [
      '{ not json',
      '[]',
      'null',
      '"a string"',
      '12345',
      JSON.stringify({ address: null, label: null }),
      JSON.stringify({ address: { $ne: null }, label: 'x' }),
      JSON.stringify({ address: ADDRESSES[0], label: 'x', __proto__: { polluted: true } }),
    ];

    for (const body of bodies) {
      const res = await fetch(`${stack.baseUrl}/wallets`, { method: 'POST', headers: authHeaders(), body });
      expect(res.status, `body ${body.slice(0, 40)} must not 500`).toBeLessThan(500);
    }

    // Prototype pollution check: nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  }, 30_000);

  it('rejects an oversized body instead of crashing', async () => {
    stack = await startStack();

    const huge = JSON.stringify({ address: ADDRESSES[0], label: 'x'.repeat(5_000_000) });
    const res = await fetch(`${stack.baseUrl}/wallets`, { method: 'POST', headers: authHeaders(), body: huge });

    expect(res.status).toBeGreaterThanOrEqual(400);

    // Still alive afterwards.
    const after = await fetch(`${stack.baseUrl}/wallets`, { headers: authHeaders() });
    expect(after.status).toBe(200);
  }, 60_000);

  it('survives a webhook body that is not an array of transactions', async () => {
    stack = await startStack();

    const bodies = ['{}', 'null', '"x"', '[null]', '[{"signature":null}]', '[{"tokenTransfers":"nope"}]'];

    for (const body of bodies) {
      const res = await fetch(`${stack.baseUrl}/webhooks/helius`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: WEBHOOK_SECRET },
        body,
      });
      expect(res.status, `webhook body ${body} must not 500`).toBeLessThan(500);
    }

    const after = await fetch(`${stack.baseUrl}/wallets`, { headers: authHeaders() });
    expect(after.status).toBe(200);
  }, 30_000);

  it('rejects addresses that only look plausible', async () => {
    stack = await startStack();

    const bad = [
      '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', // Ethereum
      'So1111111111111111111111111111111111111110O', // base58-illegal chars
      'short',
      ' '.repeat(44),
      `${ADDRESSES[0]} `, // trailing null byte
      `${ADDRESSES[0]} `, // trailing space
    ];

    for (const address of bad) {
      const res = await fetch(`${stack.baseUrl}/wallets`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ address, label: 'X' }),
      });
      expect(res.status, `address "${address}" must be rejected`).toBe(400);
    }

    expect(stack.helius.createWalletWebhook).not.toHaveBeenCalled();
  }, 30_000);
});

describe('availability', () => {
  it('stays up through a burst of unauthenticated and malformed requests', async () => {
    stack = await startStack();

    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fetch(`${stack.baseUrl}/wallets/${i}/trades`, { headers: i % 2 ? {} : authHeaders() }).catch(() => null)
      )
    );

    const after = await fetch(`${stack.baseUrl}/wallets`, { headers: authHeaders() });
    expect(after.status).toBe(200);
  }, 60_000);
});

describe('alert socket', () => {
  it('refuses an unauthenticated WebSocket upgrade', async () => {
    // The socket carries every tracked wallet's trades the instant they
    // happen. On a publicly reachable engine an open socket hands the whole
    // signal feed to anyone who connects.
    stack = await startStack();

    expect(await tryConnect(stack.wsUrl)).toBe('rejected');
    expect(await tryConnect(stack.wsUrl, { Authorization: 'Bearer wrong-key' })).toBe('rejected');
    expect(await tryConnect(stack.wsUrl, { Authorization: API_KEY })).toBe('rejected');
  }, 30_000);

  it('accepts a correctly authenticated upgrade', async () => {
    stack = await startStack();

    expect(await tryConnect(stack.wsUrl, { Authorization: `Bearer ${API_KEY}` })).toBe('open');
  }, 30_000);

  it('does not deliver alerts to a rejected listener', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();
    await stack.engine.setGuildConfig('111111111111111111', 'channel-a');
    await stack.guildConfigs.load();

    const eavesdropped: string[] = [];
    const spy = new WebSocket(stack.wsUrl); // no credentials
    spy.on('message', (data) => eavesdropped.push(String(data)));
    spy.on('error', () => {});

    await stack.engine.trackWallet(ADDRESSES[0], 'Whale', false);
    await new Promise((r) => setTimeout(r, 200));
    await fetch(`${stack.baseUrl}/webhooks/helius`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: WEBHOOK_SECRET },
      body: JSON.stringify([buyTx(ADDRESSES[0], 'eaves-sig', 'MintE', 1, 10, 1_787_700_000)]),
    });

    // The legitimate bot still receives it...
    await waitFor(() => stack.posted.length === 1, 5_000);
    // ...and the eavesdropper received nothing.
    expect(eavesdropped).toHaveLength(0);
    // The 'error' listener above stays attached: terminate() on a refused
    // socket emits asynchronously, and with no listener Node rethrows.
    spy.terminate();
  }, 30_000);
});
