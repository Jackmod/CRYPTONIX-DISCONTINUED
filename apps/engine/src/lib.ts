/**
 * The engine's testable surface, for the tests/e2e workspace.
 *
 * index.ts cannot serve this purpose: importing it starts the real server,
 * connects to the real database and registers real Helius webhooks. This
 * barrel exposes the pieces an end-to-end test wires together itself.
 */
export { createServer, type EngineFeatures } from './api/server.js';
export { attachWebSocket } from './api/ws.js';
export { AlertBus, type AlertEvent } from './api/alert-bus.js';
export { WalletMonitor } from './monitors/wallet-monitor.js';
export { PnlTracker } from './monitors/pnl-tracker.js';
export { HeliusClient, type HeliusWebhook } from './helius/client.js';
export { WalletWebhook } from './helius/wallet-webhook.js';
export { RateLimiter } from './helius/rate-limiter.js';
export { isValidSolanaAddress } from './solana/address.js';
export { DexScreenerClient } from './coins/dexscreener.js';
export { CoinScanner, type NewCoinAlertPayload } from './monitors/coin-scanner.js';
export { SyndicationClient, SyndicationError } from './twitter/syndication.js';
export { TwitterApiIoSource, TweetSourceError } from './twitter/twitterapi-io.js';
export { isNewerTweetId, type TweetSource } from './twitter/source.js';
export { TweetMonitor, type TweetAlertPayload } from './monitors/tweet-monitor.js';
