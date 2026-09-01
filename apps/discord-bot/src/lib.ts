/**
 * The bot's testable surface, for the tests/e2e workspace.
 *
 * index.ts cannot serve this purpose: importing it logs in to Discord.
 */
export { EngineClient, EngineError, type Wallet, type GuildConfig } from './engine/client.js';
export { AlertStream, type AlertEvent } from './engine/alert-stream.js';
export { GuildConfigCache } from './guilds/config-cache.js';
export { fanOutAlert } from './guilds/fan-out.js';
export { buildWalletTradeMessage, isWalletAlertPayload } from './embeds/wallet-buy.js';
export { buildPnlEmbed } from './embeds/pnl.js';
export { AlertReplay } from './alerts/replay.js';
