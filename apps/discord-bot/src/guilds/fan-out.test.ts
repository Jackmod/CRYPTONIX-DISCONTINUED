import { describe, it, expect, vi } from 'vitest';
import { fanOutAlert } from './fan-out';

const walletAlert = {
  type: 'wallet_buy',
  refId: 1,
  payload: {
    walletId: 1,
    walletLabel: 'Whale',
    mint: 'Mint1',
    side: 'buy' as const,
    solAmount: 2.5,
    tokenAmount: 1000,
    axiomLink: 'https://axiom.trade/t/Mint1',
  },
};

function cacheOf(...guilds: [string, string][]) {
  return { entries: () => guilds.map(([guildId, alertChannelId]) => ({ guildId, alertChannelId })) };
}

describe('fanOutAlert', () => {
  it('posts to every configured guild', async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await fanOutAlert(walletAlert, cacheOf(['g1', 'c1'], ['g2', 'c2']), send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
  });

  it('keeps delivering when one guild fails', async () => {
    // A revoked permission in one server must not cost every other server its
    // alerts. This is the whole reason fan-out is isolated per guild.
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing permissions'))
      .mockResolvedValueOnce(undefined);

    await fanOutAlert(walletAlert, cacheOf(['g1', 'c1'], ['g2', 'c2']), send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ignores alert types this version does not render', async () => {
    const send = vi.fn();

    await fanOutAlert({ type: 'tweet', refId: 2, payload: {} }, cacheOf(['g1', 'c1']), send);

    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a wallet alert with an unexpected payload', async () => {
    const send = vi.fn();

    await fanOutAlert({ type: 'wallet_buy', refId: 3, payload: { nope: true } }, cacheOf(['g1', 'c1']), send);

    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when no guild has run /setup', async () => {
    const send = vi.fn();

    await fanOutAlert(walletAlert, cacheOf(), send);

    expect(send).not.toHaveBeenCalled();
  });
});
