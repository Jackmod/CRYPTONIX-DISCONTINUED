import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusClient } from './client';

/** No real waiting: rate-limit spacing and retry backoff resolve immediately. */
const instantClock = { now: () => Date.now(), sleep: async () => {} };

describe('HeliusClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a webhook and returns its id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ webhookID: 'wh_123' }),
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1', clock: instantClock });

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
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'my-secret', clock: instantClock });

    await client.createWalletWebhook('Addr1');

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(options.body).authHeader).toBe('my-secret');
  });

  it('throws when the webhook create request fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1', clock: instantClock });

    await expect(client.createWalletWebhook('Addr1')).rejects.toThrow('Helius webhook create failed');
  });

  it('fetches transaction history', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ signature: 'sig1' }],
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1', clock: instantClock });

    const history = await client.getTransactionHistory('Addr1');

    expect(history).toEqual([{ signature: 'sig1' }]);
  });

  it('deletes a webhook by id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1', clock: instantClock });

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
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1', clock: instantClock });

    await expect(client.deleteWalletWebhook('wh_gone')).resolves.toBeUndefined();
  });

  it('throws when webhook deletion fails for any other reason', async () => {
    // A 500 or a rate-limit must NOT be swallowed. If we deleted the wallet row
    // anyway, the webhook would keep firing forever against a wallet we no
    // longer know about, burning the free-tier address cap with no way to find it.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com', webhookSecret: 'secret1', clock: instantClock });

    await expect(client.deleteWalletWebhook('wh_123')).rejects.toThrow('Helius webhook delete failed');
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    // A single rate-limit response used to throw straight out of a backfill,
    // leaving the wallet with partial history and no way to re-fetch it.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => [{ signature: 'sig1' }] });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://e.com', webhookSecret: 's', clock: instantClock });

    const history = await client.getTransactionHistory('Addr1');

    expect(history).toEqual([{ signature: 'sig1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 as well as a 429', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://e.com', webhookSecret: 's', clock: instantClock });

    await client.getTransactionHistory('Addr1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and surfaces the error', async () => {
    // Retrying forever would hide a real outage and hold the backfill open.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'slow down' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://e.com', webhookSecret: 's', clock: instantClock });

    await expect(client.getTransactionHistory('Addr1')).rejects.toThrow('Helius history fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(5); // initial + 4 retries
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    // A 400 means the request is wrong; retrying it just wastes quota.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://e.com', webhookSecret: 's', clock: instantClock });

    await expect(client.getTransactionHistory('Addr1')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours a Retry-After header instead of guessing', async () => {
    const slept: number[] = [];
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: (h: string) => (h === 'retry-after' ? '3' : null) }, text: async () => 'x' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] });
    const client = new HeliusClient({
      apiKey: 'key1',
      webhookBaseUrl: 'https://e.com',
      webhookSecret: 's',
      clock: { now: () => Date.now(), sleep: async (ms: number) => { slept.push(ms); } },
    });

    await client.getTransactionHistory('Addr1');

    expect(slept).toContain(3000);
  });

  it('does not retry a webhook CREATE on a 5xx', async () => {
    // Creating is not idempotent. Helius may have created the webhook and
    // failed on the way back; retrying would create a second one whose id we
    // never learn, orphaning the first against the free-tier address cap.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'unavailable' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://e.com', webhookSecret: 's', clock: instantClock });

    await expect(client.createWalletWebhook('Addr1')).rejects.toThrow('Helius webhook create failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a webhook CREATE on a 429', async () => {
    // Rate-limited means it was not performed, so retrying cannot duplicate.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'slow down' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ webhookID: 'wh_9' }) });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://e.com', webhookSecret: 's', clock: instantClock });

    expect(await client.createWalletWebhook('Addr1')).toBe('wh_9');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts our secrets out of upstream error text', async () => {
    // The create request body carries authHeader: WEBHOOK_SECRET. An upstream
    // error that echoes the payload would otherwise carry that secret into a
    // 502 body and on into a public Discord reply.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => 'rejected payload {"authHeader":"super-secret-value","key":"my-api-key"}',
    });
    const client = new HeliusClient({
      apiKey: 'my-api-key',
      webhookBaseUrl: 'https://e.com',
      webhookSecret: 'super-secret-value',
      clock: instantClock,
    });

    const error = await client.createWalletWebhook('Addr1').catch((e) => e);

    expect(error.message).not.toContain('super-secret-value');
    expect(error.message).not.toContain('my-api-key');
    expect(error.message).toContain('[redacted: webhook secret]');
    expect(error.message).toContain('[redacted: api key]');
  });

  it('caps a huge Retry-After instead of stalling for hours', async () => {
    // Retry-After: 3600 would hold the request open across the whole retry
    // budget, expiring the Discord interaction and stalling every caller
    // queued behind the shared rate limiter.
    const slept: number[] = [];
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: (h: string) => (h === 'retry-after' ? '3600' : null) }, text: async () => 'x' })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] });
    const client = new HeliusClient({
      apiKey: 'key1',
      webhookBaseUrl: 'https://e.com',
      webhookSecret: 's',
      clock: { now: () => Date.now(), sleep: async (ms: number) => { slept.push(ms); } },
    });

    await client.getTransactionHistory('Addr1');

    expect(Math.max(...slept)).toBeLessThanOrEqual(8_000);
  });

  it('does not mangle upstream text when a secret is empty', async () => {
    // String.split('') splits between every character, so an empty secret
    // would rebuild the message with a redaction marker between each one.
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 400, headers: { get: () => null }, text: async () => 'plain upstream message' });
    const client = new HeliusClient({ apiKey: '', webhookBaseUrl: 'https://e.com', webhookSecret: '', clock: instantClock });

    const error = await client.getTransactionHistory('Addr1').catch((e) => e);

    expect(error.message).toContain('plain upstream message');
  });
});
