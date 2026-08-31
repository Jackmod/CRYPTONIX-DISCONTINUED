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

/** Discord rejects an embed title over 256 characters by throwing. */
const MAX_EMBED_TITLE = 256;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A link button throws unless the URL is a well-formed http(s) URL.
 *
 * The mint arrives from a webhook payload, so a malformed one would otherwise
 * make the whole alert unrenderable — and an alert that cannot be rendered is
 * an alert that can never be delivered, no matter how many times it is retried.
 */
function isUsableLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function buildWalletTradeMessage(payload: WalletAlertPayload) {
  const isBuy = payload.side === 'buy';

  const embed = new EmbedBuilder()
    .setColor(isBuy ? BUY_COLOR : SELL_COLOR)
    .setTitle(clamp(`${isBuy ? '🟢 Buy' : '🔴 Sell'} — ${payload.walletLabel}`, MAX_EMBED_TITLE))
    .addFields(
      { name: 'SOL', value: `${payload.solAmount.toFixed(4)} SOL`, inline: true },
      { name: 'Tokens', value: payload.tokenAmount.toLocaleString('en-US'), inline: true },
      { name: 'Mint', value: `\`${shortMint(payload.mint)}\``, inline: true }
    )
    .setTimestamp(new Date());

  // A button with an unusable URL throws; the alert is worth posting without
  // one, and losing the whole message over a link is not.
  if (!isUsableLink(payload.axiomLink)) {
    console.error(`alert for ${payload.mint} has an unusable Axiom link; posting without the button`);
    return { embeds: [embed], components: [] };
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open on Axiom').setURL(payload.axiomLink).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}
