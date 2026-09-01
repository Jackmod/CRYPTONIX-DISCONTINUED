import { describe, it, expect } from 'vitest';
import { buildTweetMessage, isTweetAlertPayload } from './tweet';

const payload = {
  tweetId: '1900000000000000002',
  authorHandle: 'ansem',
  authorName: 'Ansem',
  authorAvatarUrl: 'https://pbs.twimg.com/profile_images/a.jpg',
  text: 'sending it',
  mediaUrl: 'https://pbs.twimg.com/media/b.jpg',
  postedAt: '2026-09-01T10:00:00.000Z',
  url: 'https://x.com/ansem/status/1900000000000000002',
};

describe('isTweetAlertPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(isTweetAlertPayload(payload)).toBe(true);
  });

  it('accepts one with no avatar and no media', () => {
    expect(isTweetAlertPayload({ ...payload, authorAvatarUrl: null, mediaUrl: null })).toBe(true);
  });

  it.each([
    ['a wallet trade', { walletLabel: 'w', mint: 'm', side: 'buy', solAmount: 1 }],
    ['a new coin', { symbol: 'S', mint: 'm', momentumScore: 5 }],
    ['null', null],
    ['a string', 'nope'],
  ])('declines %s', (_label, value) => {
    expect(isTweetAlertPayload(value)).toBe(false);
  });

  it('declines a payload whose nullable fields are absent rather than null', () => {
    // An ABSENT mediaUrl passes a truthiness test and is then handed to
    // setImage, which throws and costs the whole alert.
    const { mediaUrl, ...withoutMedia } = payload;
    expect(isTweetAlertPayload(withoutMedia)).toBe(false);
    const { authorAvatarUrl, ...withoutAvatar } = payload;
    expect(isTweetAlertPayload(withoutAvatar)).toBe(false);
  });
});

describe('buildTweetMessage', () => {
  it('renders the card spec §5.2 asks for', () => {
    const message = buildTweetMessage(payload);
    const embed = message.embeds[0].toJSON();

    expect(embed.author?.name).toBe('Ansem (@ansem)');
    expect(embed.author?.icon_url).toBe('https://pbs.twimg.com/profile_images/a.jpg');
    expect(embed.author?.url).toBe('https://x.com/ansem');
    expect(embed.description).toBe('sending it');
    expect(embed.image?.url).toBe('https://pbs.twimg.com/media/b.jpg');
    expect(embed.timestamp).toBe('2026-09-01T10:00:00.000Z');
    expect(message.components).toHaveLength(1);
  });

  it('timestamps from the tweet, not from now', () => {
    // A replayed alert after an outage must not claim an old tweet just
    // happened.
    const embed = buildTweetMessage(payload).embeds[0].toJSON();
    expect(embed.timestamp).toBe('2026-09-01T10:00:00.000Z');
  });

  it('omits the picture when there is none, rather than sending an empty url', () => {
    const embed = buildTweetMessage({ ...payload, mediaUrl: null }).embeds[0].toJSON();
    expect(embed.image).toBeUndefined();
  });

  it('omits an avatar Discord could not load, keeping the rest of the card', () => {
    const embed = buildTweetMessage({ ...payload, authorAvatarUrl: 'javascript:alert(1)' }).embeds[0].toJSON();
    expect(embed.author?.icon_url).toBeUndefined();
    expect(embed.author?.name).toBe('Ansem (@ansem)');
  });

  it('drops media Discord could not load rather than losing the alert', () => {
    const embed = buildTweetMessage({ ...payload, mediaUrl: 'not a url' }).embeds[0].toJSON();
    expect(embed.image).toBeUndefined();
    expect(embed.description).toBe('sending it');
  });

  it('posts without the button when the tweet link is unusable', () => {
    const message = buildTweetMessage({ ...payload, url: 'javascript:alert(1)' });
    expect(message.components).toHaveLength(0);
    expect(message.embeds[0].toJSON().description).toBe('sending it');
  });

  it('clamps text Discord would reject for length', () => {
    const embed = buildTweetMessage({ ...payload, text: 'x'.repeat(5000) }).embeds[0].toJSON();
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });

  it('clamps an author name Discord would reject for length', () => {
    const embed = buildTweetMessage({ ...payload, authorName: 'x'.repeat(400) }).embeds[0].toJSON();
    expect(embed.author!.name.length).toBeLessThanOrEqual(256);
  });

  it('falls back to now on an unparseable timestamp instead of throwing', () => {
    const embed = buildTweetMessage({ ...payload, postedAt: 'garbage' }).embeds[0].toJSON();
    expect(Number.isNaN(new Date(embed.timestamp!).getTime())).toBe(false);
  });
});
