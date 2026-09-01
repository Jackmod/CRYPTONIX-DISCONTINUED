import { describe, expect, it } from 'vitest';
import { mergeFeed, toFeedItem, type FeedItem } from './feed';

const TS = '2026-09-01T12:00:00.000Z';

function item(id: number): FeedItem {
  return { id, kind: 'buy', what: 'w', detail: 'd', imageUrl: null, link: null, at: new Date(TS) };
}

describe('toFeedItem', () => {
  it('renders a wallet buy with amount and shortened mint', () => {
    const result = toFeedItem({
      id: 7,
      type: 'wallet_buy',
      ts: TS,
      payload: { walletLabel: 'whale', mint: 'So11111111111111111111111111111111111111112', solAmount: 1.5 },
    });
    expect(result).toMatchObject({ id: 7, kind: 'buy', what: 'whale' });
    expect(result!.detail).toBe('1.50 SOL · So11…1112');
  });

  it('marks a sell as a sell', () => {
    const result = toFeedItem({ id: 1, type: 'wallet_sell', payload: { walletLabel: 'w', mint: 'mint' } });
    expect(result!.kind).toBe('sell');
  });

  it('renders a new coin with score, volume and change', () => {
    const result = toFeedItem({
      id: 9,
      type: 'new_coin',
      ts: TS,
      payload: { symbol: 'PEPE', mint: 'abc', momentumScore: 80, volume5m: 12_500, priceChange5m: 42.4 },
    });
    expect(result).toMatchObject({ kind: 'coin', what: 'PEPE' });
    expect(result!.detail).toBe('80/100 · $12.5k 5m · +42%');
  });

  it('carries an image url when the provider had one', () => {
    const result = toFeedItem({
      id: 9,
      type: 'new_coin',
      payload: { symbol: 'P', mint: 'abc', imageUrl: 'https://cdn/p.png' },
    });
    expect(result!.imageUrl).toBe('https://cdn/p.png');
  });

  it('renders a tweet alert, which the rail interleaves with the rest (spec §5.3)', () => {
    const result = toFeedItem({
      id: 11,
      type: 'tweet',
      ts: TS,
      payload: {
        authorHandle: 'ansem',
        authorName: 'Ansem',
        authorAvatarUrl: 'https://pbs.twimg.com/a.jpg',
        text: 'sending it',
        url: 'https://x.com/ansem/status/5',
      },
    });

    expect(result).toMatchObject({
      id: 11,
      kind: 'tweet',
      what: '@ansem',
      detail: 'sending it',
      imageUrl: 'https://pbs.twimg.com/a.jpg',
      link: 'https://x.com/ansem/status/5',
    });
  });

  it('flattens a tweet onto one line, so one entry cannot take five', () => {
    const result = toFeedItem({
      id: 1,
      type: 'tweet',
      // A real tweet's own line breaks, which the rail must not inherit.
      payload: { authorHandle: 'a', text: `one${'\n\n'}two   three${'\n'}` },
    });
    expect(result!.detail).toBe('one two three');
  });

  it('renders a tweet with no avatar', () => {
    const result = toFeedItem({ id: 1, type: 'tweet', payload: { authorHandle: 'a', text: 'hi' } });
    expect(result!.imageUrl).toBeNull();
    expect(result!.link).toBeNull();
  });

  it.each([
    ['an unknown type', { id: 1, type: 'shrug', payload: { text: 'hi' } }],
    ['a tweet with no handle', { id: 1, type: 'tweet', payload: { text: 'hi' } }],
    ['a tweet with no text', { id: 1, type: 'tweet', payload: { authorHandle: 'a' } }],
    ['a non-object payload', { id: 1, type: 'wallet_buy', payload: 'nope' }],
    ['a null payload', { id: 1, type: 'wallet_buy', payload: null }],
    ['a wallet alert with no label', { id: 1, type: 'wallet_buy', payload: { mint: 'm' } }],
    ['a coin alert with no symbol', { id: 1, type: 'new_coin', payload: { mint: 'm' } }],
  ])('drops %s rather than rendering a placeholder', (_label, alert) => {
    expect(toFeedItem(alert as never)).toBeNull();
  });

  it('tolerates a missing amount instead of printing NaN', () => {
    const result = toFeedItem({ id: 1, type: 'wallet_buy', payload: { walletLabel: 'w', mint: 'mint' } });
    expect(result!.detail).toContain('0.00 SOL');
  });

  it('ignores a non-string axiom link', () => {
    const result = toFeedItem({ id: 1, type: 'new_coin', payload: { symbol: 'S', mint: 'm', axiomLink: 42 } });
    expect(result!.link).toBeNull();
  });

  it('falls back to now on an unparseable timestamp, rather than an Invalid Date', () => {
    // Regression: Invalid Date throws from toISOString(), which the rail calls
    // on every row — one bad row took the whole feed down.
    const result = toFeedItem({ id: 1, type: 'new_coin', ts: 'not a date', payload: { symbol: 'S', mint: 'm' } });
    expect(Number.isNaN(result!.at.getTime())).toBe(false);
    expect(() => result!.at.toISOString()).not.toThrow();
  });

  it('falls back to now when the alert carries no timestamp', () => {
    const before = Date.now();
    const result = toFeedItem({ id: 1, type: 'new_coin', payload: { symbol: 'S', mint: 'm' } });
    expect(result!.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('mergeFeed', () => {
  it('orders newest first', () => {
    expect(mergeFeed([item(1)], [item(3), item(2)]).map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it('replaces rather than duplicates a repeated id', () => {
    const updated = { ...item(1), detail: 'newer' };
    const merged = mergeFeed([item(1)], [updated]);
    expect(merged).toHaveLength(1);
    expect(merged[0].detail).toBe('newer');
  });

  it('caps the rail so a long session cannot grow without bound', () => {
    const many = Array.from({ length: 300 }, (_, i) => item(i + 1));
    const merged = mergeFeed([], many, 200);
    expect(merged).toHaveLength(200);
    expect(merged[0].id).toBe(300);
    expect(merged[199].id).toBe(101);
  });

  it('keeps the newest when the cap is reached across two batches', () => {
    const first = mergeFeed([], Array.from({ length: 200 }, (_, i) => item(i + 1)), 200);
    const second = mergeFeed(first, [item(500)], 200);
    expect(second[0].id).toBe(500);
    expect(second).toHaveLength(200);
  });
});
