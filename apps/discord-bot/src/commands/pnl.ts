import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { buildPnlEmbed } from '../embeds/pnl.js';
import { describeError, type BotCommand } from './types.js';

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** Shape alone is not enough: 2026-00 and 2026-13 would render a blank grid. */
function isValidMonth(month: string): boolean {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return false;

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  // Date.UTC maps years 0-99 to 1900-1999, so '0026-08' would silently render
  // 1926's calendar - wrong leading pad, and a different February length.
  // Nothing before Solana existed is a real query anyway.
  if (year < 2000 || year > 2999) return false;
  return monthNumber >= 1 && monthNumber <= 12;
}

/** Current month in UTC, matching the UTC calendar maths in the heatmap. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export const pnlCommand: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('pnl')
    .setDescription('Show realized PnL for a wallet')
    .addStringOption((opt) => opt.setName('wallet').setDescription('Wallet label or address'))
    .addStringOption((opt) => opt.setName('month').setDescription('Month as YYYY-MM'))
    // Read-only, but it exposes the shared wallet list and its PnL. In a DM
    // there is no server whose membership could gate that, so keep it in
    // guilds where the server's own access controls apply.
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

    const month = interaction.options.getString('month') ?? currentMonth();
    if (!isValidMonth(month)) {
      await interaction.editReply('⚠️ Month must look like `YYYY-MM`, for example `2026-08`.');
      return;
    }

    const walletQuery = interaction.options.getString('wallet');

    try {
      const wallets = await engine.listWallets();
      const wallet = walletQuery
        ? wallets.find((w) => w.label === walletQuery || w.address === walletQuery)
        : wallets.find((w) => w.isMine) ?? wallets[0];

      if (!wallet) {
        await interaction.editReply(
          walletQuery
            ? `⚠️ No tracked wallet matches \`${walletQuery}\`.`
            : '⚠️ No wallets are tracked yet. Add one with `/track wallet`.'
        );
        return;
      }

      const rows = await engine.getPnl(wallet.id);
      await interaction.editReply({ embeds: [buildPnlEmbed({ walletLabel: wallet.label, month, rows })] });
    } catch (err) {
      await interaction.editReply(describeError(err));
    }
  },
};
