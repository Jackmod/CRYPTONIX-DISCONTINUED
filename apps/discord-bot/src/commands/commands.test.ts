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
  return {
    editReply,
    interaction: {
      guildId: options.guildId === undefined ? 'g1' : options.guildId,
      channelId: 'current-channel',
      user: { id: 'user1' },
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
