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

    // The engine's snapshot predates the kick, so the row reappearing here is
    // expected; the engine row is deleted separately on GuildDelete.
    expect(cache.entries().map((e) => e.guildId)).toContain('g-kicked');
  });
});
