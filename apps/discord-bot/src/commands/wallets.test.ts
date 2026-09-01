import { describe, it, expect, vi } from 'vitest';
import { buildWalletsEmbed, walletsCommand } from './wallets';
import { untrackCommand } from './untrack';
import { pnlCommand } from './pnl';
import { walletChoices, MAX_CHOICES } from './types';
import { EngineError } from '../engine/client';
import type { Wallet } from '../engine/client';

function wallet(over: Partial<Wallet> = {}): Wallet {
  return {
    id: 1,
    address: 'AAAA1111111111111111111111111111111111111111',
    label: 'whale',
    isMine: false,
    heliusWebhookId: null,
    backfillStatus: 'done',
    addedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as Wallet;
}

function fakeInteraction(guildId: string | null = 'g1') {
  const editReply = vi.fn();
  return {
    editReply,
    interaction: { guildId, deferReply: vi.fn(), editReply } as never,
  };
}

function fakeAutocomplete(focused: string) {
  const respond = vi.fn().mockResolvedValue(undefined);
  return {
    respond,
    interaction: { options: { getFocused: () => focused }, respond } as never,
  };
}

describe('walletChoices', () => {
  it('offers every wallet when nothing has been typed', () => {
    const choices = walletChoices([wallet({ label: 'a' }), wallet({ label: 'b', address: 'B' })], '');
    expect(choices).toHaveLength(2);
  });

  it('always returns the address as the value, since that is what commands resolve', () => {
    const choices = walletChoices([wallet({ label: 'whale', address: 'ADDR' })], 'wha');
    expect(choices[0].value).toBe('ADDR');
  });

  it('matches on part of a label, case-insensitively', () => {
    const rows = [wallet({ label: 'Bonk Whale' }), wallet({ label: 'jito', address: 'B' })];
    expect(walletChoices(rows, 'bonk')).toHaveLength(1);
    expect(walletChoices(rows, 'WHALE')).toHaveLength(1);
  });

  it('matches on part of an address, which is the whole point', () => {
    const rows = [wallet({ address: 'So11111111111111111111111111111111111111112' })];
    expect(walletChoices(rows, 'So111')).toHaveLength(1);
  });

  it('puts your own wallets first', () => {
    const rows = [wallet({ label: 'aaa' }), wallet({ label: 'zzz', address: 'B', isMine: true })];
    expect(walletChoices(rows, '')[0].value).toBe('B');
  });

  it('marks your own wallet in the label', () => {
    expect(walletChoices([wallet({ isMine: true })], '')[0].name).toContain('(yours)');
  });

  it('never exceeds the 25 Discord allows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => wallet({ label: `w${i}`, address: `A${i}` }));
    expect(walletChoices(rows, '')).toHaveLength(MAX_CHOICES);
  });

  it('clamps a name Discord would reject for being over 100 characters', () => {
    const choices = walletChoices([wallet({ label: 'x'.repeat(300) })], '');
    expect(choices[0].name.length).toBeLessThanOrEqual(100);
  });

  it('returns nothing when nothing matches, rather than everything', () => {
    expect(walletChoices([wallet({ label: 'whale' })], 'zzzz')).toEqual([]);
  });
});

describe('/untrack autocomplete', () => {
  it('suggests tracked wallets', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([wallet({ address: 'ADDR' })]) } as never;
    const { interaction, respond } = fakeAutocomplete('wha');

    await untrackCommand.autocomplete!(interaction, { engine, guildConfigs: {} as never });

    expect(respond).toHaveBeenCalledWith([expect.objectContaining({ value: 'ADDR' })]);
  });

  it('answers with an empty list when the engine is down, rather than hanging', async () => {
    const engine = { listWallets: vi.fn().mockRejectedValue(new EngineError('down', 0)) } as never;
    const { interaction, respond } = fakeAutocomplete('');

    await untrackCommand.autocomplete!(interaction, { engine, guildConfigs: {} as never });

    expect(respond).toHaveBeenCalledWith([]);
  });
});

describe('/pnl wallet matching', () => {
  it('finds a wallet whose label differs only in case', async () => {
    const engine = {
      listWallets: vi.fn().mockResolvedValue([wallet({ id: 7, label: 'Bonk Whale' })]),
      getPnl: vi.fn().mockResolvedValue([]),
    } as never;
    const editReply = vi.fn();
    const interaction = {
      guildId: 'g1',
      deferReply: vi.fn(),
      editReply,
      options: { getString: (name: string) => (name === 'wallet' ? 'bonk whale' : null) },
    } as never;

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect((engine as unknown as { getPnl: ReturnType<typeof vi.fn> }).getPnl).toHaveBeenCalledWith(7);
  });

  it('strips backticks out of a query echoed back into a code span', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([]), getPnl: vi.fn() } as never;
    const editReply = vi.fn();
    const interaction = {
      guildId: 'g1',
      deferReply: vi.fn(),
      editReply,
      options: { getString: (name: string) => (name === 'wallet' ? '`hax`' : null) },
    } as never;

    await pnlCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(String(editReply.mock.calls[0][0])).toBe('⚠️ No tracked wallet matches `hax`.');
  });

  it('offers suggestions too', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([wallet({ address: 'ADDR' })]) } as never;
    const { interaction, respond } = fakeAutocomplete('');

    await pnlCommand.autocomplete!(interaction, { engine, guildConfigs: {} as never });

    expect(respond).toHaveBeenCalledWith([expect.objectContaining({ value: 'ADDR' })]);
  });
});

describe('buildWalletsEmbed', () => {
  it('says nothing is tracked, and how to fix that', () => {
    const embed = buildWalletsEmbed([]).toJSON();
    expect(embed.description).toContain('/track wallet');
  });

  it('lists every wallet with a shortened address', () => {
    const embed = buildWalletsEmbed([wallet({ label: 'whale' })]).toJSON();
    expect(embed.description).toContain('whale');
    expect(embed.description).toContain('AAAA…1111');
    // Never the full 44 characters: the list is meant to be scannable.
    expect(embed.description).not.toContain('AAAA1111111111111111111111111111111111111111');
  });

  it('puts your own wallets first and marks them', () => {
    const embed = buildWalletsEmbed([
      wallet({ label: 'aaa' }),
      wallet({ label: 'zzz', address: 'B', isMine: true }),
    ]).toJSON();
    expect(embed.description!.indexOf('zzz')).toBeLessThan(embed.description!.indexOf('aaa'));
    expect(embed.description).toContain('★');
  });

  it('shows a backfill still in progress, and stays quiet when it is done', () => {
    expect(buildWalletsEmbed([wallet({ backfillStatus: 'running' })]).toJSON().description).toContain('running');
    expect(buildWalletsEmbed([wallet({ backfillStatus: 'done' })]).toJSON().description).not.toContain('done');
  });

  it('neutralises markdown in a label, which is free text from whoever tracked it', () => {
    const embed = buildWalletsEmbed([wallet({ label: '**pwned** `x`' })]).toJSON();
    expect(embed.description).toContain('\\*\\*pwned\\*\\*');
    expect(embed.description).not.toContain('**pwned**');
  });

  it('stays inside the description limit on a very long list', () => {
    const rows = Array.from({ length: 500 }, (_, i) => wallet({ label: `wallet-${i}`, address: `A${i}` }));
    const embed = buildWalletsEmbed(rows).toJSON();
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toContain('more');
  });

  it('counts every wallet in the footer, not just the listed ones', () => {
    const rows = Array.from({ length: 60 }, (_, i) => wallet({ label: `w${i}`, address: `A${i}` }));
    expect(buildWalletsEmbed(rows).toJSON().footer!.text).toContain('60 wallets');
  });
});

describe('/wallets', () => {
  it('replies with the list', async () => {
    const engine = { listWallets: vi.fn().mockResolvedValue([wallet()]) } as never;
    const { interaction, editReply } = fakeInteraction();

    await walletsCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(editReply.mock.calls[0][0].embeds).toHaveLength(1);
  });

  it('reports an unreachable engine rather than failing silently', async () => {
    const engine = { listWallets: vi.fn().mockRejectedValue(new EngineError('down', 0)) } as never;
    const { interaction, editReply } = fakeInteraction();

    await walletsCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(String(editReply.mock.calls[0][0])).toContain('engine is unreachable');
  });

  it('refuses a DM, where no server permission gate applies', async () => {
    const engine = { listWallets: vi.fn() } as never;
    const { interaction, editReply } = fakeInteraction(null);

    await walletsCommand.execute(interaction, { engine, guildConfigs: {} as never });

    expect(String(editReply.mock.calls[0][0])).toContain('only works inside a server');
    expect((engine as unknown as { listWallets: ReturnType<typeof vi.fn> }).listWallets).not.toHaveBeenCalled();
  });

  it('is registered as guild-only', () => {
    const json = walletsCommand.data.toJSON() as { contexts?: number[] };
    expect(json.contexts).toEqual([0]);
  });
});
