import type { Tweet } from '@cryptonix/core';

/**
 * Finding out that a tracked handle has posted.
 *
 * The one part of Twitter monitoring that cannot be done for free. X's free
 * API tier is write-only, Nitter was served cease-and-desist letters on
 * 2026-08-24 and its repository archived, and every surviving public RSS
 * bridge is a third party doing the same scraping under the same pressure —
 * checked on 2026-09-01, none of them answered.
 *
 * So discovery sits behind this interface, alone, and everything else in the
 * feature works without it: the tweet card, the Discord embed, the Calls tab
 * and the alert pipeline all run off `Tweet`, which the free embed CDN can
 * produce (see ./syndication.ts). Swapping provider — or pointing this at
 * Telegram or Bluesky, both of which are genuinely free — is one file.
 */
export interface TweetSource {
  /** Human-readable, for logs and the "which provider" line in Settings. */
  readonly name: string;

  /**
   * Tweets from these handles newer than the ids given.
   *
   * `sinceIds` maps a handle to the newest tweet id already recorded for it.
   * A handle absent from the map has never been polled, and an implementation
   * should return only its most recent page rather than its whole history —
   * backfilling years of tweets into a live channel is not what tracking a
   * new handle should do.
   */
  fetchNewTweets(handles: string[], sinceIds: Map<string, string>): Promise<Tweet[]>;
}

/**
 * Compares two tweet ids.
 *
 * Ids are snowflakes: 64-bit, ordered by time, and past the range a JavaScript
 * number holds exactly — `Number('1683920951807971329')` loses the last
 * digits, so two tweets seconds apart can compare equal. Length first, then
 * lexicographically, which is correct for unsigned decimal strings.
 */
export function isNewerTweetId(candidate: string, than: string): boolean {
  if (candidate.length !== than.length) return candidate.length > than.length;
  return candidate > than;
}
