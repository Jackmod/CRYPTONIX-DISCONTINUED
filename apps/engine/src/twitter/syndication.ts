import { buildTweetUrl, type Tweet, type TweetMedia } from '@cryptonix/core';

/**
 * Reads a single tweet from X's own embed CDN.
 *
 * This is the endpoint behind every embedded tweet on the web — the one
 * Vercel's `react-tweet` uses. It needs no key, no account and no API tier,
 * and it returns exactly the fields spec §5.2's tweet card asks for: author
 * name, handle, real avatar, text, media, timestamp.
 *
 * What it CANNOT do is discovery. It answers "what is tweet 123", never "what
 * has this handle posted". Finding new tweets is the part that still needs a
 * paid provider (see ./source.ts). Keeping the two apart means everything
 * except discovery works with no credentials at all.
 *
 * Measured behaviour, 2026-09-01 — each of these is handled below:
 *  - `token` is REQUIRED but its value is arbitrary. Omitting it returns
 *    HTTP 200 with a body of `{}`, which is the nastiest failure here: a
 *    success status carrying no data.
 *  - A tweet that does not exist answers 404 with an HTML body, not JSON.
 *  - A non-numeric id answers 400 with `{"error":"Bad request."}`.
 *  - Twenty rapid requests drew no rate limiting; it is CDN-backed and built
 *    for embed volume.
 */

const BASE_URL = 'https://cdn.syndication.twimg.com/tweet-result';
const REQUEST_TIMEOUT_MS = 10_000;

/** Shape of the fields this reads. Everything else in the response is ignored. */
interface SyndicationResponse {
  __typename?: string;
  id_str?: string;
  text?: string;
  created_at?: string;
  favorite_count?: number;
  conversation_count?: number;
  user?: {
    name?: string;
    screen_name?: string;
    profile_image_url_https?: string;
  };
  mediaDetails?: { type?: string; media_url_https?: string }[];
}

export class SyndicationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SyndicationError';
  }
}

export interface SyndicationClientOptions {
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class SyndicationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SyndicationClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * The tweet, or null when it does not exist (deleted, private, or never
   * real).
   *
   * Null rather than throwing for a missing tweet, because that is an
   * ordinary outcome — accounts delete things — and it must not be retried.
   * A transport failure or a 5xx does throw, because that one is worth
   * retrying.
   */
  async getTweet(tweetId: string): Promise<Tweet | null> {
    // A token is required, and any value works. It is not a credential; the
    // endpoint simply refuses to answer without the parameter present.
    const url = `${BASE_URL}?id=${encodeURIComponent(tweetId)}&token=${tokenFor(tweetId)}&lang=en`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new SyndicationError(`could not reach X's embed CDN: ${(err as Error).message}`, 0);
    }

    // 404 is a deleted or protected tweet, and answers in HTML rather than
    // JSON — so this must come before any parse attempt.
    if (res.status === 404) return null;
    if (res.status === 400) return null;
    if (!res.ok) {
      throw new SyndicationError(`X's embed CDN answered ${res.status}`, res.status);
    }

    let body: SyndicationResponse;
    try {
      body = (await res.json()) as SyndicationResponse;
    } catch {
      throw new SyndicationError('X’s embed CDN returned a body that is not JSON', res.status);
    }

    return toTweet(body, tweetId);
  }
}

/**
 * Any non-empty value satisfies the endpoint, so this derives a stable one
 * from the id rather than sending a constant.
 *
 * Stable so the same tweet always produces the same URL, which is what lets a
 * CDN or an HTTP cache in front of this do its job.
 */
function tokenFor(tweetId: string): string {
  let hash = 0;
  for (let i = 0; i < tweetId.length; i++) {
    hash = (hash * 31 + tweetId.charCodeAt(i)) % 0xffffffff;
  }
  return hash.toString(36);
}

/** Null when the response is missing the fields a tweet card cannot do without. */
function toTweet(body: SyndicationResponse, requestedId: string): Tweet | null {
  // The `{}` case: HTTP 200, no data. Checking the status alone would hand a
  // card full of "undefined" to a live channel.
  const handle = body.user?.screen_name;
  if (typeof body.text !== 'string' || typeof handle !== 'string') return null;

  const id = typeof body.id_str === 'string' ? body.id_str : requestedId;

  return {
    id,
    authorHandle: handle,
    // A display name can genuinely be absent; the handle always identifies.
    authorName: typeof body.user?.name === 'string' ? body.user.name : handle,
    authorAvatarUrl: typeof body.user?.profile_image_url_https === 'string'
      ? body.user.profile_image_url_https
      : null,
    text: decodeEntities(body.text),
    media: toMedia(body.mediaDetails),
    postedAt: typeof body.created_at === 'string' ? body.created_at : new Date().toISOString(),
    likeCount: typeof body.favorite_count === 'number' ? body.favorite_count : null,
    replyCount: typeof body.conversation_count === 'number' ? body.conversation_count : null,
    url: buildTweetUrl(handle, id),
  };
}

/**
 * The endpoint returns HTML-escaped text.
 *
 * A real response carries `&lt;iframe&gt;` where the tweet said `<iframe>`,
 * because this data is meant to be dropped into an embed's markup. Both of
 * our surfaces render text, not HTML, so leaving it escaped shows the entities
 * to the reader.
 *
 * `&amp;` is decoded LAST on purpose: doing it first would turn a literal
 * `&amp;lt;` into `&lt;` and then into `<`, inventing markup the tweet never
 * contained.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const MEDIA_TYPES = new Set(['photo', 'video', 'animated_gif']);

function toMedia(details: SyndicationResponse['mediaDetails']): TweetMedia[] {
  if (!Array.isArray(details)) return [];
  const media: TweetMedia[] = [];
  for (const item of details) {
    // An unrecognised type is skipped rather than guessed at: a card showing
    // the wrong kind of attachment is worse than one showing none.
    if (typeof item?.media_url_https !== 'string') continue;
    if (typeof item.type !== 'string' || !MEDIA_TYPES.has(item.type)) continue;
    media.push({ type: item.type as TweetMedia['type'], url: item.media_url_https });
  }
  return media;
}
