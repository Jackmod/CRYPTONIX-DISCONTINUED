import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { attachWebSocket } from './ws';
import { AlertBus } from './alert-bus';

const API_KEY = 'test-engine-api-key';

describe('attachWebSocket', () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  /** Boots an http server with the alert socket attached, on an ephemeral port. */
  async function boot() {
    server = createServer();
    const alertBus = new AlertBus();
    const wss = attachWebSocket(server, alertBus, API_KEY);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('expected a bound port');
    return { wss, alertBus, url: `ws://localhost:${address.port}/ws` };
  }

  /** Resolves to whether the upgrade was accepted. */
  function connect(url: string, headers?: Record<string, string>): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new WebSocket(url, { headers });
      const settle = (accepted: boolean) => {
        client.removeAllListeners();
        // terminate() on a socket that never finished its handshake emits
        // "WebSocket was closed before the connection was established"
        // ASYNCHRONOUSLY. removeAllListeners just took the 'error' listener
        // away, so Node would rethrow it as an unhandled error and fail the
        // run. try/catch cannot help - the throw is not on this stack. Keep a
        // no-op listener attached instead.
        client.on('error', () => {});
        client.terminate();
        resolve(accepted);
      };
      client.on('open', () => settle(true));
      client.on('error', () => settle(false));
      client.on('unexpected-response', () => settle(false));
    });
  }

  it('attaches a per-client error handler so a malformed frame does not crash the process', async () => {
    // Regression guard: the `ws` library emits 'error' on the individual
    // client socket (not the server) for a protocol violation like a bad
    // frame or oversized payload. With no listener on that socket, Node
    // rethrows it as an uncaught exception and kills the whole engine over
    // one bad client. We simulate the malformed-frame case directly by
    // emitting 'error' on the server-side client socket, since crafting a
    // real protocol-violating frame over the wire is not worth the
    // complexity here.
    const { wss, url } = await boot();

    const client = new WebSocket(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    // grab the server-side socket for the connection we just opened
    const [serverSideSocket] = wss.clients;
    expect(serverSideSocket.listenerCount('error')).toBeGreaterThan(0);

    // If no listener were attached, this emit would throw synchronously
    // (Node's default behavior for an EventEmitter 'error' event with zero
    // listeners) instead of being caught and logged.
    expect(() => serverSideSocket.emit('error', new Error('simulated malformed frame'))).not.toThrow();

    client.close();
  });

  it('accepts an upgrade carrying the engine API key', async () => {
    const { url } = await boot();

    expect(await connect(url, { Authorization: `Bearer ${API_KEY}` })).toBe(true);
  });

  it('refuses an upgrade with no, wrong, or malformed credentials', async () => {
    // This socket streams every tracked wallet's trades the moment they
    // happen, and the engine has to be publicly reachable for Helius to
    // deliver webhooks. An open socket would hand the entire signal feed to
    // anyone who connected.
    const { url } = await boot();

    expect(await connect(url)).toBe(false);
    expect(await connect(url, { Authorization: `Bearer wrong-key` })).toBe(false);
    expect(await connect(url, { Authorization: API_KEY })).toBe(false); // no scheme
    expect(await connect(url, { Authorization: 'Bearer ' })).toBe(false);
  });

  it('does not deliver alerts to a connection it refused', async () => {
    const { alertBus, url } = await boot();

    const received: string[] = [];
    const spy = new WebSocket(url); // unauthenticated
    spy.on('message', (data) => received.push(String(data)));
    spy.on('error', () => {});

    await new Promise((resolve) => setTimeout(resolve, 150));
    alertBus.publish({ type: 'wallet_buy', refId: 1, payload: { secret: 'alpha' } });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(received).toHaveLength(0);
    // The 'error' listener above stays attached on purpose: terminate() on a
    // refused socket emits asynchronously, and with no listener Node rethrows.
    spy.terminate();
  });
});
