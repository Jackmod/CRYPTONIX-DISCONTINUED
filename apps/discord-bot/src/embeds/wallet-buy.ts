import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

/** Field-for-field the object apps/engine/src/monitors/wallet-monitor.ts stores in alerts.payload. */
export interface WalletAlertPayload {
  walletId: number;
  walletLabel: string;
  mint: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
  axiomLink: string;
}

const BUY_COLOR = 0x22c55e;
const SELL_COLOR = 0xef4444;

/**
 * Payloads arrive as `unknown` off a JSON socket, and Phase 3 will put tweet
 * and new-coin alerts on that same socket. Anything that is not a wallet trade
 * gets declined here rather than rendered into a live channel.
 */
export function isWalletAlertPayload(value: unknown): value is WalletAlertPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<WalletAlertPayload>;
  return (
    typeof p.walletLabel === 'string' &&
    typeof p.mint === 'string' &&
    (p.side === 'buy' || p.side === 'sell') &&
    typeof p.solAmount === 'number' &&
    typeof p.tokenAmount === 'number' &&
    typeof p.axiomLink === 'string'
  );
}

function shortMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

export function buildWalletTradeMessage(payload: WalletAlertPayload) {
  const isBuy = payload.side === 'buy';

  const embed = new EmbedBuilder()
    .setColor(isBuy ? BUY_COLOR : SELL_COLOR)
    .setTitle(`${isBuy ? '🟢 Buy' : '🔴 Sell'} — ${payload.walletLabel}`)
    .addFields(
      { name: 'SOL', value: `${payload.solAmount.toFixed(4)} SOL`, inline: true },
      { name: 'Tokens', value: payload.tokenAmount.toLocaleString('en-US'), inline: true },
      { name: 'Mint', value: `\`${shortMint(payload.mint)}\``, inline: true }
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open on Axiom').setURL(payload.axiomLink).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}
