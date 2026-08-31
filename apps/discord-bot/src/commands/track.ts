import { SlashCommandBuilder } from 'discord.js';
import { describeError, shortAddress, type BotCommand } from './types.js';

export const trackCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track a Solana wallet')
    .addSubcommand((sub) =>
      sub
        .setName('wallet')
        .setDescription('Track a Solana wallet address')
        .addStringOption((opt) => opt.setName('address').setDescription('Solana wallet address').setRequired(true))
        .addStringOption((opt) => opt.setName('label').setDescription('A name for this wallet'))
        .addBooleanOption((opt) => opt.setName('mine').setDescription('Is this your own wallet?'))
    ),

  async execute(interaction, { engine }) {
    // Registering a webhook and kicking off a backfill can outrun Discord's
    // 3-second interaction deadline, so acknowledge first.
    await interaction.deferReply();

    const address = interaction.options.getString('address', true);
    // The engine answers 400 when label is missing, so never send an empty one.
    const label = interaction.options.getString('label') ?? shortAddress(address);
    const isMine = interaction.options.getBoolean('mine') ?? false;

    try {
      const wallet = await engine.trackWallet(address, label, isMine);
      await interaction.editReply(
        `✅ Tracking **${wallet.label}** (\`${shortAddress(wallet.address)}\`). Historical backfill has started.`
      );
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
