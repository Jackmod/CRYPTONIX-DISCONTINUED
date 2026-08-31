import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import WebSocket from 'ws';
import { attachWebSocket } from './ws';
import { AlertBus } from './alert-bus';

describe('attachWebSocket', () => {
  let server: Server;

  afterEach(() => {
    server?.close();
  });

  it('attaches a per-client error handler so a malformed frame does not crash the process', async () => {
    // Regression guard: the `ws` library emits 'error' on the individual
    // client socket (not the server) for a protocol violation like a bad
    // frame or oversized payload. With no listener on that socket, Node
    // rethrows it as an uncaught exception and kills the whole engine over
    // one bad client. /ws is public and unauthenticated, so this is reachable
    // by anyone. We simulate the malformed-frame case directly by emitting
    // 'error' on the server-side client socket, since crafting a real
    // protocol-violating frame over the wire is not worth the complexity here.
    server = createServer();
    const wss = attachWebSocket(server, new AlertBus());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('expected a bound port');
    const port = address.port;

    const client = new WebSocket(`ws://localhost:${port}/ws`);
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
});
