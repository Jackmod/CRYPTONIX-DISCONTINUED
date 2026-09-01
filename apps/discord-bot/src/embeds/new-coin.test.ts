import { describe, it, expect } from 'vitest';
import { buildNewCoinMessage, isNewCoinAlertPayload } from './new-coin';

const payload = {
  mint: 'BnS61WuqU6LGvy8Pu6WXezuyQqvW2HcE2tnwRBr6pump',
  symbol: 'catcall',
  momentumScore: 78,
  ageMinutes: 3,
  volume5m: 24_983,
  priceChange5m: 79.97,
  buys5m: 288,
  sells5m: 157,
  liquidityUsd: 40_000,
  fdvUsd: 500_000,
  axiomLink: 'https://axiom.trade/t/BnS61WuqU6LGvy8Pu6WXezuyQqvW2HcE2tnwRBr6pump',
};

describe('isNewCoinAlertPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(isNewCoinAlertPayload(payload)).toBe(true);
  });

  it('rejects a payload whose nullable fields are missing rather than null', () => {
    // Absent is not the same as null: it slipped past the guard, failed the
    // `=== null` test in the renderer, and printed "$NaN" into a live channel.
    const { liquidityUsd, ...withoutLiquidity } = payload;
    expect(isNewCoinAlertPayload(withoutLiquidity)).toBe(false);

    const { fdvUsd, ...withoutFdv } = payload;
    expect(isNewCoinAlertPayload(withoutFdv)).toBe(false);

    expect(isNewCoinAlertPayload({ ...payload, liquidityUsd: Number.NaN })).toBe(false);
    // Explicit null is fine, and normal on the newest pairs.
    expect(isNewCoinAlertPayload({ ...payload, liquidityUsd: null, fdvUsd: null })).toBe(true);
  });

  it('rejects a wallet-trade payload sharing the same socket', () => {
    expect(isNewCoinAlertPayload({ walletLabel: 'Whale', mint: 'M', side: 'buy' })).toBe(false);
    expect(isNewCoinAlertPayload(null)).toBe(false);
  });
});

describe('buildNewCoinMessage', () => {
  it('names the coin and its momentum', () => {
    const data = buildNewCoinMessage(payload).embeds[0].toJSON();

    expect(data.title).toContain('catcall');
    expect(JSON.stringify(data)).toContain('78/100');
  });

  it('reports the buy share of trades', () => {
    const data = buildNewCoinMessage(payload).embeds[0].toJSON();
    const trades = data.fields?.find((f) => f.name.includes('trades'));

    expect(trades?.value).toContain('288B / 157S');
    expect(trades?.value).toContain('65% buys');
  });

  it('says liquidity is not reported yet rather than printing $0', () => {
    // Null is normal on the newest pairs. $0 would read as "no liquidity",
    // which is a different and much more alarming claim.
    const data = buildNewCoinMessage({ ...payload, liquidityUsd: null }).embeds[0].toJSON();
    const liq = data.fields?.find((f) => f.name.includes('Liquidity'));

    expect(liq?.value).toBe('not reported yet');
  });

  it('attaches an Axiom button pointing at the mint', () => {
    const button = buildNewCoinMessage(payload).components[0].toJSON().components[0] as { url?: string; style: number };

    expect(button.url).toBe(payload.axiomLink);
    expect(button.style).toBe(5); // ButtonStyle.Link
  });

  it('posts without the button rather than throwing on a bad link', () => {
    for (const axiomLink of ['not a url', 'javascript:alert(1)', '']) {
      const message = buildNewCoinMessage({ ...payload, axiomLink });
      expect(message.components, `link ${axiomLink}`).toHaveLength(0);
      expect(message.embeds).toHaveLength(1);
    }
  });

  it('colours a strong signal differently from a marginal one', () => {
    const strong = buildNewCoinMessage({ ...payload, momentumScore: 90 }).embeds[0].toJSON();
    const weak = buildNewCoinMessage({ ...payload, momentumScore: 20 }).embeds[0].toJSON();

    expect(strong.color).not.toBe(weak.color);
  });

  it('never throws on any payload the type guard accepts', () => {
    const hostile = [
      { ...payload, symbol: 'z'.repeat(5000) },
      { ...payload, axiomLink: 'nope' },
      { ...payload, buys5m: 0, sells5m: 0 },
      { ...payload, volume5m: Number.MAX_SAFE_INTEGER },
    ];

    for (const p of hostile) {
      expect(isNewCoinAlertPayload(p)).toBe(true);
      expect(() => buildNewCoinMessage(p)).not.toThrow();
    }
  });

  it('does not divide by zero when nothing traded', () => {
    const data = buildNewCoinMessage({ ...payload, buys5m: 0, sells5m: 0 }).embeds[0].toJSON();
    const trades = data.fields?.find((f) => f.name.includes('trades'));

    expect(trades?.value).toContain('0% buys');
  });
});
