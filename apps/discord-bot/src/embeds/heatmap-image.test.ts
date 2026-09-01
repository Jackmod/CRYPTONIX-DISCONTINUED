import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildHeatmapGrid, type DailyPnlRow } from '@cryptonix/core';
import { heatmapImageSize, renderHeatmapImage } from './heatmap-image';

/** Reads one pixel back out of an encoded PNG, so the test sees what Discord will. */
function pixelAt(png: Buffer, x: number, y: number): { r: number; g: number; b: number } {
  let offset = 8;
  let width = 0;
  let idat: Buffer | null = null;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') width = data.readUInt32BE(0);
    if (type === 'IDAT') idat = data;
    offset += 12 + length;
  }
  const raw = inflateSync(idat!);
  const stride = width * 3 + 1;
  const at = y * stride + 1 + x * 3;
  return { r: raw[at], g: raw[at + 1], b: raw[at + 2] };
}

const VOID = { r: 10, g: 12, b: 16 };
const PANEL = { r: 22, g: 26, b: 33 };
const GAIN = { r: 63, g: 185, b: 80 };
const LOSS = { r: 248, g: 81, b: 73 };
const PHOSPHOR = { r: 255, g: 176, b: 0 };

const CELL = 56;
const GAP = 6;
const PAD = 18;
const HEADER = 26;

/** The centre of the cell at (row, col), where nothing else is drawn. */
function cellCentre(row: number, col: number): { x: number; y: number } {
  return {
    x: PAD + col * (CELL + GAP) + Math.round(CELL / 2),
    y: PAD + HEADER + row * (CELL + GAP) + Math.round(CELL / 2),
  };
}

function rows(entries: [string, number, number][]): DailyPnlRow[] {
  return entries.map(([date, realizedPnlSol, tradeCount]) => ({ date, realizedPnlSol, tradeCount }));
}

describe('renderHeatmapImage', () => {
  it('sizes itself to the number of weeks the month spans', () => {
    // August 2026 starts on a Saturday and has 31 days, so it needs six rows.
    const grid = buildHeatmapGrid([], '2026-08');
    expect(grid).toHaveLength(6);
    const { width, height } = heatmapImageSize(6);
    const png = renderHeatmapImage(grid);
    expect(pixelAt(png, width - 1, height - 1)).toEqual(VOID);
    // One past the edge would fall off the buffer entirely.
    expect(() => pixelAt(png, width, height - 1)).not.toThrow();
  });

  it('paints a big winning day in the gain colour', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', 20, 4], ['2026-08-04', 1, 1]]), '2026-08');
    // 2026-08-03 is a Monday in the second row of the grid.
    const { x, y } = cellCentre(1, 0);
    expect(pixelAt(renderHeatmapImage(grid), x, y)).toEqual(GAIN);
  });

  it('paints a big losing day in the loss colour', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', -20, 4], ['2026-08-04', -1, 1]]), '2026-08');
    const { x, y } = cellCentre(1, 0);
    expect(pixelAt(renderHeatmapImage(grid), x, y)).toEqual(LOSS);
  });

  it('paints a day with no trades as an empty panel, not as a loss', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', 0, 0]]), '2026-08');
    const { x, y } = cellCentre(1, 0);
    expect(pixelAt(renderHeatmapImage(grid), x, y)).toEqual(PANEL);
  });

  it('leaves padding slots as background, so the month keeps its shape', () => {
    const grid = buildHeatmapGrid([], '2026-08');
    // The first row of August 2026 is five empty slots before Saturday.
    const { x, y } = cellCentre(0, 0);
    expect(pixelAt(renderHeatmapImage(grid), x, y)).toEqual(VOID);
  });

  it('outlines the selected day and nothing else', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', 5, 2]]), '2026-08');
    const png = renderHeatmapImage(grid, '2026-08-03');
    const { x, y } = cellCentre(1, 0);
    // The outline sits three pixels outside the cell.
    expect(pixelAt(png, x, y - Math.round(CELL / 2) - 3)).toEqual(PHOSPHOR);
    // A different day keeps its plain edge.
    const other = cellCentre(1, 1);
    expect(pixelAt(png, other.x, other.y - Math.round(CELL / 2) - 3)).toEqual(VOID);
  });

  it('draws no outline when no day is selected', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', 5, 2]]), '2026-08');
    const png = renderHeatmapImage(grid);
    const { x, y } = cellCentre(1, 0);
    expect(pixelAt(png, x, y - Math.round(CELL / 2) - 3)).toEqual(VOID);
  });

  it('prints the date inside the cell', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', 0, 0]]), '2026-08');
    const png = renderHeatmapImage(grid);
    const cell = cellCentre(1, 0);
    const x = cell.x - Math.round(CELL / 2);
    const y = cell.y - Math.round(CELL / 2);
    // Somewhere in the label area is a pixel that is not the cell fill.
    let painted = 0;
    for (let dy = 6; dy < 18; dy++) {
      for (let dx = 6; dx < 24; dx++) {
        const p = pixelAt(png, x + dx, y + dy);
        if (p.r !== PANEL.r || p.g !== PANEL.g || p.b !== PANEL.b) painted++;
      }
    }
    expect(painted).toBeGreaterThan(10);
  });

  it('renders a five-row month too', () => {
    // September 2026 starts on a Tuesday and has 30 days: five rows.
    const grid = buildHeatmapGrid([], '2026-09');
    expect(grid).toHaveLength(5);
    const png = renderHeatmapImage(grid);
    const { height } = heatmapImageSize(5);
    expect(pixelAt(png, 0, height - 1)).toEqual(VOID);
  });

  it('is deterministic, so the same month always renders the same bytes', () => {
    const grid = buildHeatmapGrid(rows([['2026-08-03', 5, 2]]), '2026-08');
    expect(renderHeatmapImage(grid).equals(renderHeatmapImage(grid))).toBe(true);
  });
});
