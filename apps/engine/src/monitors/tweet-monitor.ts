import { sql } from 'drizzle-orm';
import { alerts, trackedHandles, tweets, type Db } from '@cryptonix/db';
import type { Tweet } from '@cryptonix/core';
import type { AlertBus } from '../api/alert-bus.js';
import { isNewerTweetId, type TweetSource } from '../twitter/source.js';

/** Field-for-field what the Discord tweet embed and the desktop card read. */
export interface TweetAlertPayload {
  tweetId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  mediaUrl: string | null;
  postedAt: string;
  url: string;
}

/**
 * Watches tracked handles and turns new tweets into alerts.
 *
 * Shares only the alert bus with the rest of the engine, exactly like the coin
 * scanner (spec §9): a provider outage, an expired key or an empty balance
 * stops tweets and cannot touch wallet monitoring.
 *
 * Two rules make this safe to point at a live channel:
 *
 * 1. **The first poll of a handle never alerts.** Its recent tweets are
 *    recorded so the Calls tab has something to show immediately, but they are
 *    stored already-alerted. Otherwise following a new account would fire a
 *    page of its back catalogue into every configured server at once.
 * 2. **A tweet is remembered before it is published.** The row is written
 *    first, so a crash between the two costs one missed alert rather than a
 *    duplicate on every restart — the same ordering the coin scanner uses.
 */
export class TweetMonitor {
  constructor(
    private readonly db: Db,
    private readonly source: TweetSource,
    private readonly alertBus: AlertBus
  ) {}

  /** Returns how many alerts were published. */
  async poll(): Promise<number> {
    const handles = await this.db.select().from(trackedHandles);
    if (handles.length === 0) return 0;

    const sinceIds = new Map<string, string>();
    const firstTime = new Set<string>();
    for (const row of handles) {
      if (row.lastTweetId === null) firstTime.add(row.handle);
      else sinceIds.set(row.handle, row.lastTweetId);
    }

    const fetched = await this.source.fetchNewTweets(
      handles.map((h) => h.handle),
      sinceIds
    );
    if (fetched.length === 0) return 0;

    // Oldest first, so a burst reaches a channel in the order it was written
    // rather than backwards.
    const ordered = [...fetched].sort((a, b) => (isNewerTweetId(a.id, b.id) ? 1 : -1));

    let published = 0;
    const newestByHandle = new Map<string, string>();

    for (const tweet of ordered) {
      const handle = tweet.authorHandle.toLowerCase();
      const previous = newestByHandle.get(handle);
      if (previous === undefined || isNewerTweetId(tweet.id, previous)) {
        newestByHandle.set(handle, tweet.id);
      }

      const alertThis = !firstTime.has(handle);
      const stored = await this.remember(tweet, handle, alertThis);
      // Already in the table: a poll returned it again, or another process
      // beat us to it. Either way it has been dealt with.
      if (!stored) continue;

      if (alertThis) {
        await this.publish(tweet, handle);
        published++;
      }
    }

    await this.advanceWatermarks(newestByHandle);
    return published;
  }

  /**
   * Writes the tweet, and reports whether this call is the one that created it.
   *
   * `DO NOTHING` rather than an upsert: a tweet's text does not change, and
   * re-writing it would reset `alerted` and re-publish everything the next
   * time a poll returned the same page.
   */
  private async remember(tweet: Tweet, handle: string, willAlert: boolean): Promise<boolean> {
    const inserted = await this.db
      .insert(tweets)
      .values({
        id: tweet.id,
        handle,
        authorName: tweet.authorName,
        authorAvatarUrl: tweet.authorAvatarUrl,
        text: tweet.text,
        media: tweet.media,
        url: tweet.url,
        likeCount: tweet.likeCount,
        replyCount: tweet.replyCount,
        // A first poll records history without announcing it.
        alerted: !willAlert,
        postedAt: new Date(tweet.postedAt),
      })
      .onConflictDoNothing()
      .returning({ id: tweets.id });

    return inserted.length > 0;
  }

  private async publish(tweet: Tweet, handle: string): Promise<void> {
    const payload: TweetAlertPayload = {
      tweetId: tweet.id,
      authorHandle: handle,
      authorName: tweet.authorName,
      authorAvatarUrl: tweet.authorAvatarUrl,
      text: tweet.text,
      // One image: a Discord embed shows a single picture, and the desktop
      // card follows it so both surfaces agree.
      mediaUrl: tweet.media[0]?.url ?? null,
      postedAt: tweet.postedAt,
      url: tweet.url,
    };

    // Written before publishing, so the alert has a durable id and the bot's
    // replay can recover it when nothing is listening.
    const [alert] = await this.db
      .insert(alerts)
      .values({ type: 'tweet', refId: 0, payload })
      .returning();

    await this.db.update(tweets).set({ alerted: true }).where(sql`${tweets.id} = ${tweet.id}`);
    this.alertBus.publish({ id: alert.id, type: alert.type, refId: alert.refId, payload: alert.payload });
  }

  /**
   * Moves each handle's watermark to the newest id seen.
   *
   * Guarded so it only ever moves forward: two polls overlapping, or a
   * provider returning an older page, must not walk it backwards and re-alert
   * everything in between.
   */
  private async advanceWatermarks(newestByHandle: Map<string, string>): Promise<void> {
    for (const [handle, newestId] of newestByHandle) {
      await this.db
        .update(trackedHandles)
        .set({ lastTweetId: newestId })
        .where(
          sql`${trackedHandles.handle} = ${handle} AND (
            ${trackedHandles.lastTweetId} IS NULL
            OR length(${trackedHandles.lastTweetId}) < length(${newestId})
            OR (length(${trackedHandles.lastTweetId}) = length(${newestId})
                AND ${trackedHandles.lastTweetId} < ${newestId})
          )`
        );
    }
  }
}
