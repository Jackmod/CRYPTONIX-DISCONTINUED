import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { AlertBus } from './alert-bus.js';
import { isValidBearer } from './auth.js';

export function attachWebSocket(server: Server, alertBus: AlertBus, apiKey: string): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // The engine is publicly reachable so Helius can deliver webhooks, which
    // means this socket is too. Unauthenticated, anyone who connected would
    // receive the live trade feed of every tracked wallet — the entire signal
    // the product exists to produce. The REST middleware and this handler
    // share isValidBearer so the two cannot drift apart.
    verifyClient: ({ req }, done) => {
      if (isValidBearer(req.headers.authorization, apiKey)) {
        done(true);
        return;
      }

      // The browser WebSocket API cannot set request headers, so the desktop
      // app has no way to send Authorization on an upgrade. A query parameter
      // is the only option available to it.
      //
      // The trade-off is real and accepted deliberately: query strings are
      // more likely to be written to access logs than headers are. It is
      // bounded by the same key already guarding every REST route, the engine
      // is expected to sit behind a tunnel rather than on a public port, and
      // the alternative is a desktop app that cannot connect at all.
      // Compared in constant time, exactly like the header path.
      const url = new URL(req.url ?? '/', 'http://placeholder');
      const fromQuery = url.searchParams.get('apiKey');
      if (fromQuery !== null && isValidBearer(`Bearer ${fromQuery}`, apiKey)) {
        done(true);
        return;
      }

      done(false, 401, 'Unauthorized');
    },
  });

  wss.on('connection', (client) => {
    // A protocol-level error (bad frame, oversized payload) is emitted on the
    // individual client socket, not on the server. Unhandled, it is rethrown
    // and kills the process — one malformed frame would take down the whole
    // engine, so every client gets its own boundary.
    client.on('error', (err) => {
      console.error('websocket client error (dropping that client only)', err);
    });
  });

  alertBus.on('alert', (alert) => {
    const message = JSON.stringify(alert);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  });

  return wss;
}
