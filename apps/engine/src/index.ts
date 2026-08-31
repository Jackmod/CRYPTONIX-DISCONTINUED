import { createDb } from '@cryptonix/db';
import { env } from './env.js';
import { HeliusClient } from './helius/client.js';
import { SolanaRpcClient } from './solana/balance.js';
import { AlertBus } from './api/alert-bus.js';
import { WalletMonitor } from './monitors/wallet-monitor.js';
import { PnlTracker } from './monitors/pnl-tracker.js';
import { createServer } from './api/server.js';
import { attachWebSocket } from './api/ws.js';

async function main() {
  const db = createDb(env.databaseUrl);
  const helius = new HeliusClient({
    apiKey: env.heliusApiKey,
    webhookBaseUrl: env.webhookBaseUrl,
    webhookSecret: env.webhookSecret,
  });
  const solanaRpc = new SolanaRpcClient(`https://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`);
  const alertBus = new AlertBus();
  const walletMonitor = new WalletMonitor(db, helius, alertBus);
  const pnlTracker = new PnlTracker(db, helius);

  const app = createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc, env.webhookSecret, env.apiKey);
  const server = app.listen(env.port, () => {
    console.log(`cryptonix engine listening on :${env.port}`);
  });

  // listen() reports failures (EADDRINUSE, EACCES) asynchronously via an
  // 'error' event, not as a rejection — so main()'s .catch() never sees them.
  // Without a listener here, Node rethrows and the process dies on a raw
  // stack trace instead of a readable message.
  server.on('error', (err) => {
    console.error(`engine failed to listen on :${env.port}`, err);
    process.exit(1);
  });

  // A websocket-layer failure must not take the whole engine down — wallet
  // monitoring and the REST API keep working without it (spec §9).
  const wss = attachWebSocket(server, alertBus, env.apiKey);
  wss.on('error', (err) => {
    console.error('websocket server error (alerts may be degraded)', err);
  });
}

main().catch((err) => {
  console.error('engine failed to start', err);
  process.exit(1);
});
