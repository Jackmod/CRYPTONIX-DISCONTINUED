import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import { RateLimiter, type RateLimiterClock } from './rate-limiter.js';

const HELIUS_BASE = 'https://api.helius.xyz/v0';

/** Free tier allows 10 req/s; 8 leaves headroom for the Solana RPC client. */
const DEFAULT_REQUESTS_PER_SECOND = 8;
const MAX_RETRIES = 4;

export interface HeliusClientConfig {
  apiKey: string;
  webhookBaseUrl: string;
  /**
   * Sent to Helius as `authHeader`; Helius echoes it back as the
   * Authorization header on every webhook delivery to WEBHOOK_BASE_URL,
   * which is a public URL by design. Without this, anyone can POST a
   * forged transaction to /webhooks/helius and corrupt realized PnL with
   * no audit trail.
   */
  webhookSecret: string;
  /** Defaults to 8/s, just under the free tier's 10/s. */
  requestsPerSecond?: number;
  /** Injectable for tests so retry backoff does not really sleep. */
  clock?: RateLimiterClock;
}

export class HeliusClient {
  private limiter: RateLimiter;
  private sleep: (ms: number) => Promise<void>;

  constructor(private config: HeliusClientConfig) {
    const perSecond = config.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.limiter = new RateLimiter(Math.ceil(1000 / perSecond), config.clock);
    this.sleep = config.clock?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Every Helius call goes through here: rate-limited on the way out, and
   * retried on 429 and 5xx on the way back.
   *
   * Without the retry, a single 429 during a backfill threw straight out of
   * backfillWallet, whose caller only logs. The wallet was left with partial
   * history and no signal that anything was missing — and there is no
   * re-backfill path, so those trades were simply gone.
   */
  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const res = await fetch(url, init);

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) return res;

      // Helius sends Retry-After on 429; honour it rather than guessing.
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 250, 8_000);
      console.warn(`helius ${res.status}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await this.sleep(backoffMs);
    }
  }

  async createWalletWebhook(address: string): Promise<string> {
    const res = await this.fetchWithRetry(`${HELIUS_BASE}/webhooks?api-key=${this.config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: `${this.config.webhookBaseUrl}/webhooks/helius`,
        transactionTypes: ['SWAP'],
        accountAddresses: [address],
        webhookType: 'enhanced',
        authHeader: this.config.webhookSecret,
      }),
    });
    if (!res.ok) throw new Error(`Helius webhook create failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { webhookID: string };
    return data.webhookID;
  }

  /**
   * Hands a webhook address back to the free-tier pool. A 404 means it is
   * already gone, which is a success for our purposes — untracking has to be
   * idempotent. Any other failure throws, because silently dropping the wallet
   * row while leaving a live webhook behind would leak the address cap with no
   * record of what is holding it (spec §7).
   */
  async deleteWalletWebhook(webhookId: string): Promise<void> {
    const res = await this.fetchWithRetry(`${HELIUS_BASE}/webhooks/${webhookId}?api-key=${this.config.apiKey}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`Helius webhook delete failed: ${res.status} ${await res.text()}`);
  }

  async getTransactionHistory(address: string, before?: string): Promise<HeliusEnhancedTransaction[]> {
    const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`);
    url.searchParams.set('api-key', this.config.apiKey);
    url.searchParams.set('type', 'SWAP');
    if (before) url.searchParams.set('before', before);

    const res = await this.fetchWithRetry(url.toString());
    if (!res.ok) throw new Error(`Helius history fetch failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<HeliusEnhancedTransaction[]>;
  }
}
