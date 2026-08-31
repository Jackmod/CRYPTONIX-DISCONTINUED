import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { describeError, type BotCommand } from './types.js';

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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, { engine, guildConfigs }) {
    await interaction.deferReply();

    if (!interaction.guildId) {
      await interaction.editReply('⚠️ `/setup` only works inside a server, not in a DM.');
      return;
    }

    // No channel argument means "here" — the common case is typing /setup in
    // the channel you want and nothing else.
    const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;

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
