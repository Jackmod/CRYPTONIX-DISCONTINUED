import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { GuildTextBasedChannel } from 'discord.js';
import { describeError, type BotCommand } from './types.js';

/**
 * Returns a message describing why the bot cannot post in `channelId`, or
 * null when it can.
 */
async function describeChannelProblem(
  interaction: Parameters<BotCommand['execute']>[0],
  channelId: string
): Promise<string | null> {
  const channel = await interaction.guild?.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return `⚠️ <#${channelId}> is not a text channel I can post in.`;
  }

  const me = interaction.guild?.members.me;
  if (!me) return null; // cannot tell; do not block on a transient gap

  const permissions = (channel as GuildTextBasedChannel).permissionsFor(me);

  // Posting into a thread needs SendMessagesInThreads; SendMessages on the
  // parent is not enough. Checking only the latter let /setup confirm success
  // for a thread whose alerts then failed silently — the exact
  // misconfiguration this check exists to catch.
  const sendPermission = channel.isThread()
    ? { flag: PermissionFlagsBits.SendMessagesInThreads, label: 'Send Messages in Threads' }
    : { flag: PermissionFlagsBits.SendMessages, label: 'Send Messages' };

  const missing = [
    permissions?.has(PermissionFlagsBits.ViewChannel) ? null : 'View Channel',
    permissions?.has(sendPermission.flag) ? null : sendPermission.label,
    permissions?.has(PermissionFlagsBits.EmbedLinks) ? null : 'Embed Links',
  ].filter(Boolean);

  if (missing.length > 0) {
    return `⚠️ I am missing **${missing.join('**, **')}** in <#${channelId}>. Grant those and run \`/setup\` again.`;
  }
  return null;
}

export const setupCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Choose which channel Cryptonix posts alerts to in this server')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Defaults to the channel you run this in')
        .addChannelTypes(ChannelType.GuildText)
    )
    // Without this gate any member could redirect the whole server's alert feed.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // Discord ignores default_member_permissions in DMs; the handler also
    // checks guildId, but this keeps the command out of DMs entirely.
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, { engine, guildConfigs }) {
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply('⚠️ `/setup` only works inside a server, not in a DM.');
      return;
    }

    // No channel argument means "here" — the common case is typing /setup in
    // the channel you want and nothing else.
    const chosen = interaction.options.getChannel('channel');
    const channelId = chosen?.id ?? interaction.channelId;

    // Confirming success for a channel the bot cannot post in sends the user
    // away believing it is configured, while every alert fails silently into
    // the bot host's console. Check before promising anything.
    const problem = await describeChannelProblem(interaction, channelId);
    if (problem) {
      await interaction.editReply(problem);
      return;
    }

    try {
      await engine.setGuildConfig(interaction.guildId, channelId, interaction.user.id);
      // Only after the engine has stored it. A cache entry the engine never
      // saw would work until the next restart and then vanish.
      guildConfigs.set(interaction.guildId, channelId);
      await interaction.editReply(`✅ Cryptonix will post alerts to <#${channelId}> in this server.`);
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
