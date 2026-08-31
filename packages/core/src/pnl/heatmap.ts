import type { DailyPnlRow } from './summarize.js';

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatmapCell {
  /** 'YYYY-MM-DD', or null for a padding slot outside the rendered month. */
  date: string | null;
  pnlSol: number;
  level: HeatLevel;
}

const GLYPHS: Record<HeatLevel, string> = {
  0: '⬜',
  1: '🟥',
  2: '🟧',
  3: '🟩',
  4: '🟢',
};
const PADDING_GLYPH = '⬛';

export const HEATMAP_LEGEND =
  '⬜ no trades · 🟧 loss · 🟥 big loss · 🟩 gain · 🟢 big gain · ⬛ other month';

/**
 * Levels are relative to this month's own extremes, not to absolute SOL. A
 * quiet month would otherwise render as a uniformly blank grid and a volatile
 * one as uniformly saturated, which tells the reader nothing either way.
 */
function levelFor(pnlSol: number, traded: boolean, best: number, worst: number): HeatLevel {
  if (!traded) return 0;
  if (pnlSol > 0) return best > 0 && pnlSol >= best / 2 ? 4 : 3;
  if (pnlSol < 0) return worst < 0 && pnlSol <= worst / 2 ? 1 : 2;
  return 0; // traded, but exactly break-even
}

export function buildHeatmapGrid(rows: DailyPnlRow[], month: string): HeatmapCell[][] {
  const [year, monthIndex] = month.split('-').map(Number);

  // Date.UTC maps years 0-99 to 1900-1999, so '0026-08' would quietly produce
  // 1926's calendar: a different starting weekday and, in a leap year, a
  // different February length. Callers validate too; refuse here as well so a
  // wrong grid can never be rendered from a bad input.
  if (!Number.isInteger(year) || year < 100 || !Number.isInteger(monthIndex) || monthIndex < 1 || monthIndex > 12) {
    throw new RangeError(`buildHeatmapGrid: '${month}' is not a YYYY-MM month`);
  }

  // Every date calculation is UTC. Building these from local time shifts the
  // whole calendar by a day for anyone in a negative-offset timezone.
  const firstOfMonth = new Date(Date.UTC(year, monthIndex - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const leadingPad = (firstOfMonth.getUTCDay() + 6) % 7; // Monday-first

  const byDate = new Map(rows.filter((row) => row.date.startsWith(`${month}-`)).map((row) => [row.date, row]));
  const monthRows = [...byDate.values()].filter((row) => row.tradeCount > 0);
  const best = monthRows.reduce((max, row) => Math.max(max, row.realizedPnlSol), 0);
  const worst = monthRows.reduce((min, row) => Math.min(min, row.realizedPnlSol), 0);

  const cells: HeatmapCell[] = [];
  for (let i = 0; i < leadingPad; i++) cells.push({ date: null, pnlSol: 0, level: 0 });

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const row = byDate.get(date);
    cells.push({
      date,
      pnlSol: row?.realizedPnlSol ?? 0,
      level: levelFor(row?.realizedPnlSol ?? 0, (row?.tradeCount ?? 0) > 0, best, worst),
    });
  }

  while (cells.length % 7 !== 0) cells.push({ date: null, pnlSol: 0, level: 0 });

  const grid: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) grid.push(cells.slice(i, i + 7));
  return grid;
}

export function renderHeatmap(grid: HeatmapCell[][]): string {
  return grid
    .map((week) => week.map((cell) => (cell.date === null ? PADDING_GLYPH : GLYPHS[cell.level])).join(''))
    .join('\n');
}
