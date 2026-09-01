import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import {
  buildHeatmapGrid,
  renderHeatmap,
  summarizePnl,
  HEATMAP_LEGEND,
  type DailyPnlRow,
} from '@cryptonix/core';
import { renderHeatmapImage } from './heatmap-image.js';

const POSITIVE_COLOR = 0x22c55e;
const NEGATIVE_COLOR = 0xef4444;
const NEUTRAL_COLOR = 0x64748b;

/** Discord rejects an embed title over 256 characters by throwing. */
const MAX_EMBED_TITLE = 256;

function clampTitle(title: string): string {
  return title.length <= MAX_EMBED_TITLE ? title : `${title.slice(0, MAX_EMBED_TITLE - 1)}…`;
}

function signedSol(value: number): string {
  // toFixed already carries the minus sign; only gains need one added.
  return `${value > 0 ? '+' : ''}${value.toFixed(4)} SOL`;
}

/** The attachment filename the embed references; they must match exactly. */
const HEATMAP_FILE = 'pnl-heatmap.png';

export interface PnlReply {
  embeds: EmbedBuilder[];
  files: AttachmentBuilder[];
}

/**
 * The full `/pnl` reply: the embed and its rendered heatmap (spec §5.2).
 *
 * The image is built from the same grid the text version uses, so the two can
 * never disagree. If drawing fails the embed still goes out — a PnL answer
 * without a picture beats no answer at all.
 */
export function buildPnlReply(options: { walletLabel: string; month: string; rows: DailyPnlRow[] }): PnlReply {
  let embed: EmbedBuilder;
  try {
    embed = buildPnlEmbed(options);
  } catch (err) {
    // buildHeatmapGrid refuses a month it cannot lay out, and the embed builds
    // the grid too — so this is not only the image failing. Say what happened
    // instead of letting the command's generic catch report an engine error.
    console.error(`could not build the PnL embed for ${options.month}`, err);
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(NEUTRAL_COLOR)
          .setTitle(clampTitle(`PnL — ${options.walletLabel}`))
          .setDescription(`⚠️ \`${options.month}\` is not a month this can render.`),
      ],
      files: [],
    };
  }

  const monthRows = options.rows.filter((row) => row.date.startsWith(`${options.month}-`));
  try {
    const png = renderHeatmapImage(buildHeatmapGrid(monthRows, options.month));
    embed.setImage(`attachment://${HEATMAP_FILE}`);
    return { embeds: [embed], files: [new AttachmentBuilder(png, { name: HEATMAP_FILE })] };
  } catch (err) {
    // The text heatmap is still in the description, so the answer survives.
    console.error(`could not render the PnL heatmap for ${options.month}`, err);
    return { embeds: [embed], files: [] };
  }
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
    // The label is free text; the engine caps it at 100 characters, but a
    // row predating that cap must not make the whole embed unrenderable.
    .setTitle(clampTitle(`PnL — ${walletLabel} — ${month}`))
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
