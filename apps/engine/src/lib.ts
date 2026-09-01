/**
 * The engine's testable surface, for the tests/e2e workspace.
 *
 * index.ts cannot serve this purpose: importing it starts the real server,
 * connects to the real database and registers real Helius webhooks. This
 * barrel exposes the pieces an end-to-end test wires together itself.
 */
export { createServer } from './api/server.js';
export { attachWebSocket } from './api/ws.js';
export { AlertBus, type AlertEvent } from './api/alert-bus.js';
export { WalletMonitor } from './monitors/wallet-monitor.js';
export { PnlTracker } from './monitors/pnl-tracker.js';
export { HeliusClient } from './helius/client.js';
export { RateLimiter } from './helius/rate-limiter.js';
export { isValidSolanaAddress } from './solana/address.js';
