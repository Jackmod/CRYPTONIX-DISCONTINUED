import { describe, it, expect } from 'vitest';
import { buildHeatmapGrid, renderHeatmap } from './heatmap';

describe('buildHeatmapGrid', () => {
  it('pads the first week so day 1 lands on its real weekday', () => {
    // 2026-08-01 is a Saturday. Monday-first, that is index 5, so five
    // padding cells precede it.
    const grid = buildHeatmapGrid([], '2026-08');

    expect(grid[0]).toHaveLength(7);
    expect(grid[0].slice(0, 5).every((cell) => cell.date === null)).toBe(true);
    expect(grid[0][5].date).toBe('2026-08-01');
  });

  it('covers every day of the month and pads the final week to seven', () => {
    const grid = buildHeatmapGrid([], '2026-08');
    const cells = grid.flat();
    const realDays = cells.filter((cell) => cell.date !== null);

    expect(realDays).toHaveLength(31);
    expect(realDays[30].date).toBe('2026-08-31');
    expect(cells).toHaveLength(42); // 6 rows x 7
    expect(grid.every((week) => week.length === 7)).toBe(true);
  });

  it('handles a month that starts on a Sunday', () => {
    // 2026-02-01 is a Sunday: Monday-first index 6, so six padding cells,
    // and 28 days fits in exactly 5 rows.
    const grid = buildHeatmapGrid([], '2026-02');

    expect(grid[0][6].date).toBe('2026-02-01');
    expect(grid).toHaveLength(5);
  });

  it('marks untraded days as level 0', () => {
    const grid = buildHeatmapGrid([{ date: '2026-08-03', realizedPnlSol: 0, tradeCount: 0 }], '2026-08');
    const cell = grid.flat().find((c) => c.date === '2026-08-03');

    expect(cell?.level).toBe(0);
  });

  it("scales levels against the month's own best and worst day", () => {
    const grid = buildHeatmapGrid(
      [
        { date: '2026-08-03', realizedPnlSol: 10, tradeCount: 2 },  // best -> 4
        { date: '2026-08-04', realizedPnlSol: 2, tradeCount: 1 },   // 20% of best -> 3
        { date: '2026-08-05', realizedPnlSol: -8, tradeCount: 3 },  // worst -> 1
        { date: '2026-08-06', realizedPnlSol: -1, tradeCount: 1 },  // shallow loss -> 2
      ],
      '2026-08'
    );
    const byDate = Object.fromEntries(grid.flat().filter((c) => c.date).map((c) => [c.date, c.level]));

    expect(byDate['2026-08-03']).toBe(4);
    expect(byDate['2026-08-04']).toBe(3);
    expect(byDate['2026-08-05']).toBe(1);
    expect(byDate['2026-08-06']).toBe(2);
  });

  it('ignores rows belonging to a different month', () => {
    const grid = buildHeatmapGrid([{ date: '2026-07-30', realizedPnlSol: 99, tradeCount: 9 }], '2026-08');

    expect(grid.flat().every((cell) => cell.level === 0)).toBe(true);
  });

  it('refuses a two-digit year rather than silently rendering the 1900s', () => {
    // Date.UTC maps years 0-99 to 1900-1999, so '0026-08' would produce 1926's
    // calendar: a different starting weekday, and a different February length
    // in a leap year.
    expect(() => buildHeatmapGrid([], '0026-08')).toThrow(RangeError);
    expect(() => buildHeatmapGrid([], '26-08')).toThrow(RangeError);
  });

  it('refuses a month outside 1-12', () => {
    expect(() => buildHeatmapGrid([], '2026-00')).toThrow(RangeError);
    expect(() => buildHeatmapGrid([], '2026-13')).toThrow(RangeError);
  });
});

describe('renderHeatmap', () => {
  it('renders one line per week using the level glyphs', () => {
    const grid = buildHeatmapGrid([{ date: '2026-08-01', realizedPnlSol: 5, tradeCount: 2 }], '2026-08');

    const lines = renderHeatmap(grid).split('\n');

    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('⬛⬛⬛⬛⬛🟢⬜');
  });
});
