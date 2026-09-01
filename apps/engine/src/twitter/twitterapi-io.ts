import { buildTweetUrl, type Tweet, type TweetMedia } from '@cryptonix/core';
import { isNewerTweetId, type TweetSource } from './source.js';

/**
 * Discovery through TwitterAPI.io.
 *
 * Chosen in the Phase 3 spike: $0.15 per 1,000 tweets returned, with a
 * $0.00015 floor per call, no monthly minimum, and a $1 trial credit that
 * needs no card. Roughly 33x cheaper than X's own $200/month Basic tier, which
 * caps at about 500 reads a day.
 *
 * WRITTEN AGAINST THE PUBLISHED DOCS, NOT AGAINST A LIVE KEY. Every field is
 * read defensively and anything unrecognised degrades to null rather than
 * throwing, so a response that differs from the documentation costs a field
 * and not the whole poll. The shapes to check first if something looks wrong
 * are `createdAt` (documented only by name, not format) and media, which the
 * endpoint reference does not describe at all.
 *
 * COST NOTE — polling is the expensive part, not tweets. The floor is charged
 * per call whether or not anything comes back, so polling 20 handles every
 * minute costs about $130/month while the tweets themselves cost under a
 * dollar. The provider also offers webhook filter rules
 * (`from:a OR from:b`, 255 characters per rule) which push instead, and that
 * is the shape to move to for anything more than a handful of handles.
 */

const BASE_URL = 'https://api.twitterapi.io';
const REQUEST_TIMEOUT_MS = 15_000;

export class TweetSourceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TweetSourceError';
  }
}

interface RawTweet {
  id?: unknown;
  url?: unknown;
  text?: unknown;
  createdAt?: unknown;
  likeCount?: unknown;
  replyCount?: unknown;
  author?: {
    userName?: unknown;
    name?: unknown;
    profilePicture?: unknown;
  };
  extendedEntities?: { media?: unknown };
  entities?: { media?: unknown };
}

export interface TwitterApiIoOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Requests per second. The published limit is generous; this is politeness. */
  minIntervalMs?: number;
}

export class TwitterApiIoSource implements TweetSource {
  readonly name = 'twitterapi.io';

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private nextSlot = 0;

  constructor(private readonly options: TwitterApiIoOptions) {
    if (!options.apiKey) throw new Error('TwitterApiIoSource requires an API key');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.minIntervalMs = options.minIntervalMs ?? 250;
  }

  async fetchNewTweets(handles: string[], sinceIds: Map<string, string>): Promise<Tweet[]> {
    const collected: Tweet[] = [];

    // One handle at a time, and one page each. Every call costs the floor fee
    // even when it returns nothing, so paging further back is real money spent
    // on history nobody asked for.
    for (const handle of handles) {
      let page: Tweet[];
      try {
        page = await this.fetchOneHandle(handle);
      } catch (err) {
        // One handle failing must not cost the others their tweets — a
        // suspended or renamed account would otherwise stop the whole sweep.
        console.error(`twitterapi.io: could not read @${handle}`, err);
        continue;
      }

      const since = sinceIds.get(handle);
      for (const tweet of page) {
        if (since !== undefined && !isNewerTweetId(tweet.id, since)) continue;
        collected.push(tweet);
      }
    }

    return collected;
  }

  private async fetchOneHandle(handle: string): Promise<Tweet[]> {
    await this.waitForSlot();

    const url = `${BASE_URL}/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}&includeReplies=false`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'X-API-Key': this.options.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TweetSourceError(`could not reach twitterapi.io: ${(err as Error).message}`, 0);
    }

    if (!res.ok) {
      // The key is the likeliest cause and the message must say so plainly:
      // an unpaid balance and a wrong key both surface here.
      throw new TweetSourceError(`twitterapi.io answered ${res.status}`, res.status);
    }

    const body = (await res.json().catch(() => null)) as
      | { tweets?: unknown; status?: unknown; message?: unknown }
      | null;
    if (!body) throw new TweetSourceError('twitterapi.io returned a body that is not JSON', res.status);

    // A documented `status: "error"` arrives with HTTP 200, so the status code
    // alone does not tell you the call worked.
    if (body.status === 'error') {
      throw new TweetSourceError(
        typeof body.message === 'string' ? body.message : 'twitterapi.io reported an error',
        res.status
      );
    }

    if (!Array.isArray(body.tweets)) return [];
    return body.tweets
      .map((raw) => toTweet(raw as RawTweet, handle))
      .filter((tweet): tweet is Tweet => tweet !== null);
  }

  /**
   * Spaces requests out.
   *
   * The slot is claimed synchronously before any await, so concurrent callers
   * cannot all read the same `nextSlot` and fire together — the same mistake
   * the Helius limiter had.
   */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

/** Null when a row is missing what a tweet card cannot do without. */
function toTweet(raw: RawTweet, requestedHandle: string): Tweet | null {
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' ? String(raw.id) : null;
  if (id === null || typeof raw.text !== 'string') return null;

  // The author block is documented, but a tweet read through a handle we asked
  // for can fall back to that handle rather than being dropped.
  const handle = typeof raw.author?.userName === 'string' ? raw.author.userName : requestedHandle;

  return {
    id,
    authorHandle: handle,
    authorName: typeof raw.author?.name === 'string' ? raw.author.name : handle,
    authorAvatarUrl: typeof raw.author?.profilePicture === 'string' ? raw.author.profilePicture : null,
    text: raw.text,
    media: toMedia(raw),
    postedAt: toIsoDate(raw.createdAt),
    likeCount: typeof raw.likeCount === 'number' ? raw.likeCount : null,
    replyCount: typeof raw.replyCount === 'number' ? raw.replyCount : null,
    url: typeof raw.url === 'string' ? raw.url : buildTweetUrl(handle, id),
  };
}

/**
 * The docs name `createdAt` but not its format.
 *
 * X's own APIs use 'Tue Dec 10 07:00:30 +0000 2024', which `new Date()` parses,
 * and ISO 8601 also parses — so this accepts whatever arrives and falls back to
 * now rather than emitting an Invalid Date, which throws downstream the moment
 * anything calls toISOString on it.
 */
function toIsoDate(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

const MEDIA_TYPES = new Set(['photo', 'video', 'animated_gif']);

/**
 * Media is not described in the endpoint reference at all, so this reads the
 * two shapes X's own payloads use and gives up quietly otherwise. A card with
 * no picture is a small loss; a thrown poll is not.
 */
function toMedia(raw: RawTweet): TweetMedia[] {
  const candidates = raw.extendedEntities?.media ?? raw.entities?.media;
  if (!Array.isArray(candidates)) return [];

  const media: TweetMedia[] = [];
  for (const item of candidates) {
    const entry = item as { type?: unknown; media_url_https?: unknown; media_url?: unknown };
    const url = typeof entry?.media_url_https === 'string' ? entry.media_url_https : entry?.media_url;
    if (typeof url !== 'string') continue;
    if (typeof entry.type !== 'string' || !MEDIA_TYPES.has(entry.type)) continue;
    media.push({ type: entry.type as TweetMedia['type'], url });
  }
  return media;
}
