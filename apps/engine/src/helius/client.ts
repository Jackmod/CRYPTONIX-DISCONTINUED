import type { HeliusEnhancedTransaction } from '@cryptonix/core';

const HELIUS_BASE = 'https://api.helius.xyz/v0';

export interface HeliusClientConfig {
  apiKey: string;
  webhookBaseUrl: string;
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
