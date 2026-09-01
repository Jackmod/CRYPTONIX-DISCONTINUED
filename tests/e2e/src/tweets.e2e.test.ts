import { describe, it, expect, afterEach } from 'vitest';
import { startStack, waitFor, authHeaders, type E2EStack } from './harness.js';
import { TweetMonitor, SyndicationClient } from '@cryptonix/engine';
import type { Tweet } from '@cryptonix/core';

let stack: E2EStack;

afterEach(async () => {
  await stack?.close();
  stack = undefined as unknown as E2EStack;
});

function tweet(over: Partial<Tweet> = {}): Tweet {
  return {
    id: '1900000000000000002',
    authorHandle: 'ansem',
    authorName: 'Ansem',
    authorAvatarUrl: 'https://pbs.twimg.com/a.jpg',
    text: 'sending it',
    media: [],
    postedAt: '2026-09-01T10:00:00.000Z',
    likeCount: 5,
    replyCount: 1,
    url: 'https://x.com/ansem/status/1900000000000000002',
    ...over,
  };
}

/** A TweetSource whose pages the test controls. */
function fakeSource(pages: Tweet[][]) {
  let call = 0;
  return { name: 'e2e', fetchNewTweets: async () => pages[Math.min(call++, pages.length - 1)] ?? [] };
}

async function postHandle(baseUrl: string, handle: string): Promise<Response> {
  return fetch(`${baseUrl}/handles`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
}

describe('end-to-end: a tweet reaches Discord', () => {
  it('carries a tweet from the monitor all the way to a rendered card', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();

    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011', 'user1');
    await stack.guildConfigs.load();
    await postHandle(stack.baseUrl, '@Ansem');

    const monitor = new TweetMonitor(
      stack.db,
      fakeSource([[tweet({ id: '1' })], [tweet({ id: '2', text: 'the new one' })]]),
      stack.alertBus
    );

    await new Promise((r) => setTimeout(r, 150));

    // The first poll records history without announcing it.
    expect(await monitor.poll()).toBe(0);
    expect(stack.posted).toHaveLength(0);

    // The next one is genuinely new.
    expect(await monitor.poll()).toBe(1);
    await waitFor(() => stack.posted.length === 1);

    const { channelId, message } = stack.posted[0];
    expect(channelId).toBe('900000000000000011');

    const payload = message as {
      embeds: { toJSON(): { description?: string; author?: { name: string } } }[];
      components: unknown[];
    };
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toBe('the new one');
    expect(embed.author?.name).toBe('Ansem (@ansem)');
    expect(payload.components).toHaveLength(1);
  });

  it('stores a handle the app and the bot both read, however it was typed', async () => {
    stack = await startStack();

    for (const handle of ['@Ansem', 'https://x.com/ansem', 'ANSEM']) {
      await postHandle(stack.baseUrl, handle);
    }

    const res = await fetch(`${stack.baseUrl}/handles`, { headers: authHeaders() });
    const handles = (await res.json()) as { handle: string }[];
    // One account, not three.
    expect(handles.map((h) => h.handle)).toEqual(['ansem']);
  });

  it('serves stored tweets to the Calls tab, newest first', async () => {
    stack = await startStack();
    await postHandle(stack.baseUrl, 'ansem');

    const monitor = new TweetMonitor(
      stack.db,
      fakeSource([
        [
          tweet({ id: '1', postedAt: '2026-08-01T00:00:00.000Z', text: 'older' }),
          tweet({ id: '2', postedAt: '2026-09-01T00:00:00.000Z', text: 'newer' }),
        ],
      ]),
      stack.alertBus
    );
    await monitor.poll();

    const res = await fetch(`${stack.baseUrl}/tweets`, { headers: authHeaders() });
    const rows = (await res.json()) as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual(['newer', 'older']);
  });

  it('untracking a handle removes its tweets so nothing can replay them', async () => {
    stack = await startStack();
    const created = await postHandle(stack.baseUrl, 'ansem');
    const { id } = (await created.json()) as { id: number };

    const monitor = new TweetMonitor(stack.db, fakeSource([[tweet({ id: '1' })]]), stack.alertBus);
    await monitor.poll();

    await fetch(`${stack.baseUrl}/handles/${id}`, { method: 'DELETE', headers: authHeaders() });

    const tweetsRes = await fetch(`${stack.baseUrl}/tweets`, { headers: authHeaders() });
    expect(await tweetsRes.json()).toEqual([]);
    const alertsRes = await fetch(`${stack.baseUrl}/alerts?since=0`, { headers: authHeaders() });
    expect(await alertsRes.json()).toEqual([]);
  });

  it('never posts the same tweet twice, across a restart of the monitor', async () => {
    stack = await startStack();
    stack.startBotAlertPipeline();
    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011', 'user1');
    await stack.guildConfigs.load();
    await postHandle(stack.baseUrl, 'ansem');

    await new Promise((r) => setTimeout(r, 150));

    const first = new TweetMonitor(
      stack.db,
      fakeSource([[tweet({ id: '1' })], [tweet({ id: '9' })]]),
      stack.alertBus
    );
    await first.poll();
    expect(await first.poll()).toBe(1);
    await waitFor(() => stack.posted.length === 1);

    // A brand new monitor, as after a process restart, seeing the same page.
    const second = new TweetMonitor(stack.db, fakeSource([[tweet({ id: '9' })]]), stack.alertBus);
    expect(await second.poll()).toBe(0);

    await new Promise((r) => setTimeout(r, 150));
    expect(stack.posted).toHaveLength(1);
  });

  it('defuses a masked link before it reaches a channel', async () => {
    // A tracked account getting compromised is the realistic case, and an
    // embed description renders masked links.
    stack = await startStack();
    stack.startBotAlertPipeline();
    await stack.engine.setGuildConfig('111111111111111111', '900000000000000011', 'user1');
    await stack.guildConfigs.load();
    await postHandle(stack.baseUrl, 'ansem');

    await new Promise((r) => setTimeout(r, 150));

    const monitor = new TweetMonitor(
      stack.db,
      fakeSource([
        [tweet({ id: '1' })],
        [tweet({ id: '2', text: '[Claim your airdrop](https://evil.example)' })],
      ]),
      stack.alertBus
    );
    await monitor.poll();
    await monitor.poll();
    await waitFor(() => stack.posted.length === 1);

    const payload = stack.posted[0].message as { embeds: { toJSON(): { description?: string } }[] };
    expect(payload.embeds[0].toJSON().description).toBe('\\[Claim your airdrop](https://evil.example)');
  });

  it('renders a REAL tweet from the free embed CDN, with no key involved', async () => {
    // The half of this feature that costs nothing. If this breaks, X changed
    // the embed endpoint and the Calls tab loses its pictures.
    const real = await new SyndicationClient().getTweet('1683920951807971329');

    expect(real).not.toBeNull();
    expect(real!.authorHandle).toBe('vercel');
    expect(real!.authorAvatarUrl).toMatch(/^https:\/\/pbs\.twimg\.com\//);
    // Entities decoded: the endpoint escapes text for embed markup.
    expect(real!.text).toContain('<iframe>');
    expect(real!.text).not.toContain('&lt;');
  }, 30_000);
});
