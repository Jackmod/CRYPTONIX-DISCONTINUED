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
  const helius = new HeliusClient({ apiKey: env.heliusApiKey, webhookBaseUrl: env.webhookBaseUrl });
  const solanaRpc = new SolanaRpcClient(`https://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`);
  const alertBus = new AlertBus();
  const walletMonitor = new WalletMonitor(db, helius, alertBus);
  const pnlTracker = new PnlTracker(db, helius);

  const app = createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc);
  const server = app.listen(env.port, () => {
    console.log(`cryptonix engine listening on :${env.port}`);
  });
  attachWebSocket(server, alertBus);
}

main().catch((err) => {
  console.error('engine failed to start', err);
  process.exit(1);
});
