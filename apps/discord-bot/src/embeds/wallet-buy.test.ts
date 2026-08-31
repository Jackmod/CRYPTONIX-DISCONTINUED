import { describe, it, expect } from 'vitest';
import { buildWalletTradeMessage, isWalletAlertPayload } from './wallet-buy';

const payload = {
  walletId: 1,
  walletLabel: 'Whale One',
  mint: 'So11111111111111111111111111111111111111112',
  side: 'buy' as const,
  solAmount: 2.5,
  tokenAmount: 1_250_000,
  axiomLink: 'https://axiom.trade/t/So11111111111111111111111111111111111111112',
};

describe('isWalletAlertPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(isWalletAlertPayload(payload)).toBe(true);
  });

  it('rejects payloads from other alert types', () => {
    // Phase 3 puts tweet and new-coin alerts on this same socket. Rendering
    // one of those as a trade would post a wall of "undefined" to a live channel.
    expect(isWalletAlertPayload({ tweetId: '123', text: 'gm' })).toBe(false);
    expect(isWalletAlertPayload(null)).toBe(false);
    expect(isWalletAlertPayload({ ...payload, side: 'sideways' })).toBe(false);
  });
});

describe('buildWalletTradeMessage', () => {
  it('names the wallet and the amounts in the embed', () => {
    const { embeds } = buildWalletTradeMessage(payload);
    const data = embeds[0].toJSON();

    expect(data.title).toContain('Whale One');
    expect(JSON.stringify(data)).toContain('2.5');
  });

  it('attaches an Axiom link button pointing at the mint', () => {
    const { components } = buildWalletTradeMessage(payload);
    const button = components[0].toJSON().components[0] as { url?: string; style: number };

    expect(button.url).toBe(payload.axiomLink);
    expect(button.style).toBe(5); // ButtonStyle.Link
  });

  it('colours buys and sells differently', () => {
    const buy = buildWalletTradeMessage(payload).embeds[0].toJSON();
    const sell = buildWalletTradeMessage({ ...payload, side: 'sell' }).embeds[0].toJSON();

    expect(buy.color).not.toBe(sell.color);
    expect(sell.title).toContain('Sell');
  });
});

describe('buildWalletTradeMessage: unrenderable payloads', () => {
  it('clamps a title Discord would reject', () => {
    // An alert that cannot be rendered can never be delivered, however many
    // times it is retried, so it must not be possible to build one.
    const { embeds } = buildWalletTradeMessage({ ...payload, walletLabel: 'x'.repeat(500) });

    expect(embeds[0].toJSON().title!.length).toBeLessThanOrEqual(256);
  });

  it('posts without the button rather than throwing on a bad link', () => {
    for (const axiomLink of ['not a url', 'javascript:alert(1)', '', 'ftp://example.com/x']) {
      const message = buildWalletTradeMessage({ ...payload, axiomLink });
      expect(message.components, `link ${axiomLink}`).toHaveLength(0);
      expect(message.embeds).toHaveLength(1);
    }
  });

  it('never throws on any payload the type guard accepts', () => {
    const hostile = [
      { ...payload, walletLabel: 'y'.repeat(5000) },
      { ...payload, mint: '' },
      { ...payload, axiomLink: 'nope' },
      { ...payload, tokenAmount: Number.MAX_SAFE_INTEGER },
      { ...payload, solAmount: -0 },
    ];

    for (const p of hostile) {
      expect(isWalletAlertPayload(p), JSON.stringify(p).slice(0, 40)).toBe(true);
      expect(() => buildWalletTradeMessage(p)).not.toThrow();
    }
  });
});
