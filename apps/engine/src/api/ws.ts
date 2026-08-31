import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { AlertBus } from './alert-bus.js';

export function attachWebSocket(server: Server, alertBus: AlertBus): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  alertBus.on('alert', (alert) => {
    const message = JSON.stringify(alert);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  });

  return wss;
}
