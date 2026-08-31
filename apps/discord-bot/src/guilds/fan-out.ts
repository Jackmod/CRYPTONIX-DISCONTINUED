import type { AlertEvent } from '../engine/alert-stream.js';
import type { GuildConfigCache } from './config-cache.js';
import { buildWalletTradeMessage, isWalletAlertPayload } from '../embeds/wallet-buy.js';

export interface FanOutResult {
  /** Guilds that had a configured channel to try. */
  attempted: number;
  /** Guilds the message actually reached. */
  delivered: number;
}

export async function fanOutAlert(
  alert: AlertEvent,
  cache: Pick<GuildConfigCache, 'entries'>,
  sendToChannel: (channelId: string, message: unknown) => Promise<void>
): Promise<FanOutResult> {
  // Phase 3 puts tweet and new-coin alerts on this same socket. Skip quietly
  // rather than rendering something this version does not understand.
  if (alert.type !== 'wallet_buy' && alert.type !== 'wallet_sell') return { attempted: 0, delivered: 0 };
  if (!isWalletAlertPayload(alert.payload)) {
    console.error(`alert ${alert.refId} has an unexpected payload shape; skipping`);
    return { attempted: 0, delivered: 0 };
  }

  const message = buildWalletTradeMessage(alert.payload);

  // Sequential and individually guarded: one server with revoked permissions
  // or a deleted channel must not cost every other server its alerts.
  let attempted = 0;
  let delivered = 0;
  for (const { guildId, alertChannelId } of cache.entries()) {
    attempted++;
    try {
      await sendToChannel(alertChannelId, message);
      delivered++;
    } catch (err) {
      console.error(`failed to post alert to guild ${guildId} channel ${alertChannelId}`, err);
    }
  }

  // The counts matter to the caller: swallowing every send error and always
  // resolving let an alert that reached NO channel be marked delivered, and
  // the replay cursor then advanced past it for good.
  return { attempted, delivered };
}
