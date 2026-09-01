/** One entry in the live rail, already normalised for rendering. */
export interface FeedItem {
  id: number;
  kind: 'buy' | 'sell' | 'coin' | 'tweet' | 'other';
  /** The headline: a wallet label, or a coin symbol. */
  what: string;
  detail: string;
  imageUrl: string | null;
  /** Present when the entry links somewhere useful, e.g. Axiom. */
  link: string | null;
  at: Date;
}

export type ConnectionState = 'live' | 'connecting' | 'down';

interface WalletPayload {
  walletLabel?: unknown;
  mint?: unknown;
  side?: unknown;
  solAmount?: unknown;
  tokenAmount?: unknown;
  axiomLink?: unknown;
}

interface TweetPayload {
  authorHandle?: unknown;
  authorName?: unknown;
  authorAvatarUrl?: unknown;
  text?: unknown;
  url?: unknown;
}

interface CoinPayload {
  symbol?: unknown;
  mint?: unknown;
  momentumScore?: unknown;
  volume5m?: unknown;
  priceChange5m?: unknown;
  imageUrl?: unknown;
  axiomLink?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shortMint(mint: string): string {
  return mint.length <= 10 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** Whitespace flattened, so one entry cannot take five lines of the rail. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function compactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

/**
 * Turns a raw alert into a rail entry, or null when this build cannot render
 * it.
 *
 * Returning null rather than a placeholder matters: the tweet alerts from the
 * other half of Phase 3 will arrive on this same socket, and a row reading
 * "undefined" is worse than no row at all.
 */
export function toFeedItem(alert: { id: number; type: string; payload: unknown; ts?: string }): FeedItem | null {
  // An unparseable timestamp must not reach the renderer: `Invalid Date`
  // throws from toISOString(), which would take the whole rail down over one
  // bad row.
  const parsed = alert.ts ? new Date(alert.ts) : new Date();
  const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  if (!isRecord(alert.payload)) return null;

  if (alert.type === 'wallet_buy' || alert.type === 'wallet_sell') {
    const p = alert.payload as WalletPayload;
    if (typeof p.walletLabel !== 'string' || typeof p.mint !== 'string') return null;
    const sol = typeof p.solAmount === 'number' ? p.solAmount : 0;
    return {
      id: alert.id,
      kind: alert.type === 'wallet_buy' ? 'buy' : 'sell',
      what: p.walletLabel,
      detail: `${sol.toFixed(2)} SOL · ${shortMint(p.mint)}`,
      // A raw Solana address has no inherent picture (spec §5.3), so wallet
      // rows get a generated identicon rather than a photo — rendered by the
      // component, not fetched.
      imageUrl: null,
      link: typeof p.axiomLink === 'string' ? p.axiomLink : null,
      at,
    };
  }

  if (alert.type === 'tweet') {
    const p = alert.payload as TweetPayload;
    if (typeof p.authorHandle !== 'string' || typeof p.text !== 'string') return null;
    return {
      id: alert.id,
      kind: 'tweet',
      what: `@${p.authorHandle}`,
      // Collapsed to one line: the rail is a ticker, and a tweet's own line
      // breaks would give one entry the height of five.
      detail: oneLine(p.text),
      // The author's real avatar (spec §5.3), when the alert carried one.
      imageUrl: typeof p.authorAvatarUrl === 'string' ? p.authorAvatarUrl : null,
      link: typeof p.url === 'string' ? p.url : null,
      at,
    };
  }

  if (alert.type === 'new_coin') {
    const p = alert.payload as CoinPayload;
    if (typeof p.symbol !== 'string' || typeof p.mint !== 'string') return null;
    const score = typeof p.momentumScore === 'number' ? p.momentumScore : 0;
    const vol = typeof p.volume5m === 'number' ? p.volume5m : 0;
    const chg = typeof p.priceChange5m === 'number' ? p.priceChange5m : 0;
    return {
      id: alert.id,
      kind: 'coin',
      what: p.symbol,
      detail: `${score}/100 · ${compactUsd(vol)} 5m · ${chg > 0 ? '+' : ''}${chg.toFixed(0)}%`,
      imageUrl: typeof p.imageUrl === 'string' ? p.imageUrl : null,
      link: typeof p.axiomLink === 'string' ? p.axiomLink : null,
      at,
    };
  }

  return null;
}

/** Newest first, capped — the rail is a ticker, not an archive. */
export function mergeFeed(existing: FeedItem[], incoming: FeedItem[], cap = 200): FeedItem[] {
  const byId = new Map<number, FeedItem>();
  for (const item of [...existing, ...incoming]) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, cap);
}
