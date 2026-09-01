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
import { TwitterApiIoSource } from './twitter/twitterapi-io.js';
import { TweetMonitor } from './monitors/tweet-monitor.js';

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

  /*
   * The tweet monitor, on the same terms as the coin scanner: it shares only
   * the alert bus, so a provider outage, an expired key or an empty balance
   * stops tweets and cannot touch wallet monitoring (spec §9).
   *
   * Silent without a key rather than broken. Everything else about the feature
   * still works — the Calls tab lists tracked handles, stored tweets render,
   * and the Discord embed builds — because only DISCOVERY needs paying for.
   */
  if (env.twitterApiKey) {
    const source = new TwitterApiIoSource({ apiKey: env.twitterApiKey });
    const tweetMonitor = new TweetMonitor(db, source, alertBus);
    console.log(
      `tweet monitor enabled via ${source.name}, polling every ${Math.round(env.tweetPollIntervalMs / 1000)}s`
    );

    // Same guard as the coin scanner: a sweep is rate limited and can outlast
    // the interval, and two overlapping polls would both read the same
    // watermark and publish the same tweets.
    let pollInProgress = false;
    const runPoll = () => {
      if (pollInProgress) {
        console.warn('tweet monitor: previous poll still running, skipping this tick');
        return;
      }
      pollInProgress = true;
      tweetMonitor
        .poll()
        .then((published) => {
          if (published > 0) console.log(`tweet monitor: alerted ${published} new tweet(s)`);
        })
        .catch((err) => console.error('tweet monitor poll failed', err))
        .finally(() => {
          pollInProgress = false;
        });
    };
    runPoll();
    const tweetTimer = setInterval(runPoll, env.tweetPollIntervalMs);
    tweetTimer.unref?.();
  } else {
    console.log('tweet monitor disabled: set TWITTER_API_KEY to follow X accounts');
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
