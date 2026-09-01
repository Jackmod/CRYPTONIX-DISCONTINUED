import { describe, it, expect, vi } from 'vitest';
import { SyndicationClient, SyndicationError } from './syndication';

/** The fields the real endpoint returns, trimmed to what this reads. */
const REAL_RESPONSE = {
  __typename: 'Tweet',
  id_str: '1683920951807971329',
  text: 'Introducing `react-tweet`',
  created_at: '2023-07-25T19:23:35.000Z',
  favorite_count: 1706,
  conversation_count: 42,
  user: {
    name: 'Vercel',
    screen_name: 'vercel',
    profile_image_url_https: 'https://pbs.twimg.com/profile_images/1767351110228918272/3Pndc5OT_normal.png',
  },
  mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/abc.jpg' }],
};

/**
 * A Response body can only be read once, so a test that calls twice has to
 * hand over a fresh one each time.
 */
function client(response: Response | Error | (() => Response)) {
  const fetchImpl = vi.fn(async () => {
    if (typeof response === 'function') return response();
    if (response instanceof Error) throw response;
    return response;
  });
  return { client: new SyndicationClient({ fetchImpl: fetchImpl as never }), fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SyndicationClient', () => {
  it('normalises a real response into a tweet card', async () => {
    const { client: c } = client(json(REAL_RESPONSE));
    const tweet = await c.getTweet('1683920951807971329');

    expect(tweet).toEqual({
      id: '1683920951807971329',
      authorHandle: 'vercel',
      authorName: 'Vercel',
      authorAvatarUrl: 'https://pbs.twimg.com/profile_images/1767351110228918272/3Pndc5OT_normal.png',
      text: 'Introducing `react-tweet`',
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/abc.jpg' }],
      postedAt: '2023-07-25T19:23:35.000Z',
      likeCount: 1706,
      replyCount: 42,
      url: 'https://x.com/vercel/status/1683920951807971329',
    });
  });

  it('always sends a token, because without one the endpoint answers 200 with {}', async () => {
    const { client: c, fetchImpl } = client(json(REAL_RESPONSE));
    await c.getTweet('123');
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/[?&]token=[^&]+/);
  });

  it('sends the same url for the same tweet, so a cache in front of it works', async () => {
    const { client: c, fetchImpl } = client(() => json(REAL_RESPONSE));
    await c.getTweet('123');
    await c.getTweet('123');
    expect(fetchImpl.mock.calls[0][0]).toBe(fetchImpl.mock.calls[1][0]);
  });

  it('returns null for the empty body a missing token produces', async () => {
    // HTTP 200 with `{}` — a success status carrying no data. Trusting the
    // status alone would put a card full of "undefined" in a live channel.
    const { client: c } = client(json({}));
    expect(await c.getTweet('123')).toBeNull();
  });

  it('returns null for a deleted or protected tweet, which answers 404 in HTML', async () => {
    const { client: c } = client(new Response('<!DOCTYPE html><html>...', { status: 404 }));
    expect(await c.getTweet('1111111111111111111')).toBeNull();
  });

  it('returns null for an id the endpoint rejects outright', async () => {
    const { client: c } = client(json({ error: 'Bad request.' }, 400));
    expect(await c.getTweet('notanumber')).toBeNull();
  });

  it('throws on a server error, which IS worth retrying', async () => {
    const { client: c } = client(new Response('nope', { status: 503 }));
    await expect(c.getTweet('123')).rejects.toBeInstanceOf(SyndicationError);
  });

  it('reports an unreachable CDN as status 0', async () => {
    const { client: c } = client(new TypeError('fetch failed'));
    const err = await c.getTweet('123').then(
      () => null,
      (e: SyndicationError) => e
    );
    expect(err?.status).toBe(0);
  });

  it('throws rather than guessing when a 200 body is not JSON at all', async () => {
    const { client: c } = client(new Response('<html>', { status: 200 }));
    await expect(c.getTweet('123')).rejects.toBeInstanceOf(SyndicationError);
  });

  it('falls back to the handle when the account has no display name', async () => {
    const { client: c } = client(json({ ...REAL_RESPONSE, user: { screen_name: 'vercel' } }));
    const tweet = await c.getTweet('123');
    expect(tweet?.authorName).toBe('vercel');
    expect(tweet?.authorAvatarUrl).toBeNull();
  });

  it('drops media it does not recognise rather than guessing the kind', async () => {
    const { client: c } = client(
      json({
        ...REAL_RESPONSE,
        mediaDetails: [
          { type: 'photo', media_url_https: 'https://ok/1.jpg' },
          { type: 'hologram', media_url_https: 'https://weird/2.bin' },
          { type: 'photo' },
          null,
        ],
      })
    );
    expect((await c.getTweet('123'))?.media).toEqual([{ type: 'photo', url: 'https://ok/1.jpg' }]);
  });

  it('decodes the HTML entities the endpoint escapes text with', async () => {
    // A real response carries `&lt;iframe&gt;` for `<iframe>`, because this
    // data is meant for an embed's markup. Both our surfaces render text.
    const { client: c } = client(json({ ...REAL_RESPONSE, text: 'a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;' }));
    expect((await c.getTweet('123'))?.text).toBe(`a <b> & "c" 'd'`);
  });

  it('does not invent markup out of a literally escaped ampersand', async () => {
    // Decoding &amp; first would turn `&amp;lt;` into `<`, which the tweet
    // never said.
    const { client: c } = client(json({ ...REAL_RESPONSE, text: '&amp;lt;not a tag&amp;gt;' }));
    expect((await c.getTweet('123'))?.text).toBe('&lt;not a tag&gt;');
  });

  it('keeps the id X reports, not the one that was asked for', async () => {
    // A retweet id can redirect to the original; trust the response.
    const { client: c } = client(json({ ...REAL_RESPONSE, id_str: '999' }));
    expect((await c.getTweet('123'))?.id).toBe('999');
  });

  it('survives a response with no counts', async () => {
    const { client: c } = client(
      json({ text: 'hi', user: { screen_name: 'a' }, created_at: '2026-01-01T00:00:00.000Z' })
    );
    const tweet = await c.getTweet('123');
    expect(tweet).toMatchObject({ likeCount: null, replyCount: null, media: [] });
  });
});
