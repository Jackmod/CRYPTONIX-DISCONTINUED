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

    const wallets = await new EngineClient('http://engine:8787').listWallets();

    expect(wallets).toHaveLength(1);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://engine:8787/wallets');
  });

  it('tracks a wallet with the right body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 7, address: 'Addr1', label: 'Whale' }),
    });

    const wallet = await new EngineClient('http://engine:8787').trackWallet('Addr1', 'Whale', false);

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

    await expect(new EngineClient('http://engine:8787').untrackWallet(7)).resolves.toBeUndefined();
  });

  it('raises EngineError carrying the status code', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'wallet not found',
    });

    const error = await new EngineClient('http://engine:8787').getPnl(99).catch((e) => e);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.status).toBe(404);
  });

  it('surfaces a connection failure as EngineError with status 0', async () => {
    // The engine being down is the common case in practice (it is a separate
    // process). Command handlers branch on EngineError, so a raw TypeError
    // from fetch must not escape.
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('fetch failed'));

    const error = await new EngineClient('http://engine:8787').listWallets().catch((e) => e);

    expect(error).toBeInstanceOf(EngineError);
    expect(error.status).toBe(0);
  });
});
