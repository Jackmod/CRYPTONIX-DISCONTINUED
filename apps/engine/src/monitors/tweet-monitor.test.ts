import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, alerts, trackedHandles, tweets } from '@cryptonix/db';
import type { Tweet } from '@cryptonix/core';
import { TweetMonitor } from './tweet-monitor';
import { AlertBus } from '../api/alert-bus';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

function tweet(over: Partial<Tweet> = {}): Tweet {
  return {
    id: '1900000000000000002',
    authorHandle: 'ansem',
    authorName: 'Ansem',
    authorAvatarUrl: 'https://pbs.twimg.com/a.jpg',
    text: 'gm',
    media: [],
    postedAt: '2026-09-01T10:00:00.000Z',
    likeCount: 5,
    replyCount: 1,
    url: 'https://x.com/ansem/status/1900000000000000002',
    ...over,
  };
}

function buildMonitor(...pages: Tweet[][]) {
  const alertBus = new AlertBus();
  const published: { payload: unknown }[] = [];
  alertBus.on('alert', (a) => published.push(a));

  let call = 0;
  const source = {
    name: 'fake',
    fetchNewTweets: vi.fn(async () => pages[Math.min(call++, pages.length - 1)] ?? []),
  };

  return { monitor: new TweetMonitor(db, source, alertBus), source, published };
}

async function track(handle: string, lastTweetId: string | null = null) {
  await db.insert(trackedHandles).values({ handle, lastTweetId });
}

beforeEach(async () => {
  await db.execute('TRUNCATE alerts, tweets, tracked_handles RESTART IDENTITY CASCADE');
});

describe('TweetMonitor', () => {
  it('does nothing when no handle is tracked', async () => {
    const { monitor, source } = buildMonitor([tweet()]);
    expect(await monitor.poll()).toBe(0);
    expect(source.fetchNewTweets).not.toHaveBeenCalled();
  });

  it('records the first poll without alerting, so following an account is quiet', async () => {
    // Otherwise adding a handle fires its whole back catalogue into every
    // configured server at once.
    await track('ansem');
    const { monitor, published } = buildMonitor([tweet({ id: '1' }), tweet({ id: '2' })]);

    expect(await monitor.poll()).toBe(0);
    expect(published).toEqual([]);

    const stored = await db.select().from(tweets);
    expect(stored).toHaveLength(2);
    expect(stored.every((t) => t.alerted)).toBe(true);
  });

  it('alerts on tweets that arrive after the first poll', async () => {
    await track('ansem', '1900000000000000001');
    const { monitor, published } = buildMonitor([tweet({ id: '1900000000000000002' })]);

    expect(await monitor.poll()).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0].payload).toMatchObject({
      tweetId: '1900000000000000002',
      authorHandle: 'ansem',
      authorName: 'Ansem',
      text: 'gm',
      url: 'https://x.com/ansem/status/1900000000000000002',
    });
  });

  it('passes the stored watermark to the source so it fetches only what is new', async () => {
    await track('ansem', '1900000000000000001');
    const { monitor, source } = buildMonitor([]);
    await monitor.poll();

    const [handles, sinceIds] = source.fetchNewTweets.mock.calls[0] as [string[], Map<string, string>];
    expect(handles).toEqual(['ansem']);
    expect(sinceIds.get('ansem')).toBe('1900000000000000001');
  });

  it('leaves a first-time handle out of the since map entirely', async () => {
    await track('ansem');
    const { monitor, source } = buildMonitor([]);
    await monitor.poll();

    const [, sinceIds] = source.fetchNewTweets.mock.calls[0] as [string[], Map<string, string>];
    expect(sinceIds.has('ansem')).toBe(false);
  });

  it('never alerts the same tweet twice, even when a poll returns it again', async () => {
    await track('ansem', '1');
    const { monitor, published } = buildMonitor([tweet({ id: '5' })], [tweet({ id: '5' })]);

    expect(await monitor.poll()).toBe(1);
    expect(await monitor.poll()).toBe(0);
    expect(published).toHaveLength(1);
  });

  it('survives a restart without re-posting, because the tweet row is the memory', async () => {
    await track('ansem', '1');
    const first = buildMonitor([tweet({ id: '5' })]);
    await first.monitor.poll();

    // A brand new monitor, as after a process restart.
    const second = buildMonitor([tweet({ id: '5' })]);
    expect(await second.monitor.poll()).toBe(0);
    expect(second.published).toEqual([]);
  });

  it('moves the watermark to the newest tweet it saw', async () => {
    await track('ansem', '1');
    const { monitor } = buildMonitor([tweet({ id: '7' }), tweet({ id: '9' }), tweet({ id: '8' })]);
    await monitor.poll();

    const [row] = await db.select().from(trackedHandles);
    expect(row.lastTweetId).toBe('9');
  });

  it('never walks the watermark backwards', async () => {
    // Two overlapping polls, or a provider returning an older page, would
    // otherwise re-alert everything in between.
    await track('ansem', '1900000000000000009');
    const { monitor } = buildMonitor([tweet({ id: '1900000000000000005' })]);
    await monitor.poll();

    const [row] = await db.select().from(trackedHandles);
    expect(row.lastTweetId).toBe('1900000000000000009');
  });

  it('compares ids by length first, so a longer id counts as newer', async () => {
    await track('ansem', '9999999999999999999');
    const { monitor } = buildMonitor([tweet({ id: '10000000000000000000' })]);
    await monitor.poll();

    const [row] = await db.select().from(trackedHandles);
    expect(row.lastTweetId).toBe('10000000000000000000');
  });

  it('posts a burst oldest first, not backwards', async () => {
    await track('ansem', '1');
    const { monitor, published } = buildMonitor([tweet({ id: '9' }), tweet({ id: '7' }), tweet({ id: '8' })]);
    await monitor.poll();

    expect(published.map((p) => (p.payload as { tweetId: string }).tweetId)).toEqual(['7', '8', '9']);
  });

  it('writes a durable alert row so the bot can replay it', async () => {
    await track('ansem', '1');
    const { monitor } = buildMonitor([tweet({ id: '5' })]);
    await monitor.poll();

    const rows = await db.select().from(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('tweet');
  });

  it('marks the stored tweet alerted once it has been published', async () => {
    await track('ansem', '1');
    const { monitor } = buildMonitor([tweet({ id: '5' })]);
    await monitor.poll();

    const [row] = await db.select().from(tweets);
    expect(row.alerted).toBe(true);
  });

  it('carries the first image, which is all a Discord embed can show', async () => {
    await track('ansem', '1');
    const { monitor, published } = buildMonitor([
      tweet({
        id: '5',
        media: [
          { type: 'photo', url: 'https://pbs/1.jpg' },
          { type: 'photo', url: 'https://pbs/2.jpg' },
        ],
      }),
    ]);
    await monitor.poll();

    expect((published[0].payload as { mediaUrl: string }).mediaUrl).toBe('https://pbs/1.jpg');
  });

  it('reports no image rather than an empty string when a tweet has none', async () => {
    await track('ansem', '1');
    const { monitor, published } = buildMonitor([tweet({ id: '5', media: [] })]);
    await monitor.poll();

    expect((published[0].payload as { mediaUrl: string | null }).mediaUrl).toBeNull();
  });

  it('handles two tracked accounts in one poll, keeping their watermarks apart', async () => {
    await track('ansem', '1');
    await track('cobie', '1');
    const { monitor } = buildMonitor([
      tweet({ id: '5', authorHandle: 'ansem' }),
      tweet({ id: '8', authorHandle: 'cobie' }),
    ]);
    await monitor.poll();

    const rows = await db.select().from(trackedHandles);
    expect(rows.find((r) => r.handle === 'ansem')?.lastTweetId).toBe('5');
    expect(rows.find((r) => r.handle === 'cobie')?.lastTweetId).toBe('8');
  });

  it('lowercases the handle it stores, so casing cannot split one account in two', async () => {
    await track('ansem', '1');
    const { monitor, published } = buildMonitor([tweet({ id: '5', authorHandle: 'Ansem' })]);
    await monitor.poll();

    expect((published[0].payload as { authorHandle: string }).authorHandle).toBe('ansem');
    const [row] = await db.select().from(tweets);
    expect(row.handle).toBe('ansem');
  });
});
