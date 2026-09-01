import { describe, it, expect, vi } from 'vitest';
import { buildFollowingEmbed, followingCommand } from './following';
import { EngineError } from '../engine/client';
import type { TrackedHandle } from '../engine/client';

function handle(over: Partial<TrackedHandle> = {}): TrackedHandle {
  return { id: 1, handle: 'ansem', lastTweetId: '5', addedAt: '2026-09-01T00:00:00.000Z', ...over };
}

function fakeInteraction(guildId: string | null = 'g1') {
  const editReply = vi.fn();
  return { editReply, interaction: { guildId, deferReply: vi.fn(), editReply } as never };
}

describe('buildFollowingEmbed', () => {
  it('says nobody is followed, and how to fix that', () => {
    expect(buildFollowingEmbed([]).toJSON().description).toContain('/track twitter');
  });

  it('links every handle back to its profile', () => {
    const embed = buildFollowingEmbed([handle()]).toJSON();
    expect(embed.description).toContain('[@ansem](https://x.com/ansem)');
  });

  it('orders them alphabetically', () => {
    const embed = buildFollowingEmbed([handle({ handle: 'zeta' }), handle({ id: 2, handle: 'alpha' })]).toJSON();
    expect(embed.description!.indexOf('alpha')).toBeLessThan(embed.description!.indexOf('zeta'));
  });

  it('marks an account that has not been checked yet', () => {
    // Distinguishes "quiet" from "the monitor has never run".
    expect(buildFollowingEmbed([handle({ lastTweetId: null })]).toJSON().description).toContain('waiting');
    expect(buildFollowingEmbed([handle({ lastTweetId: '9' })]).toJSON().description).not.toContain('waiting');
  });

  it('counts every account in the footer, not just the listed ones', () => {
    const many = Array.from({ length: 90 }, (_, i) => handle({ id: i, handle: `user${i}` }));
    const embed = buildFollowingEmbed(many).toJSON();
    expect(embed.footer!.text).toContain('90 accounts');
    expect(embed.description).toContain('more');
  });

  it('stays inside the description limit on a very long list', () => {
    const many = Array.from({ length: 500 }, (_, i) => handle({ id: i, handle: `user${i}` }));
    expect(buildFollowingEmbed(many).toJSON().description!.length).toBeLessThanOrEqual(4096);
  });

  it('says "1 account", not "1 accounts"', () => {
    expect(buildFollowingEmbed([handle()]).toJSON().footer!.text).toBe('1 account');
  });
});

describe('/following', () => {
  it('replies with the list', async () => {
    const engine = { listHandles: vi.fn().mockResolvedValue([handle()]) } as never;
    const { interaction, editReply } = fakeInteraction();

    await followingCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(editReply.mock.calls[0][0].embeds).toHaveLength(1);
  });

  it('reports an unreachable engine rather than failing silently', async () => {
    const engine = { listHandles: vi.fn().mockRejectedValue(new EngineError('down', 0)) } as never;
    const { interaction, editReply } = fakeInteraction();

    await followingCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(String(editReply.mock.calls[0][0])).toContain('engine is unreachable');
  });

  it('refuses a DM, where no server permission gate applies', async () => {
    const engine = { listHandles: vi.fn() } as never;
    const { interaction, editReply } = fakeInteraction(null);

    await followingCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(String(editReply.mock.calls[0][0])).toContain('only works inside a server');
    expect((engine as unknown as { listHandles: ReturnType<typeof vi.fn> }).listHandles).not.toHaveBeenCalled();
  });

  it('is registered as guild-only', () => {
    expect((followingCommand.data.toJSON() as { contexts?: number[] }).contexts).toEqual([0]);
  });
});
