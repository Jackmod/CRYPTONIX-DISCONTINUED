import { createDb } from '@cryptonix/db';
import { env } from './env.js';
import { HeliusClient } from './helius/client.js';
import { SolanaRpcClient } from './solana/balance.js';
import { AlertBus } from './api/alert-bus.js';
import { WalletMonitor } from './monitors/wallet-monitor.js';
import { PnlTracker } from './monitors/pnl-tracker.js';
import { createServer } from './api/server.js';
import { DexScreenerClient } from './coins/dexscreener.js';
import { CoinScanner } from './monitors/coin-scanner.js';
import { DEFAULT_MOMENTUM_THRESHOLDS } from '@cryptonix/core';
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

  // The coin scanner shares only the alert bus, so a failure in it cannot
  // affect wallet tracking (spec §9). Off by default.
  if (env.coinScannerEnabled) {
    const thresholds = { ...DEFAULT_MOMENTUM_THRESHOLDS };
    for (const [key, value] of Object.entries(env.coinThresholds)) {
      if (typeof value === 'number') (thresholds as Record<string, number>)[key] = value;
    }

    const scanner = new CoinScanner(db, new DexScreenerClient(), alertBus, { thresholds });
    console.log(`coin scanner enabled, polling every ${Math.round(env.coinScannerIntervalMs / 1000)}s`);
    console.log(`  thresholds: ${JSON.stringify(thresholds)}`);

    // A sweep is rate limited and can retry, so it may outlast the interval.
    // Without this guard two polls overlap, both read the same coin as
    // un-alerted, and both publish -- the duplicate scanned_coins exists to
    // prevent.
    let scanInProgress = false;
    const runScan = () => {
      if (scanInProgress) {
        console.warn('coin scanner: previous poll still running, skipping this tick');
        return;
      }
      scanInProgress = true;
      scanner
        .poll()
        .then((published) => {
          if (published > 0) console.log(`coin scanner: alerted ${published} new coin(s)`);
        })
        .catch((err) => console.error('coin scanner poll failed', err))
        .finally(() => {
          scanInProgress = false;
        });
    };
    runScan();
    const scanTimer = setInterval(runScan, env.coinScannerIntervalMs);
    scanTimer.unref?.();
  }

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
