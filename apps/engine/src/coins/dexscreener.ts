import type { CoinSnapshot } from '@cryptonix/core';
import { RateLimiter, type RateLimiterClock } from '../helius/rate-limiter.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

/**
 * Documented at 60 requests/minute on the profiles endpoint, and no
 * rate-limit headers are returned, so there is nothing to react to — the only
 * safe approach is not to exceed it. 30/minute leaves generous headroom for a
 * scanner that polls once a minute.
 */
const DEFAULT_REQUESTS_PER_MINUTE = 30;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 8_000;

export class DexScreenerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DexScreenerError';
  }
}

/** The subset of a DexScreener pair this scanner reads. */
interface DexPair {
  chainId?: string;
  pairCreatedAt?: number;
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  priceChange?: { m5?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
  fdv?: number;
}

export interface DexScreenerConfig {
  requestsPerMinute?: number;
  clock?: RateLimiterClock;
  /** Injectable so tests never reach the network. */
  fetchImpl?: typeof fetch;
}

/**
 * Reads new Solana tokens and their momentum from DexScreener.
 *
 * Chosen because it needs no account and no key, and supplies discovery and
 * momentum from one place — see the Phase 3 data-source spike. That matters:
 * spec §7 caps the project to free tiers, and the alternative (detecting pool
 * creation through Helius) would consume the same free-tier webhook address
 * budget that wallet tracking depends on.
 */
export class DexScreenerClient {
  private limiter: RateLimiter;
  private sleep: (ms: number) => Promise<void>;
  private fetchImpl: typeof fetch;

  constructor(config: DexScreenerConfig = {}) {
    const perMinute = config.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
    this.limiter = new RateLimiter(Math.ceil(60_000 / perMinute), config.clock);
    this.sleep = config.clock?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Rate limited on the way out, retried on 429 and 5xx on the way back.
   *
   * Every call here is a read, so retrying cannot duplicate anything — unlike
   * the Helius webhook create, which deliberately opts out of 5xx retries.
   */
  private async get(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const res = await this.fetchImpl(`${DEXSCREENER_BASE}${path}`);

      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        // Release the socket before throwing, exactly as the retry path below
        // does; an unread body holds its undici connection until GC.
        await res.body?.cancel().catch(() => {});
        throw new DexScreenerError(`DexScreener ${path} failed: ${res.status}`, res.status);
      }

      // Release the socket before waiting; an unread body holds it until GC.
      await res.body?.cancel().catch(() => {});
      const backoffMs = Math.min(2 ** attempt * 500, MAX_BACKOFF_MS);
      console.warn(`dexscreener ${res.status}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await this.sleep(backoffMs);
    }
  }

  /** Mints of recently profiled Solana tokens, newest first. */
  async listRecentSolanaMints(): Promise<string[]> {
    const body = await this.get('/token-profiles/latest/v1');
    if (!Array.isArray(body)) return [];

    return body
      .filter((entry): entry is { chainId: string; tokenAddress: string } => {
        const e = entry as { chainId?: unknown; tokenAddress?: unknown };
        return e.chainId === 'solana' && typeof e.tokenAddress === 'string';
      })
      .map((entry) => entry.tokenAddress);
  }

  /**
   * The token's most liquid pair as a normalised snapshot, or null when it has
   * no usable pair yet.
   */
  async getSnapshot(mint: string): Promise<CoinSnapshot | null> {
    const body = (await this.get(`/latest/dex/tokens/${encodeURIComponent(mint)}`)) as { pairs?: DexPair[] };

    // The endpoint returns pairs where the token is base OR quote. Only the
    // base ones describe THIS coin: taking the most liquid pair regardless
    // could return a pair whose base is something else entirely, which named
    // the wrong coin in the alert and filed the dedupe row under a mint the
    // next poll never looks up -- so the same alert republished every minute.
    const pairs = (body?.pairs ?? []).filter(
      (p) => p.chainId === 'solana' && p.baseToken?.address === mint
    );
    if (pairs.length === 0) return null;

    // Most liquid first, so a token listed on several DEXes is judged on the
    // pool that actually matters. Missing liquidity sorts last rather than
    // being treated as zero-and-therefore-worst.
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? -1) > (a.liquidity?.usd ?? -1) ? b : a));

    const address = best.baseToken?.address;
    if (typeof address !== 'string') return null;

    return {
      mint: address,
      symbol: best.baseToken?.symbol ?? 'unknown',
      ageMinutes: best.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 60_000 : Number.POSITIVE_INFINITY,
      // Explicitly null, not 0: the newest pairs often carry no figure, and
      // the momentum gate skips the liquidity check rather than failing it.
      liquidityUsd: typeof best.liquidity?.usd === 'number' ? best.liquidity.usd : null,
      volume5m: best.volume?.m5 ?? 0,
      volume1h: best.volume?.h1 ?? 0,
      priceChange5m: best.priceChange?.m5 ?? 0,
      buys5m: best.txns?.m5?.buys ?? 0,
      sells5m: best.txns?.m5?.sells ?? 0,
      fdvUsd: typeof best.fdv === 'number' ? best.fdv : null,
    };
  }
}
