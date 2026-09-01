import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

/** Field-for-field what apps/engine's CoinScanner stores in alerts.payload. */
export interface NewCoinAlertPayload {
  mint: string;
  symbol: string;
  momentumScore: number;
  ageMinutes: number;
  volume5m: number;
  priceChange5m: number;
  buys5m: number;
  sells5m: number;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  /** The token's real on-chain logo, when the provider has one. */
  imageUrl?: string | null;
  axiomLink: string;
}

const STRONG_COLOR = 0x22c55e;
const MODERATE_COLOR = 0xeab308;

/**
 * Payloads arrive as `unknown` off a JSON socket, and wallet trades share that
 * socket. Anything that is not a new-coin alert is declined here rather than
 * rendered into a live channel.
 */
export function isNewCoinAlertPayload(value: unknown): value is NewCoinAlertPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<NewCoinAlertPayload>;
  return (
    typeof p.mint === 'string' &&
    typeof p.symbol === 'string' &&
    typeof p.momentumScore === 'number' &&
    typeof p.ageMinutes === 'number' &&
    typeof p.volume5m === 'number' &&
    typeof p.priceChange5m === 'number' &&
    typeof p.buys5m === 'number' &&
    typeof p.sells5m === 'number' &&
    typeof p.axiomLink === 'string' &&
    // The nullable fields need checking too. An ABSENT liquidityUsd (rather
    // than an explicitly null one) passed the guard, failed the `=== null`
    // test in the renderer, and printed "$NaN" into a live channel.
    isNumberOrNull(p.liquidityUsd) &&
    isNumberOrNull(p.fdvUsd) &&
    // Optional: alerts published before the scanner carried a logo have no
    // such field at all, and those must keep rendering.
    (p.imageUrl === undefined || p.imageUrl === null || typeof p.imageUrl === 'string')
  );
}

function isNumberOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/** Discord rejects an embed title over 256 characters by throwing. */
const MAX_EMBED_TITLE = 256;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function shortMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

/**
 * A link button throws unless the URL is a well-formed http(s) URL. The mint
 * comes from a third-party feed, so a malformed one must cost the button, not
 * the whole alert — an alert that cannot be rendered can never be delivered.
 */
function isUsableLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function buildNewCoinMessage(payload: NewCoinAlertPayload) {
  const total = payload.buys5m + payload.sells5m;
  const buyShare = total === 0 ? 0 : Math.round((payload.buys5m / total) * 100);

  const embed = new EmbedBuilder()
    .setColor(payload.momentumScore >= 60 ? STRONG_COLOR : MODERATE_COLOR)
    .setTitle(clamp(`🚀 New coin — ${payload.symbol}`, MAX_EMBED_TITLE))
    .addFields(
      { name: 'Momentum', value: `${payload.momentumScore}/100`, inline: true },
      { name: 'Age', value: `${payload.ageMinutes}m`, inline: true },
      { name: '5m change', value: `${payload.priceChange5m > 0 ? '+' : ''}${payload.priceChange5m.toFixed(1)}%`, inline: true },
      { name: '5m volume', value: usd(payload.volume5m), inline: true },
      { name: '5m trades', value: `${payload.buys5m}B / ${payload.sells5m}S · ${buyShare}% buys`, inline: true },
      {
        name: 'Liquidity',
        // Null is normal on the newest pairs, and saying so is more honest
        // than printing $0 — which would read as "no liquidity".
        value: payload.liquidityUsd === null ? 'not reported yet' : usd(payload.liquidityUsd),
        inline: true,
      },
      { name: 'Mint', value: `\`${shortMint(payload.mint)}\``, inline: false }
    )
    .setFooter({ text: 'Momentum is a heuristic, not advice. Always check the chart yourself.' })
    .setTimestamp(new Date());

  // The token's real logo, the way the desktop app shows it. Guarded because
  // a thumbnail URL Discord cannot parse throws and would cost the whole
  // alert — and the URL comes from a third-party feed.
  if (typeof payload.imageUrl === 'string' && isUsableLink(payload.imageUrl)) {
    embed.setThumbnail(payload.imageUrl);
  }

  if (!isUsableLink(payload.axiomLink)) {
    console.error(`new-coin alert for ${payload.mint} has an unusable Axiom link; posting without the button`);
    return { embeds: [embed], components: [] };
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open on Axiom').setURL(payload.axiomLink).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}
