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

    await expect(cache.load()).resolves.toBeUndefined();
    expect(cache.entries()).toHaveLength(0);
  });
});
