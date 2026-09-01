import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { normalizeHandle } from '@cryptonix/core';
import { describeError, escapeInline, inlineCode, shortAddress, type BotCommand } from './types.js';

export const trackCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track a Solana wallet or an X account')
    .addSubcommand((sub) =>
      sub
        .setName('wallet')
        .setDescription('Track a Solana wallet address')
        .addStringOption((opt) => opt.setName('address').setDescription('Solana wallet address').setRequired(true))
        .addStringOption((opt) => opt.setName('label').setDescription('A name for this wallet'))
        .addBooleanOption((opt) => opt.setName('mine').setDescription('Is this your own wallet?'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('twitter')
        .setDescription('Follow an X account and post its tweets here')
        .addStringOption((opt) =>
          opt.setName('handle').setDescription('@handle, or a link to the profile').setRequired(true)
        )
    )
    // Tracking consumes one of the Helius free tier's webhook address slots
    // and starts a backfill against a shared quota, and the wallet becomes
    // visible in every server the bot is in. Not a per-member action.
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // Discord ignores default_member_permissions in DMs, and commands are
    // DM-enabled by default -- so without this the permission gate above was
    // bypassable by anyone who simply DMed the bot.
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, { engine }) {
    if (interaction.options.getSubcommand() === 'twitter') {
      await trackTwitter(interaction, engine);
      return;
    }

    // Registering a webhook and kicking off a backfill can outrun Discord's
    // 3-second interaction deadline, so acknowledge first.
    await interaction.deferReply();

    // Defence in depth: setContexts keeps this out of DMs, but a command
    // registered before that change could still arrive from one, and Discord
    // enforces no permission gate there.
    if (!interaction.guildId) {
      await interaction.editReply('⚠️ This command only works inside a server, not in a DM.');
      return;
    }

    const address = interaction.options.getString('address', true);
    // The engine answers 400 when label is missing, so never send an empty one.
    const label = interaction.options.getString('label') ?? shortAddress(address);
    const isMine = interaction.options.getBoolean('mine') ?? false;

    try {
      const wallet = await engine.trackWallet(address, label, isMine);
      await interaction.editReply(
        `✅ Tracking **${escapeInline(wallet.label)}** (${inlineCode(shortAddress(wallet.address))}). ` +
          'Historical backfill has started.'
      );
    } catch (err) {
      // 409 means the engine already tracks this address. That is a normal
      // outcome of typing the same command twice, not a failure worth an
      // alarming error message.
      if ((err as { status?: number }).status === 409) {
        await interaction.editReply(`ℹ️ ${inlineCode(shortAddress(address))} is already tracked.`);
        return;
      }
      await interaction.editReply(describeError(err));
    }
  },
};

/**
 * Follows an X account.
 *
 * The handle is normalised before it is sent, so the reply can name what will
 * actually be stored: '@Ansem', 'ansem' and a pasted profile URL all become
 * the same row, and telling the user otherwise would be a small lie about
 * what just happened.
 */
async function trackTwitter(
  interaction: Parameters<BotCommand['execute']>[0],
  engine: Parameters<BotCommand['execute']>[1]['engine']
): Promise<void> {
  await interaction.deferReply();

  if (!interaction.guildId) {
    await interaction.editReply('⚠️ This command only works inside a server, not in a DM.');
    return;
  }

  const input = interaction.options.getString('handle', true);
  const handle = normalizeHandle(input);
  if (handle === null) {
    await interaction.editReply(`⚠️ ${inlineCode(input)} is not an X handle.`);
    return;
  }

  try {
    await engine.trackHandle(handle);
    await interaction.editReply(
      `✅ Following **@${handle}**. New tweets will be posted here. Tweets from before now are ` +
        'recorded but not posted, so following an account is quiet.'
    );
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      await interaction.editReply(`ℹ️ **@${handle}** is already tracked.`);
      return;
    }
    await interaction.editReply(describeError(err));
  }
}
