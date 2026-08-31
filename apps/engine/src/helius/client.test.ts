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
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    const id = await client.createWalletWebhook('Addr1');

    expect(id).toBe('wh_123');
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/webhooks?api-key=key1');
    expect(JSON.parse(options.body).accountAddresses).toEqual(['Addr1']);
  });

  it('sends the webhook secret as authHeader so Helius echoes it back on delivery', async () => {
    // Regression guard for the /webhooks/helius auth fix: without authHeader
    // set here, Helius never sends an Authorization header back, and the
    // route's timing-safe comparison would reject every real delivery.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ webhookID: 'wh_123' }),
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'my-secret' });

    await client.createWalletWebhook('Addr1');

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(options.body).authHeader).toBe('my-secret');
  });

  it('throws when the webhook create request fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await expect(client.createWalletWebhook('Addr1')).rejects.toThrow('Helius webhook create failed');
  });

  it('fetches transaction history', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ signature: 'sig1' }],
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    const history = await client.getTransactionHistory('Addr1');

    expect(history).toEqual([{ signature: 'sig1' }]);
  });

  it('deletes a webhook by id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await client.deleteWalletWebhook('wh_123');

    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/webhooks/wh_123?api-key=key1');
    expect(options.method).toBe('DELETE');
  });

  it('treats a 404 as already deleted rather than an error', async () => {
    // Untracking must stay idempotent: if the webhook is already gone (deleted
    // by hand in the Helius dashboard, or a retried request), the wallet row
    // still has to be removable. Throwing here would strand the wallet as
    // permanently un-untrackable.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await expect(client.deleteWalletWebhook('wh_gone')).resolves.toBeUndefined();
  });

  it('throws when webhook deletion fails for any other reason', async () => {
    // A 500 or a rate-limit must NOT be swallowed. If we deleted the wallet row
    // anyway, the webhook would keep firing forever against a wallet we no
    // longer know about, burning the free-tier address cap with no way to find it.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1' });

    await expect(client.deleteWalletWebhook('wh_123')).rejects.toThrow('Helius webhook delete failed');
  });
});
