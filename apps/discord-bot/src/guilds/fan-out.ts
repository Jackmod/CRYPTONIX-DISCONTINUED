import type { AlertEvent } from '../engine/alert-stream.js';
import type { GuildConfigCache } from './config-cache.js';
import { buildWalletTradeMessage, isWalletAlertPayload } from '../embeds/wallet-buy.js';

export async function fanOutAlert(
  alert: AlertEvent,
  cache: Pick<GuildConfigCache, 'entries'>,
  sendToChannel: (channelId: string, message: unknown) => Promise<void>
): Promise<void> {
  // Phase 3 puts tweet and new-coin alerts on this same socket. Skip quietly
  // rather than rendering something this version does not understand.
  if (alert.type !== 'wallet_buy' && alert.type !== 'wallet_sell') return;
  if (!isWalletAlertPayload(alert.payload)) {
    console.error(`alert ${alert.refId} has an unexpected payload shape; skipping`);
    return;
  }

  const message = buildWalletTradeMessage(alert.payload);

  // Sequential and individually guarded: one server with revoked permissions
  // or a deleted channel must not cost every other server its alerts.
  for (const { guildId, alertChannelId } of cache.entries()) {
    try {
      await sendToChannel(alertChannelId, message);
    } catch (err) {
      console.error(`failed to post alert to guild ${guildId} channel ${alertChannelId}`, err);
    }
  }
}
