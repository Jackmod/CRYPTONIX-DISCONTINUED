import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
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
    )
    // The wallet list is shared by every server the bot is in, and untracking
    // deletes that wallet's wallet_trades and pnl_daily rows outright. Live
    // webhook deliveries cannot be re-fetched, so an unprivileged member of
    // any one guild could permanently destroy every other guild's history.
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // Discord ignores default_member_permissions in DMs, and commands are
    // DM-enabled by default -- so without this the permission gate above was
    // bypassable by anyone who simply DMed the bot.
    .setContexts(InteractionContextType.Guild),

  async execute(interaction, { engine }) {
    await interaction.deferReply();
    // Defence in depth: setContexts keeps this out of DMs, but a command
    // registered before that change could still arrive from one, and Discord
    // enforces no permission gate there.
    if (!interaction.guildId) {
      await interaction.editReply('⚠️ This command only works inside a server, not in a DM.');
      return;
    }

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
