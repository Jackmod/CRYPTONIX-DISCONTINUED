import { describe, it, expect, vi } from 'vitest';
import { trackCommand } from './track';
import { untrackCommand, handleChoices } from './untrack';
import { EngineError } from '../engine/client';

function fakeInteraction(options: Record<string, string | null>, subcommand = 'twitter', guildId: string | null = 'g1') {
  const editReply = vi.fn();
  return {
    editReply,
    interaction: {
      guildId,
      deferReply: vi.fn(),
      editReply,
      options: {
        getSubcommand: () => subcommand,
        getString: (name: string) => options[name] ?? null,
        getBoolean: () => null,
      },
    } as never,
  };
}

function reply(editReply: ReturnType<typeof vi.fn>): string {
  const arg = editReply.mock.calls[0][0];
  return String(typeof arg === 'string' ? arg : arg.content ?? '');
}

describe('/track twitter', () => {
  it('follows a handle', async () => {
    const engine = { trackHandle: vi.fn().mockResolvedValue({ id: 1, handle: 'ansem' }) } as never;
    const { interaction, editReply } = fakeInteraction({ handle: '@ansem' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect((engine as { trackHandle: ReturnType<typeof vi.fn> }).trackHandle).toHaveBeenCalledWith('ansem');
    expect(reply(editReply)).toContain('@ansem');
  });

  it('names what will actually be stored, not what was typed', async () => {
    // '@Ansem', 'ansem' and a profile URL are one row; saying otherwise would
    // be a small lie about what just happened.
    const engine = { trackHandle: vi.fn().mockResolvedValue({}) } as never;
    const { interaction } = fakeInteraction({ handle: 'https://x.com/Ansem' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect((engine as { trackHandle: ReturnType<typeof vi.fn> }).trackHandle).toHaveBeenCalledWith('ansem');
  });

  it('says following is quiet, because the first poll does not alert', async () => {
    const engine = { trackHandle: vi.fn().mockResolvedValue({}) } as never;
    const { interaction, editReply } = fakeInteraction({ handle: 'ansem' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(reply(editReply)).toMatch(/not posted|quiet/i);
  });

  it('refuses something that is not a handle before calling the engine', async () => {
    const engine = { trackHandle: vi.fn() } as never;
    const { interaction, editReply } = fakeInteraction({ handle: 'not a handle' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect((engine as { trackHandle: ReturnType<typeof vi.fn> }).trackHandle).not.toHaveBeenCalled();
    expect(reply(editReply)).toContain('not an X handle');
  });

  it('strips backticks from what it echoes back into a code span', async () => {
    const engine = { trackHandle: vi.fn() } as never;
    const { interaction, editReply } = fakeInteraction({ handle: '`hax`' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(reply(editReply)).toBe('⚠️ `hax` is not an X handle.');
  });

  it('treats an already-tracked handle as normal, not as a failure', async () => {
    const engine = { trackHandle: vi.fn().mockRejectedValue(new EngineError('already tracked', 409)) } as never;
    const { interaction, editReply } = fakeInteraction({ handle: 'ansem' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(reply(editReply)).toContain('already tracked');
    expect(reply(editReply)).not.toContain('⚠️');
  });

  it('refuses a DM, where no server permission gate applies', async () => {
    const engine = { trackHandle: vi.fn() } as never;
    const { interaction, editReply } = fakeInteraction({ handle: 'ansem' }, 'twitter', null);

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(reply(editReply)).toContain('only works inside a server');
    expect((engine as { trackHandle: ReturnType<typeof vi.fn> }).trackHandle).not.toHaveBeenCalled();
  });

  it('is registered with both subcommands', () => {
    const json = trackCommand.data.toJSON() as { options?: { name: string }[] };
    expect(json.options?.map((o) => o.name)).toEqual(['wallet', 'twitter']);
  });
});

describe('/untrack twitter', () => {
  it('resolves the handle to an id and removes it', async () => {
    const engine = {
      listHandles: vi.fn().mockResolvedValue([{ id: 7, handle: 'ansem' }]),
      untrackHandle: vi.fn().mockResolvedValue(undefined),
    } as never;
    const { interaction, editReply } = fakeInteraction({ handle: '@Ansem' });

    await untrackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect((engine as { untrackHandle: ReturnType<typeof vi.fn> }).untrackHandle).toHaveBeenCalledWith(7);
    expect(reply(editReply)).toContain('@ansem');
  });

  it('says so plainly when the handle is not tracked', async () => {
    const engine = { listHandles: vi.fn().mockResolvedValue([]), untrackHandle: vi.fn() } as never;
    const { interaction, editReply } = fakeInteraction({ handle: 'ansem' });

    await untrackCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(reply(editReply)).toContain('not tracked');
    expect((engine as { untrackHandle: ReturnType<typeof vi.fn> }).untrackHandle).not.toHaveBeenCalled();
  });

  it('suggests tracked handles', async () => {
    const engine = { listHandles: vi.fn().mockResolvedValue([{ id: 1, handle: 'ansem' }]) } as never;
    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      options: { getSubcommand: () => 'twitter', getFocused: () => 'ans' },
      respond,
    } as never;

    await untrackCommand.autocomplete!(interaction, { engine, guildConfigs: {} as never });

    expect(respond).toHaveBeenCalledWith([{ name: '@ansem', value: 'ansem' }]);
  });

  it('still suggests wallets on the wallet subcommand', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([
        { id: 1, address: 'ADDR', label: 'whale', isMine: false },
      ]),
      listHandles: vi.fn(),
    } as never;
    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      options: { getSubcommand: () => 'wallet', getFocused: () => '' },
      respond,
    } as never;

    await untrackCommand.autocomplete!(interaction, { engine, guildConfigs: {} as never });

    expect(respond).toHaveBeenCalledWith([expect.objectContaining({ value: 'ADDR' })]);
    expect((engine as { listHandles: ReturnType<typeof vi.fn> }).listHandles).not.toHaveBeenCalled();
  });
});

describe('handleChoices', () => {
  const rows = [{ handle: 'ansem' }, { handle: 'cobie' }];

  it('offers everything when nothing has been typed', () => {
    expect(handleChoices(rows, '')).toHaveLength(2);
  });

  it('matches on part of a handle, ignoring a leading at sign', () => {
    expect(handleChoices(rows, '@ans')).toEqual([{ name: '@ansem', value: 'ansem' }]);
  });

  it('is case-insensitive, like handles themselves', () => {
    expect(handleChoices(rows, 'ANS')).toHaveLength(1);
  });

  it('never exceeds the 25 Discord allows', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ handle: `user${i}` }));
    expect(handleChoices(many, '')).toHaveLength(25);
  });

  it('returns nothing when nothing matches, rather than everything', () => {
    expect(handleChoices(rows, 'zzz')).toEqual([]);
  });
});
