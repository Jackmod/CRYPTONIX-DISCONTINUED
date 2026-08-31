import { describe, it, expect, vi } from 'vitest';
import { trackCommand } from './track';
import { untrackCommand } from './untrack';
import { pnlCommand } from './pnl';
import { setupCommand } from './setup';
import { EngineError } from '../engine/client';

function fakeInteraction(options: Record<string, string | boolean | null>) {
  const editReply = vi.fn();
  return {
    editReply,
    interaction: {
      // Every command is guild-only and refuses an interaction without one.
      guildId: 'g1',
      options: {
        getSubcommand: () => 'wallet',
        getString: (name: string) => (options[name] as string) ?? null,
        getBoolean: (name: string) => (options[name] as boolean) ?? null,
      },
      deferReply: vi.fn(),
      editReply,
    } as any,
  };
}

describe('/track wallet', () => {
  it('tracks the address and confirms with the label', async () => {
    const engine = { trackWallet: vi.fn().mockResolvedValue({ id: 1, address: 'Addr1', label: 'Whale' }) } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Addr1', label: 'Whale', mine: false });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.trackWallet).toHaveBeenCalledWith('Addr1', 'Whale', false);
    expect(String(editReply.mock.calls[0][0].content ?? editReply.mock.calls[0][0])).toContain('Whale');
  });

  it('falls back to a shortened address when no label is given', async () => {
    // The engine answers 400 for a missing label, so the bot must supply one.
    const engine = { trackWallet: vi.fn().mockResolvedValue({ id: 1, address: 'A'.repeat(44), label: 'x' }) } as any;
    const { interaction } = fakeInteraction({ address: 'A'.repeat(44), label: null });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as any });

    const [, label] = engine.trackWallet.mock.calls[0];
    expect(label).toBeTruthy();
    expect(label.length).toBeLessThan(44);
  });

  it('says "already tracked" rather than raising an error on 409', async () => {
    // Typing the same /track twice is ordinary use, not a failure.
    const engine = { trackWallet: vi.fn().mockRejectedValue(new EngineError('wallet is already tracked', 409)) } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Addr1', label: 'Whale' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as any });

    const reply = String(editReply.mock.calls[0][0]);
    expect(reply).toContain('already tracked');
    expect(reply).not.toContain('⚠️');
  });

  it('reports an engine outage in plain language', async () => {
    const engine = { trackWallet: vi.fn().mockRejectedValue(new EngineError('engine unreachable', 0)) } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Addr1', label: 'Whale' });

    await trackCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('engine');
  });
});

describe('/untrack wallet', () => {
  it('resolves the address to an id before deleting', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([{ id: 4, address: 'Addr1', label: 'Whale' }]),
      untrackWallet: vi.fn().mockResolvedValue(undefined),
    } as any;
    const { interaction } = fakeInteraction({ address: 'Addr1' });

    await untrackCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.untrackWallet).toHaveBeenCalledWith(4);
  });

  it('says so when the address is not tracked', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), untrackWallet: vi.fn() } as any;
    const { interaction, editReply } = fakeInteraction({ address: 'Missing' });

    await untrackCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.untrackWallet).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('not tracked');
  });
});

describe('/pnl', () => {
  it('defaults to the is-mine wallet and the current month', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([
        { id: 1, address: 'Other', label: 'Whale', isMine: false },
        { id: 2, address: 'Mine', label: 'Me', isMine: true },
      ]),
      getPnl: vi.fn().mockResolvedValue([]),
    } as any;
    const { interaction, editReply } = fakeInteraction({ wallet: null, month: null });

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.getPnl).toHaveBeenCalledWith(2);
    const embed = editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toContain(new Date().toISOString().slice(0, 7));
  });

  it('matches the wallet argument against label or address', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([{ id: 9, address: 'Addr9', label: 'Whale', isMine: false }]),
      getPnl: vi.fn().mockResolvedValue([]),
    } as any;
    const { interaction } = fakeInteraction({ wallet: 'Whale', month: '2026-08' });

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.getPnl).toHaveBeenCalledWith(9);
  });

  it('rejects a malformed month instead of rendering a broken calendar', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), getPnl: vi.fn() } as any;
    const { interaction, editReply } = fakeInteraction({ wallet: null, month: 'August' });

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.getPnl).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('YYYY-MM');
  });

  it('explains when no wallet is tracked yet', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), getPnl: vi.fn() } as any;
    const { interaction, editReply } = fakeInteraction({ wallet: null, month: null });

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('/track');
  });
});

function fakeGuildInteraction(options: { channel?: string | null; guildId?: string | null }) {
  const editReply = vi.fn();
  // /setup now verifies it can actually post in the chosen channel before
  // confirming, so the fixture needs a guild whose channel grants that.
  const permissive = { has: () => true };
  const channel = { id: options.channel ?? 'current-channel', isTextBased: () => true, permissionsFor: () => permissive };
  return {
    editReply,
    interaction: {
      guildId: options.guildId === undefined ? 'g1' : options.guildId,
      channelId: 'current-channel',
      user: { id: 'user1' },
      guild: {
        channels: { fetch: vi.fn().mockResolvedValue(channel) },
        members: { me: {} },
      },
      options: {
        getChannel: () => (options.channel ? { id: options.channel } : null),
      },
      deferReply: vi.fn(),
      editReply,
    } as any,
  };
}

describe('/setup', () => {
  it('stores the named channel for this guild', async () => {
    const engine = { setGuildConfig: vi.fn().mockResolvedValue({ guildId: 'g1', alertChannelId: 'chosen' }) } as any;
    const guildConfigs = { set: vi.fn() } as any;
    const { interaction } = fakeGuildInteraction({ channel: 'chosen' });

    await setupCommand.execute(interaction, { engine, guildConfigs });

    expect(engine.setGuildConfig).toHaveBeenCalledWith('g1', 'chosen', 'user1');
    expect(guildConfigs.set).toHaveBeenCalledWith('g1', 'chosen');
  });

  it('defaults to the channel the command was run in', async () => {
    // The whole point of "auto setup": typing /setup with no arguments in the
    // channel you want alerts in should just work.
    const engine = { setGuildConfig: vi.fn().mockResolvedValue({}) } as any;
    const { interaction } = fakeGuildInteraction({ channel: null });

    await setupCommand.execute(interaction, { engine, guildConfigs: { set: vi.fn() } as any });

    expect(engine.setGuildConfig).toHaveBeenCalledWith('g1', 'current-channel', 'user1');
  });

  it('refuses to run outside a server', async () => {
    const engine = { setGuildConfig: vi.fn() } as any;
    const { interaction, editReply } = fakeGuildInteraction({ channel: null, guildId: null });

    await setupCommand.execute(interaction, { engine, guildConfigs: { set: vi.fn() } as any });

    expect(engine.setGuildConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('server');
  });

  it('does not update the cache when the engine write fails', async () => {
    // A cache entry the engine never stored would work until the next restart
    // and then silently disappear - the worst kind of bug to diagnose.
    const engine = { setGuildConfig: vi.fn().mockRejectedValue(new EngineError('engine unreachable', 0)) } as any;
    const guildConfigs = { set: vi.fn() } as any;
    const { interaction, editReply } = fakeGuildInteraction({ channel: 'chosen' });

    await setupCommand.execute(interaction, { engine, guildConfigs });

    expect(guildConfigs.set).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('engine');
  });
});

describe('command permissions', () => {
  it('gates every command that changes shared state behind Manage Server', () => {
    // The wallet list is shared by every server the bot is in. /untrack
    // deletes wallet_trades and pnl_daily rows that live delivery cannot
    // rebuild, so an unprivileged member of any one guild could destroy every
    // other guild's history. /track consumes a Helius address slot.
    for (const command of [setupCommand, trackCommand, untrackCommand]) {
      const json = command.data.toJSON() as { default_member_permissions?: string | null };
      expect(json.default_member_permissions, `${command.data.name} must be gated`).toBeTruthy();
    }
  });

  it('leaves the read-only /pnl open to everyone', () => {
    const json = pnlCommand.data.toJSON() as { default_member_permissions?: string | null };
    expect(json.default_member_permissions ?? null).toBeNull();
  });
});

describe('/pnl month validation', () => {
  it.each(['2026-00', '2026-13', '2026-99', 'August', '26-08', '2026-8'])(
    'rejects %s rather than rendering a blank grid',
    async (month) => {
      const engine = { listWallets: vi.fn(), getPnl: vi.fn() } as any;
      const { interaction, editReply } = fakeInteraction({ wallet: null, month });

      await pnlCommand.execute(interaction, { engine, guildConfigs: {} as any });

      expect(engine.listWallets).not.toHaveBeenCalled();
      expect(JSON.stringify(editReply.mock.calls[0][0])).toContain('YYYY-MM');
    }
  );

  it.each(['2026-01', '2026-08', '2026-12'])('accepts %s', async (month) => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), getPnl: vi.fn() } as any;
    const { interaction } = fakeInteraction({ wallet: null, month });

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as any });

    expect(engine.listWallets).toHaveBeenCalled();
  });
});

describe('DM safety', () => {
  it('registers every command as guild-only', () => {
    // Discord ignores default_member_permissions in DMs and commands are
    // DM-enabled by default, so the permission gates were bypassable by
    // anyone who simply DMed the bot. InteractionContextType.Guild is 0.
    for (const command of [setupCommand, trackCommand, untrackCommand, pnlCommand]) {
      const json = command.data.toJSON() as { contexts?: number[] | null };
      expect(json.contexts, `${command.data.name} must be guild-only`).toEqual([0]);
    }
  });

  it('refuses to act on an interaction with no guild', async () => {
    // Defence in depth: a command registered before the contexts change could
    // still arrive from a DM.
    const engine = { trackWallet: vi.fn(), untrackWallet: vi.fn(), listWallets: vi.fn(), getPnl: vi.fn() } as any;

    for (const command of [trackCommand, untrackCommand, pnlCommand]) {
      const editReply = vi.fn();
      const interaction = {
        guildId: null,
        options: { getSubcommand: () => 'wallet', getString: () => 'x', getBoolean: () => null },
        deferReply: vi.fn(),
        editReply,
      } as any;

      await command.execute(interaction, { engine, guildConfigs: {} as any });

      expect(String(editReply.mock.calls[0][0]), `${command.data.name} must refuse a DM`).toContain('server');
    }

    expect(engine.trackWallet).not.toHaveBeenCalled();
    expect(engine.untrackWallet).not.toHaveBeenCalled();
    expect(engine.listWallets).not.toHaveBeenCalled();
  });
});

describe('/setup channel checks', () => {
  function guildInteractionWithChannel(permissionsFor: () => { has: (p: unknown) => boolean } | null) {
    const editReply = vi.fn();
    const channel = { id: 'chosen', isTextBased: () => true, permissionsFor };
    return {
      editReply,
      interaction: {
        guildId: 'g1',
        channelId: 'chosen',
        user: { id: 'u1' },
        guild: {
          channels: { fetch: vi.fn().mockResolvedValue(channel) },
          members: { me: {} },
        },
        options: { getChannel: () => null },
        deferReply: vi.fn(),
        editReply,
      } as any,
    };
  }

  it('refuses a channel the bot cannot post in, and stores nothing', async () => {
    // Confirming success for an unusable channel sends the user away believing
    // it works while every alert fails silently into the host's console.
    const engine = { setGuildConfig: vi.fn() } as any;
    const guildConfigs = { set: vi.fn() } as any;
    const { interaction, editReply } = guildInteractionWithChannel(() => ({ has: () => false }));

    await setupCommand.execute(interaction, { engine, guildConfigs });

    expect(engine.setGuildConfig).not.toHaveBeenCalled();
    expect(guildConfigs.set).not.toHaveBeenCalled();
    expect(String(editReply.mock.calls[0][0])).toContain('Send Messages');
  });

  it('stores the config when the bot has the permissions it needs', async () => {
    const engine = { setGuildConfig: vi.fn().mockResolvedValue({}) } as any;
    const guildConfigs = { set: vi.fn() } as any;
    const { interaction } = guildInteractionWithChannel(() => ({ has: () => true }));

    await setupCommand.execute(interaction, { engine, guildConfigs });

    expect(engine.setGuildConfig).toHaveBeenCalledWith('g1', 'chosen', 'u1');
    expect(guildConfigs.set).toHaveBeenCalledWith('g1', 'chosen');
  });
});
