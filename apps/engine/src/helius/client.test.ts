import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusClient } from './client';

describe('HeliusClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a webhook and returns its id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ webhookID: 'wh_123' }),
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com' });

    const id = await client.createWalletWebhook('Addr1');

    expect(id).toBe('wh_123');
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/webhooks?api-key=key1');
    expect(JSON.parse(options.body).accountAddresses).toEqual(['Addr1']);
  });

  it('throws when the webhook create request fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com' });

    await expect(client.createWalletWebhook('Addr1')).rejects.toThrow('Helius webhook create failed');
  });

  it('fetches transaction history', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ signature: 'sig1' }],
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com' });

    const history = await client.getTransactionHistory('Addr1');

    expect(history).toEqual([{ signature: 'sig1' }]);
  });
});
