import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { AlertBus } from './alert-bus.js';

export function attachWebSocket(server: Server, alertBus: AlertBus): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

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
