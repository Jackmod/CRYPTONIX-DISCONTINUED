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
