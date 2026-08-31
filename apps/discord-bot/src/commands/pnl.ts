import { SlashCommandBuilder } from 'discord.js';
import { buildPnlEmbed } from '../embeds/pnl.js';
import { describeError, type BotCommand } from './types.js';

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** Shape alone is not enough: 2026-00 and 2026-13 would render a blank grid. */
function isValidMonth(month: string): boolean {
  const match = MONTH_PATTERN.exec(month);
  if (!match) return false;
  const monthNumber = Number(match[2]);
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
    .addStringOption((opt) => opt.setName('month').setDescription('Month as YYYY-MM')),

  async execute(interaction, { engine }) {
    await interaction.deferReply();

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
