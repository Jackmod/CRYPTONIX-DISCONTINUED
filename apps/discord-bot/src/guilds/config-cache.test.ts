import { describe, it, expect, vi } from 'vitest';
import { GuildConfigCache } from './config-cache';

describe('GuildConfigCache', () => {
  it('loads existing configs from the engine', async () => {
    const engine = {
      listGuildConfigs: vi.fn().mockResolvedValue([
        { guildId: 'g1', alertChannelId: 'c1' },
        { guildId: 'g2', alertChannelId: 'c2' },
      ]),
    } as any;
    const cache = new GuildConfigCache(engine);

    await cache.load();

    expect(cache.entries()).toHaveLength(2);
  });

  it('reflects a /setup without waiting for a reload', () => {
    const cache = new GuildConfigCache({ listGuildConfigs: vi.fn() } as any);

    cache.set('g1', 'c1');

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: 'c1' }]);
  });

  it('overwrites a guild rather than duplicating it', () => {
    const cache = new GuildConfigCache({ listGuildConfigs: vi.fn() } as any);

    cache.set('g1', 'c1');
    cache.set('g1', 'c2');

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: 'c2' }]);
  });

  it('drops a guild on remove', () => {
    const cache = new GuildConfigCache({ listGuildConfigs: vi.fn() } as any);
    cache.set('g1', 'c1');

    cache.remove('g1');

    expect(cache.entries()).toHaveLength(0);
  });

  it('survives the engine being down at startup', async () => {
    // The bot must still log in and serve /setup when the engine is not up
    // yet; an empty routing table is recoverable, a crash loop is not.
    const engine = { listGuildConfigs: vi.fn().mockRejectedValue(new Error('engine unreachable')) } as any;
    const cache = new GuildConfigCache(engine);

    // load() reports failure rather than throwing, so the caller can retry.
    await expect(cache.load()).resolves.toBe(false);
    expect(cache.entries()).toHaveLength(0);
    expect(cache.isLoaded).toBe(false);
  });

  it('keeps retrying until a load succeeds', async () => {
    // A single failed load at startup used to leave the routing table empty
    // for the life of the process: alerts kept arriving and fanning out to
    // nobody, with no error and no recovery short of a restart.
    const listGuildConfigs = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockRejectedValueOnce(new Error('engine still down'))
      .mockResolvedValueOnce([{ guildId: 'g1', alertChannelId: 'c1' }]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    await cache.loadUntilSuccessful(0, async () => {});

    expect(listGuildConfigs).toHaveBeenCalledTimes(3);
    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: 'c1' }]);
    expect(cache.isLoaded).toBe(true);
  });

  it('does not drop a /setup that lands while a load is in flight', async () => {
    // load() replaces the whole map. A /setup arriving between the request
    // going out and the response coming back would be overwritten by the
    // older snapshot: the engine would report the guild configured while the
    // bot posted nothing there until a restart.
    let releaseLoad: (value: any) => void = () => {};
    const listGuildConfigs = vi.fn().mockReturnValue(new Promise((resolve) => (releaseLoad = resolve)));
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    const loading = cache.load();
    cache.set('g-new', 'c-new'); // /setup runs mid-flight
    releaseLoad([{ guildId: 'g-old', alertChannelId: 'c-old' }]);
    await loading;

    const byGuild = Object.fromEntries(cache.entries().map((e) => [e.guildId, e.alertChannelId]));
    expect(byGuild['g-old']).toBe('c-old');
    expect(byGuild['g-new']).toBe('c-new');
  });

  it('does not resurrect a guild removed while a load was in flight', async () => {
    let releaseLoad: (value: any) => void = () => {};
    const listGuildConfigs = vi.fn().mockReturnValue(new Promise((resolve) => (releaseLoad = resolve)));
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    const loading = cache.load();
    cache.remove('g-kicked'); // bot kicked mid-flight
    releaseLoad([{ guildId: 'g-kicked', alertChannelId: 'c1' }]);
    await loading;

    // The engine's snapshot predates the kick, so without a tombstone the
    // guild came back and stayed in the routing table for the life of the
    // process — one failed channels.fetch per alert, forever.
    expect(cache.entries().map((e) => e.guildId)).not.toContain('g-kicked');
  });

  it('keeps a removal recorded during a FAILED load until one succeeds', async () => {
    // The retry loop is exactly when this matters: engine down, bot kicked
    // from a guild, the fire-and-forget deleteGuildConfig also fails. If the
    // failed attempt dropped the tombstone, the next successful load would
    // see the guild still present in the engine and restore it permanently.
    const listGuildConfigs = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce([{ guildId: 'g-kicked', alertChannelId: '900000000000000001' }]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    const first = cache.load();
    cache.remove('g-kicked'); // kicked while the failing attempt is in flight
    await first;

    await cache.load(); // the retry succeeds, engine still lists the guild

    expect(cache.entries().map((e) => e.guildId)).not.toContain('g-kicked');
  });

  it('forgets pending changes once a load has applied them', async () => {
    const listGuildConfigs = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ guildId: 'g1', alertChannelId: '900000000000000009' }]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    const loading = cache.load();
    cache.remove('g1');
    await loading;

    // A later load must reflect the engine again, not replay that removal.
    await cache.load();

    expect(cache.entries().map((e) => e.guildId)).toContain('g1');
  });
});

describe('GuildConfigCache: changes made between retry attempts', () => {
  // loadUntilSuccessful spends most of an outage asleep between attempts,
  // with no request in flight. A change made in that window is just as
  // unreflected by the engine's next snapshot as one made mid-request.

  it('does not lose a /setup made between a failed attempt and the next', async () => {
    const listGuildConfigs = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce([]); // engine has not seen the /setup yet
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    await cache.load(); // fails, nothing in flight afterwards
    cache.set('g1', '900000000000000001'); // /setup lands in the gap
    await cache.load(); // retry succeeds with a snapshot that predates it

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: '900000000000000001' }]);
  });

  it('does not resurrect a guild kicked between attempts', async () => {
    const listGuildConfigs = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce([{ guildId: 'g-kicked', alertChannelId: '900000000000000001' }]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    await cache.load();
    cache.remove('g-kicked'); // kicked in the gap
    await cache.load();

    expect(cache.entries().map((e) => e.guildId)).not.toContain('g-kicked');
  });

  it('lets a later /setup cancel a tombstone from an earlier attempt', async () => {
    // Kicked, then re-invited and set up again, all during one outage. The
    // most recent local intent must win.
    const listGuildConfigs = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce([]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    const failing = cache.load();
    cache.remove('g1');
    await failing;
    cache.set('g1', '900000000000000002'); // re-added in the gap
    await cache.load();

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: '900000000000000002' }]);
  });

  it('lets a later kick cancel a write from an earlier attempt', async () => {
    const listGuildConfigs = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockResolvedValueOnce([{ guildId: 'g1', alertChannelId: '900000000000000009' }]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    const failing = cache.load();
    cache.set('g1', '900000000000000001');
    await failing;
    cache.remove('g1'); // kicked in the gap
    await cache.load();

    expect(cache.entries().map((e) => e.guildId)).not.toContain('g1');
  });

  it('applies the most recent of several changes to the same guild', async () => {
    const listGuildConfigs = vi.fn().mockResolvedValue([]);
    const cache = new GuildConfigCache({ listGuildConfigs } as any);

    cache.set('g1', '900000000000000001');
    cache.set('g1', '900000000000000002');
    cache.set('g1', '900000000000000003');
    await cache.load();

    expect(cache.entries()).toEqual([{ guildId: 'g1', alertChannelId: '900000000000000003' }]);
  });
});
