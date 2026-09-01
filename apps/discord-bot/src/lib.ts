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
export { buildPnlEmbed, buildPnlReply } from './embeds/pnl.js';
export { renderHeatmapImage, heatmapImageSize } from './embeds/heatmap-image.js';
export { AlertReplay } from './alerts/replay.js';
export { buildNewCoinMessage, isNewCoinAlertPayload } from './embeds/new-coin.js';
export { buildWalletsEmbed } from './commands/wallets.js';
export { walletChoices, displayLabel } from './commands/types.js';
export { buildTweetMessage, isTweetAlertPayload } from './embeds/tweet.js';
export { buildFollowingEmbed } from './commands/following.js';
export { statusCommand } from './commands/status.js';
