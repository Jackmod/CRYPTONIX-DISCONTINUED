import type { AlertEvent } from '../engine/alert-stream.js';
import type { GuildConfigCache } from './config-cache.js';
import { buildWalletTradeMessage, isWalletAlertPayload } from '../embeds/wallet-buy.js';
import { buildNewCoinMessage, isNewCoinAlertPayload } from '../embeds/new-coin.js';

export interface FanOutResult {
  /** Guilds that had a configured channel to try. */
  attempted: number;
  /** Guilds the message actually reached. */
  delivered: number;
}

/** The Discord message for an alert, or null if this version cannot render it. */
function renderAlert(alert: AlertEvent): { embeds: unknown[]; components: unknown[] } | null {
  if (alert.type === 'wallet_buy' || alert.type === 'wallet_sell') {
    if (!isWalletAlertPayload(alert.payload)) {
      console.error(`alert ${alert.id} has an unexpected wallet payload shape; skipping`);
      return null;
    }
    return buildWalletTradeMessage(alert.payload);
  }

  if (alert.type === 'new_coin') {
    if (!isNewCoinAlertPayload(alert.payload)) {
      console.error(`alert ${alert.id} has an unexpected new-coin payload shape; skipping`);
      return null;
    }
    return buildNewCoinMessage(alert.payload);
  }

  return null;
}

export async function fanOutAlert(
  alert: AlertEvent,
  cache: Pick<GuildConfigCache, 'entries'>,
  sendToChannel: (channelId: string, message: unknown) => Promise<void>
): Promise<FanOutResult> {
  // One renderer per alert type. Anything unrecognised — a tweet alert, once
  // that half of Phase 3 lands — is skipped quietly rather than rendered as
  // something it is not.
  const message = renderAlert(alert);
  if (message === null) return { attempted: 0, delivered: 0 };

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
