import { describe, it, expect, vi } from 'vitest';
import { statusCommand } from './status';
import { EngineError } from '../engine/client';

const HEALTHY = { ok: true, features: { coinScanner: true, tweetMonitor: false } };

function fakeInteraction({
  guildId = 'g1',
  channelPermissions = ['ViewChannel', 'SendMessages', 'EmbedLinks'],
  channelMissing = false,
}: { guildId?: string | null; channelPermissions?: string[]; channelMissing?: boolean } = {}) {
  const editReply = vi.fn();
  const channel = channelMissing
    ? null
    : {
        isTextBased: () => true,
        isThread: () => false,
        // discord.js compares against PermissionFlagsBits; the fake maps the
        // bit back to a readable name so a test can list what it grants.
        permissionsFor: () => ({
          has: (flag: bigint) => channelPermissions.includes(NAMES[String(flag)] ?? ''),
        }),
      };

  return {
    editReply,
    interaction: {
      guildId,
      deferReply: vi.fn(),
      editReply,
      guild: {
        channels: { fetch: vi.fn().mockResolvedValue(channel) },
        members: { me: {} },
      },
    } as never,
  };
}

/** The three flags describeChannelProblem checks, by their bit value. */
const NAMES: Record<string, string> = {
  '1024': 'ViewChannel',
  '2048': 'SendMessages',
  '16384': 'EmbedLinks',
  '274877906944': 'SendMessagesInThreads',
};

function deps(over: { health?: unknown; channelId?: string | null } = {}) {
  const engine = {
    getHealth:
      over.health instanceof Error
        ? vi.fn().mockRejectedValue(over.health)
        : vi.fn().mockResolvedValue(over.health ?? HEALTHY),
  } as never;
  const guildConfigs = {
    get: vi.fn().mockReturnValue(over.channelId === undefined ? '900000000000000011' : over.channelId),
  } as never;
  return { engine, guildConfigs };
}

function embedOf(editReply: ReturnType<typeof vi.fn>) {
  return editReply.mock.calls[0][0].embeds[0].toJSON() as {
    description: string;
    footer: { text: string };
    color: number;
  };
}

describe('/status', () => {
  it('reports a healthy server as working', async () => {
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps());

    const embed = embedOf(editReply);
    expect(embed.description).toContain('Alerts go to <#900000000000000011>');
    expect(embed.description).toContain('Engine reachable');
    expect(embed.footer.text).toBe('Everything checks out.');
  });

  it('names which monitors are running, so silence can be explained', async () => {
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps());

    const embed = embedOf(editReply);
    expect(embed.description).toContain('New-coin scanner: **on**');
    expect(embed.description).toContain('Tweet monitor: **off**');
  });

  it('says the server never ran /setup, which is the commonest cause of silence', async () => {
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps({ channelId: null }));

    const embed = embedOf(editReply);
    expect(embed.description).toContain('Not set up here');
    expect(embed.footer.text).toBe('Something above needs attention.');
  });

  it('catches permissions revoked AFTER setup, which nothing else announces', async () => {
    const { interaction, editReply } = fakeInteraction({ channelPermissions: ['ViewChannel'] });
    await statusCommand.execute(interaction, deps());

    const embed = embedOf(editReply);
    expect(embed.description).toContain('Cannot post there');
    expect(embed.description).toContain('Send Messages');
    expect(embed.footer.text).toBe('Something above needs attention.');
  });

  it('reports a deleted channel', async () => {
    const { interaction, editReply } = fakeInteraction({ channelMissing: true });
    await statusCommand.execute(interaction, deps());

    expect(embedOf(editReply).description).toContain('Cannot post there');
  });

  it('says the engine is unreachable rather than blaming the server', async () => {
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps({ health: new EngineError('down', 0) }));

    const embed = embedOf(editReply);
    expect(embed.description).toContain('Engine unreachable');
    expect(embed.footer.text).toBe('Something above needs attention.');
  });

  it('names a key mismatch specifically, since the fix is different', async () => {
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps({ health: new EngineError('unauthorized', 401) }));

    expect(embedOf(editReply).description).toContain('ENGINE_API_KEY');
  });

  it('treats an engine too old to answer /health as working, not broken', async () => {
    // Everything else about it works; saying "unreachable" would send someone
    // to check a URL and a key that are both fine.
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps({ health: new EngineError('not found', 404) }));

    const embed = embedOf(editReply);
    expect(embed.description).toContain('Engine reachable');
    expect(embed.footer.text).toBe('Everything checks out.');
  });

  it('survives an engine that answers without a features block', async () => {
    const { interaction, editReply } = fakeInteraction();
    await statusCommand.execute(interaction, deps({ health: { ok: true } }));

    const embed = embedOf(editReply);
    expect(embed.description).toContain('Engine reachable');
    expect(embed.description).not.toContain('undefined');
  });

  it('refuses a DM, where there is no server to report on', async () => {
    const { interaction, editReply } = fakeInteraction({ guildId: null });
    await statusCommand.execute(interaction, deps());

    expect(String(editReply.mock.calls[0][0])).toContain('only works inside a server');
  });

  it('needs no Manage Server, because anyone can wonder why it is quiet', () => {
    const json = statusCommand.data.toJSON() as { default_member_permissions?: string | null };
    expect(json.default_member_permissions ?? null).toBeNull();
  });

  it('is registered as guild-only', () => {
    expect((statusCommand.data.toJSON() as { contexts?: number[] }).contexts).toEqual([0]);
  });
});
