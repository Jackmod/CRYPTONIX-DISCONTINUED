import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { describeChannelProblem } from './setup.js';
import { type BotCommand } from './types.js';
import type { EngineClient } from '../engine/client.js';
import type { GuildConfigCache } from '../guilds/config-cache.js';

const PHOSPHOR = 0xffb000;
const GOOD = 0x3fb950;
const BAD = 0xf85149;

/**
 * Answers "why is nothing being posted?" in one place.
 *
 * That question has four completely different answers — this server never ran
 * `/setup`, the engine is unreachable, the monitor that would produce those
 * alerts is switched off, or the bot's permission to post was revoked after
 * setup — and all four look identical from inside Discord: silence. Guessing
 * between them is the single most likely thing to waste someone's evening.
 *
 * Read-only and it names no wallet or handle, so unlike the other commands it
 * needs no Manage Server: anyone wondering why the channel is quiet should be
 * able to ask.
 */
export const statusCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check whether Cryptonix is set up and working in this server')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, { engine, guildConfigs }) {
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply('⚠️ This command only works inside a server, not in a DM.');
      return;
    }

    const lines: string[] = [];
    let healthy = true;

    // 1. Is this server routed anywhere?
    const channelId = guildConfigs.get(interaction.guildId);
    if (!channelId) {
      healthy = false;
      lines.push('❌ **Not set up here.** Run `/setup` in the channel you want alerts in.');
    } else {
      lines.push(`✅ Alerts go to <#${channelId}>.`);

      // 2. Can it still post there? Permissions granted at setup can be taken
      //    away afterwards, and nothing announces that.
      const problem = await describeChannelProblem(interaction, channelId);
      if (problem) {
        healthy = false;
        lines.push(problem.replace(/^⚠️ /, '❌ **Cannot post there.** '));
      }
    }

    // 3. Is the engine answering, and what is it running?
    lines.push(...(await describeEngine(engine, () => (healthy = false))));

    const embed = new EmbedBuilder()
      .setColor(healthy ? GOOD : BAD)
      .setTitle('Cryptonix status')
      .setDescription(lines.join('\n'))
      .setFooter({ text: healthy ? 'Everything checks out.' : 'Something above needs attention.' })
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * The engine half of the report.
 *
 * A missing /health is called out as an old engine rather than a dead one:
 * saying "unreachable" would send someone to check a URL and a key that are
 * both fine.
 */
async function describeEngine(engine: EngineClient, markUnhealthy: () => void): Promise<string[]> {
  try {
    const health = await engine.getHealth();
    const lines = ['✅ Engine reachable.'];
    if (health.features) {
      lines.push(
        `• New-coin scanner: **${health.features.coinScanner ? 'on' : 'off'}**`,
        `• Tweet monitor: **${health.features.tweetMonitor ? 'on' : 'off'}**`
      );
    }
    return lines;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      // Not a failure worth colouring the whole report red: everything else
      // works, this engine simply predates the route.
      return ['✅ Engine reachable. *(too old to report which monitors are running)*'];
    }
    markUnhealthy();
    if (status === 401) return ['❌ **Engine rejected the bot.** `ENGINE_API_KEY` does not match.'];
    return ['❌ **Engine unreachable.** Alerts cannot arrive until it is back.'];
  }
}

/** Exported for the tests; kept beside the command it belongs to. */
export const STATUS_COLORS = { PHOSPHOR, GOOD, BAD };
