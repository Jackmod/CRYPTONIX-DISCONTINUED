import type { HeliusEnhancedTransaction } from '@cryptonix/core';

const HELIUS_BASE = 'https://api.helius.xyz/v0';

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
}

export class HeliusClient {
  constructor(private config: HeliusClientConfig) {}

  async createWalletWebhook(address: string): Promise<string> {
    const res = await fetch(`${HELIUS_BASE}/webhooks?api-key=${this.config.apiKey}`, {
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

  async getTransactionHistory(address: string, before?: string): Promise<HeliusEnhancedTransaction[]> {
    const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`);
    url.searchParams.set('api-key', this.config.apiKey);
    url.searchParams.set('type', 'SWAP');
    if (before) url.searchParams.set('before', before);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Helius history fetch failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<HeliusEnhancedTransaction[]>;
  }
}
