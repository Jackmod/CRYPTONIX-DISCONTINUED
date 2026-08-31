import { SlashCommandBuilder } from 'discord.js';
import { describeError, shortAddress, type BotCommand } from './types.js';

export const untrackCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Stop tracking a wallet')
    .addSubcommand((sub) =>
      sub
        .setName('wallet')
        .setDescription('Stop tracking a Solana wallet address')
        .addStringOption((opt) => opt.setName('address').setDescription('Solana wallet address').setRequired(true))
    ),

  async execute(interaction, { engine }) {
    await interaction.deferReply();
    const address = interaction.options.getString('address', true);

    try {
      // The engine deletes by id; a human types an address. Resolve here.
      const wallets = await engine.listWallets();
      const wallet = wallets.find((w) => w.address === address);
      if (!wallet) {
        await interaction.editReply(`⚠️ \`${shortAddress(address)}\` is not tracked.`);
        return;
      }

      await engine.untrackWallet(wallet.id);
      await interaction.editReply(`🗑️ Stopped tracking **${wallet.label}** and released its Helius webhook.`);
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
