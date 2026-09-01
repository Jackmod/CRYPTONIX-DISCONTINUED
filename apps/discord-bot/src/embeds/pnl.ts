import { EmbedBuilder } from 'discord.js';
import {
  buildHeatmapGrid,
  renderHeatmap,
  summarizePnl,
  HEATMAP_LEGEND,
  type DailyPnlRow,
} from '@cryptonix/core';

const POSITIVE_COLOR = 0x22c55e;
const NEGATIVE_COLOR = 0xef4444;
const NEUTRAL_COLOR = 0x64748b;

function signedSol(value: number): string {
  // toFixed already carries the minus sign; only gains need one added.
  return `${value > 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

export function buildPnlEmbed(options: { walletLabel: string; month: string; rows: DailyPnlRow[] }): EmbedBuilder {
  const { walletLabel, month, rows } = options;

  // GET /wallets/:id/pnl returns every day the wallet has ever traded, and
  // buildHeatmapGrid already scopes itself to `month`. Summarising the
  // unfiltered rows put all-time Realized, Win rate, Trading days, Best and
  // Worst under a heading that names one month, beside a grid showing only
  // that month. Scope both to the same window.
  const monthRows = rows.filter((row) => row.date.startsWith(`${month}-`));
  const summary = summarizePnl(monthRows);
  const grid = buildHeatmapGrid(monthRows, month);

  const color =
    summary.realizedSol > 0 ? POSITIVE_COLOR : summary.realizedSol < 0 ? NEGATIVE_COLOR : NEUTRAL_COLOR;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`PnL — ${walletLabel} — ${month}`)
    .setDescription(renderHeatmap(grid))
    .addFields(
      { name: 'Realized', value: signedSol(summary.realizedSol), inline: true },
      {
        name: 'Win rate',
        // null means "no trading days at all". Rendering that as 0% would
        // claim every day lost, which is a different and much worse statement.
        value:
          summary.winRate === null
            ? '—'
            : `${Math.round(summary.winRate * 100)}%  (${summary.winDays}W / ${summary.lossDays}L)`,
        inline: true,
      },
      { name: 'Trading days', value: String(summary.tradingDays), inline: true },
      {
        name: 'Best',
        value: summary.best ? `${summary.best.date}  ${signedSol(summary.best.realizedPnlSol)}` : '—',
        inline: true,
      },
      {
        name: 'Worst',
        value: summary.worst ? `${summary.worst.date}  ${signedSol(summary.worst.realizedPnlSol)}` : '—',
        inline: true,
      }
    )
    .setFooter({ text: `Weeks run Monday→Sunday · ${HEATMAP_LEGEND}` });
}
