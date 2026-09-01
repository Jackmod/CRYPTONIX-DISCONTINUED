import { describe, it, expect, vi } from 'vitest';
import { TwitterApiIoSource, TweetSourceError } from './twitterapi-io';
import { isNewerTweetId } from './source';

/** A row shaped the way the endpoint reference documents it. */
const RAW = {
  id: '1900000000000000002',
  url: 'https://x.com/ansem/status/1900000000000000002',
  text: 'gm',
  createdAt: 'Tue Dec 10 07:00:30 +0000 2024',
  likeCount: 12,
  replyCount: 3,
  author: { userName: 'ansem', name: 'Ansem', profilePicture: 'https://pbs.twimg.com/a.jpg' },
};

function source(...responses: (Response | Error)[]) {
  let call = 0;
  const fetchImpl = vi.fn(async () => {
    const next = responses[Math.min(call++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    source: new TwitterApiIoSource({ apiKey: 'k', fetchImpl: fetchImpl as never, minIntervalMs: 0 }),
    fetchImpl,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('TwitterApiIoSource', () => {
  it('refuses to construct without a key rather than failing on every call', () => {
    expect(() => new TwitterApiIoSource({ apiKey: '' })).toThrow(/API key/);
  });

  it('sends the key as X-API-Key and asks for one handle at a time', async () => {
    const { source: s, fetchImpl } = source(json({ tweets: [RAW], status: 'success' }));
    await s.fetchNewTweets(['ansem'], new Map());

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/twitter/user/last_tweets');
    expect(url).toContain('userName=ansem');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
  });

  it('excludes replies, which are noise in an alert channel', async () => {
    const { source: s, fetchImpl } = source(json({ tweets: [], status: 'success' }));
    await s.fetchNewTweets(['ansem'], new Map());
    expect(String(fetchImpl.mock.calls[0][0])).toContain('includeReplies=false');
  });

  it('normalises a documented row into the shared tweet shape', async () => {
    const { source: s } = source(json({ tweets: [RAW], status: 'success' }));
    const [tweet] = await s.fetchNewTweets(['ansem'], new Map());

    expect(tweet).toEqual({
      id: '1900000000000000002',
      authorHandle: 'ansem',
      authorName: 'Ansem',
      authorAvatarUrl: 'https://pbs.twimg.com/a.jpg',
      text: 'gm',
      media: [],
      postedAt: '2024-12-10T07:00:30.000Z',
      likeCount: 12,
      replyCount: 3,
      url: 'https://x.com/ansem/status/1900000000000000002',
    });
  });

  it('keeps only tweets newer than the id already recorded', async () => {
    const older = { ...RAW, id: '1900000000000000001' };
    const newer = { ...RAW, id: '1900000000000000003' };
    const { source: s } = source(json({ tweets: [older, RAW, newer], status: 'success' }));

    const got = await s.fetchNewTweets(['ansem'], new Map([['ansem', '1900000000000000002']]));
    expect(got.map((t) => t.id)).toEqual(['1900000000000000003']);
  });

  it('treats a documented error body as a failure even though it arrives as HTTP 200', async () => {
    const { source: s } = source(json({ status: 'error', message: 'insufficient credits' }));
    // The whole sweep survives; the handle is skipped and logged.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await s.fetchNewTweets(['ansem'], new Map())).toEqual([]);
    expect(String(spy.mock.calls[0]?.[1])).toContain('insufficient credits');
    spy.mockRestore();
  });

  it('lets one bad handle fail without costing the others their tweets', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { source: s } = source(json({ error: 'nope' }, 404), json({ tweets: [RAW], status: 'success' }));

    const got = await s.fetchNewTweets(['gone', 'ansem'], new Map());
    expect(got.map((t) => t.id)).toEqual(['1900000000000000002']);
    spy.mockRestore();
  });

  it('drops a row with no id or no text rather than rendering an empty card', async () => {
    const { source: s } = source(
      json({ tweets: [{ text: 'no id' }, { id: '1' }, RAW], status: 'success' })
    );
    expect((await s.fetchNewTweets(['ansem'], new Map())).map((t) => t.id)).toEqual([RAW.id]);
  });

  it('accepts a numeric id without letting it lose precision', async () => {
    // Serialised as a JSON number, 1900000000000000002 does not survive a
    // round trip exactly — so the guard is that it is stringified, not parsed.
    const { source: s } = source(json({ tweets: [{ ...RAW, id: 1900000000000000002 }], status: 'success' }));
    const [tweet] = await s.fetchNewTweets(['ansem'], new Map());
    expect(typeof tweet.id).toBe('string');
  });

  it('falls back to the requested handle when the author block is missing', async () => {
    const { source: s } = source(json({ tweets: [{ id: '1', text: 'hi' }], status: 'success' }));
    const [tweet] = await s.fetchNewTweets(['ansem'], new Map());
    expect(tweet).toMatchObject({ authorHandle: 'ansem', authorName: 'ansem', authorAvatarUrl: null });
    expect(tweet.url).toBe('https://x.com/ansem/status/1');
  });

  it('never emits an Invalid Date, whatever createdAt turns out to be', async () => {
    // The docs name the field but not its format; an Invalid Date throws the
    // moment anything downstream calls toISOString on it.
    for (const createdAt of ['nonsense', undefined, 12345, null]) {
      const { source: s } = source(json({ tweets: [{ ...RAW, createdAt }], status: 'success' }));
      const [tweet] = await s.fetchNewTweets(['ansem'], new Map());
      expect(Number.isNaN(new Date(tweet.postedAt).getTime())).toBe(false);
    }
  });

  it('reads media from either shape X uses, and skips kinds it does not know', async () => {
    const { source: s } = source(
      json({
        tweets: [
          {
            ...RAW,
            extendedEntities: {
              media: [
                { type: 'photo', media_url_https: 'https://pbs/1.jpg' },
                { type: 'hologram', media_url_https: 'https://pbs/2.bin' },
              ],
            },
          },
        ],
        status: 'success',
      })
    );
    const [tweet] = await s.fetchNewTweets(['ansem'], new Map());
    expect(tweet.media).toEqual([{ type: 'photo', url: 'https://pbs/1.jpg' }]);
  });

  it('survives a body with no tweets array at all', async () => {
    const { source: s } = source(json({ status: 'success' }));
    expect(await s.fetchNewTweets(['ansem'], new Map())).toEqual([]);
  });
});

describe('isNewerTweetId', () => {
  it('orders ids of the same length lexicographically', () => {
    expect(isNewerTweetId('1900000000000000003', '1900000000000000002')).toBe(true);
    expect(isNewerTweetId('1900000000000000002', '1900000000000000003')).toBe(false);
  });

  it('treats a longer id as newer, which decimal ordering requires', () => {
    expect(isNewerTweetId('10000000000000000000', '9999999999999999999')).toBe(true);
  });

  it('does not consider an id newer than itself', () => {
    expect(isNewerTweetId('123', '123')).toBe(false);
  });

  it('separates ids that a JS number would collapse together', () => {
    // Both parse to the same float; comparing as numbers would call them equal
    // and silently drop a tweet.
    const a = '1900000000000000001';
    const b = '1900000000000000002';
    expect(Number(a)).toBe(Number(b));
    expect(isNewerTweetId(b, a)).toBe(true);
  });
});
