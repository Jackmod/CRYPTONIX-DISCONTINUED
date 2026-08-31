import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngineClient, EngineError } from './client';

describe('EngineClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('lists wallets', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 1, address: 'Addr1', label: 'Me' }],
    });

    const wallets = await new EngineClient('http://engine:8787', 'test-key').listWallets();

    expect(wallets).toHaveLength(1);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://engine:8787/wallets');
  });

  it('tracks a wallet with the right body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 7, address: 'Addr1', label: 'Whale' }),
    });

    const wallet = await new EngineClient('http://engine:8787', 'test-key').trackWallet('Addr1', 'Whale', false);

    expect(wallet.id).toBe(7);
    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ address: 'Addr1', label: 'Whale', isMine: false });
  });

  it('untracks a wallet and tolerates the 204 empty body', async () => {
    // DELETE /wallets/:id answers 204 with no body. Calling res.json() on that
    // throws; the client must not.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error('no body to parse');
      },
    });

    await expect(new EngineClient('http://engine:8787', 'test-key').untrackWallet(7)).resolves.toBeUndefined();
  });

  it('raises EngineError carrying the status code', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'wallet not found' }),
    });

    const error = await new EngineClient('http://engine:8787', 'test-key').getPnl(99).catch((e) => e);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.status).toBe(404);
  });

  it('surfaces a connection failure as EngineError with status 0', async () => {
    // The engine being down is the common case in practice (it is a separate
    // process). Command handlers branch on EngineError, so a raw TypeError
    // from fetch must not escape.
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('fetch failed'));

    const error = await new EngineClient('http://engine:8787', 'test-key').listWallets().catch((e) => e);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.status).toBe(0);
  });

  it('lists guild configs', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ guildId: 'g1', alertChannelId: 'c1' }],
    });

    const configs = await new EngineClient('http://engine:8787', 'test-key').listGuildConfigs();

    expect(configs[0].guildId).toBe('g1');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://engine:8787/discord/guilds');
  });

  it('stores a guild config with PUT', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ guildId: 'g1', alertChannelId: 'c2' }),
    });

    const config = await new EngineClient('http://engine:8787', 'test-key').setGuildConfig('g1', 'c2', 'user1');

    expect(config.alertChannelId).toBe('c2');
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://engine:8787/discord/guilds/g1');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ alertChannelId: 'c2', setupBy: 'user1' });
  });

  it('sends the engine API key on every request', async () => {
    // The engine is publicly reachable so Helius can deliver; without this
    // header every call comes back 401.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, json: async () => [] });

    await new EngineClient('http://engine:8787', 'secret-key').listWallets();

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer secret-key');
  });

  it('keeps content-type when adding the auth header', async () => {
    // A regression guard: spreading headers wrongly would drop
    // Content-Type and the engine would parse an empty body.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });

    await new EngineClient('http://engine:8787', 'secret-key').trackWallet('Addr1', 'L', false);

    const [, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers.Authorization).toBe('Bearer secret-key');
  });

  it('unwraps the engine error message instead of quoting raw JSON', async () => {
    // This string is shown verbatim in a Discord reply, so it must read as a
    // sentence, not as a serialised response body.
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'address is not a valid Solana public key' }),
    });

    const error = await new EngineClient('http://e:1', 'k').trackWallet('bad', 'L', false).catch((e) => e);

    expect(error.message).toBe('address is not a valid Solana public key');
  });

  it('falls back to the raw body when the error is not JSON', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'upstream reset',
    });

    const error = await new EngineClient('http://e:1', 'k').listWallets().catch((e) => e);

    expect(error.message).toBe('upstream reset');
  });
});
