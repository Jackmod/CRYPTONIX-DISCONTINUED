import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { normalizeHandle } from '@cryptonix/core';
import { describeError, displayLabel, shortAddress, walletChoices, type BotCommand } from './types.js';

export const untrackCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('untrack')
    .setDescription('Stop tracking a wallet or an X account')
    .addSubcommand((sub) =>
      sub
        .setName('wallet')
        .setDescription('Stop tracking a Solana wallet address')
        .addStringOption((opt) =>
          opt
            .setName('address')
            .setDescription('Solana wallet address')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('twitter')
        .setDescription('Stop following an X account')
        .addStringOption((opt) =>
          opt.setName('handle').setDescription('@handle').setRequired(true).setAutocomplete(true)
        )
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

  /**
   * Suggestions must answer within Discord's 3-second window, and a failure
   * has to answer with an empty list rather than throw — an autocomplete that
   * never responds shows the user a stuck "loading" with no explanation.
   */
  async autocomplete(interaction, { engine }) {
    try {
      if (interaction.options.getSubcommand() === 'twitter') {
        const handles = await engine.listHandles();
        await interaction.respond(handleChoices(handles, interaction.options.getFocused()));
        return;
      }
      const wallets = await engine.listWallets();
      await interaction.respond(walletChoices(wallets, interaction.options.getFocused()));
    } catch (err) {
      console.error('untrack autocomplete failed', err);
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction, { engine }) {
    if (interaction.options.getSubcommand() === 'twitter') {
      await untrackTwitter(interaction, engine);
      return;
    }

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
      await interaction.editReply(
        `🗑️ Stopped tracking **${displayLabel(wallet)}** and released its Helius webhook.`
      );
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};

/** Tracked handles as autocomplete choices, filtered by what has been typed. */
export function handleChoices(
  handles: { handle: string }[],
  query: string
): { name: string; value: string }[] {
  const needle = query.trim().replace(/^@/, '').toLowerCase();
  return handles
    .filter((h) => needle === '' || h.handle.includes(needle))
    .slice(0, 25)
    .map((h) => ({ name: `@${h.handle}`, value: h.handle }));
}

async function untrackTwitter(
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
    await interaction.editReply(`⚠️ \`${input.replaceAll('`', '')}\` is not an X handle.`);
    return;
  }

  try {
    // The engine deletes by id; a human types a handle. Resolve here, the same
    // way the wallet path does.
    const tracked = await engine.listHandles();
    const match = tracked.find((h) => h.handle === handle);
    if (!match) {
      await interaction.editReply(`⚠️ **@${handle}** is not tracked.`);
      return;
    }

    await engine.untrackHandle(match.id);
    await interaction.editReply(`🗑️ Stopped following **@${handle}** and removed its stored tweets.`);
  } catch (err) {
    await interaction.editReply(describeError(err));
  }
}
