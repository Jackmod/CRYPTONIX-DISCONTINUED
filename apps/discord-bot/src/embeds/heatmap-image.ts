import type { HeatmapCell, HeatLevel } from '@cryptonix/core';
import { Bitmap, type Rgb } from './png.js';

/**
 * The month heatmap as an attachable PNG (spec §5.2).
 *
 * The Unicode-block version stays in the embed description as the accessible
 * fallback — it survives a failed attachment, copies as text, and reads on a
 * screen reader. This is the picture the spec asks for: real cells, real dates,
 * and a grid that lines up on every client rather than depending on how one
 * renders emoji.
 */

/** The desktop app's palette, so both surfaces read the same. */
const VOID: Rgb = { r: 10, g: 12, b: 16 };
const PANEL: Rgb = { r: 22, g: 26, b: 33 };
const DIM: Rgb = { r: 138, g: 148, b: 162 };
const LABEL_ON_DARK: Rgb = { r: 176, g: 186, b: 200 };
const PHOSPHOR: Rgb = { r: 255, g: 176, b: 0 };
const GAIN: Rgb = { r: 63, g: 185, b: 80 };
const GAIN_SOFT: Rgb = { r: 37, g: 96, b: 55 };
const LOSS: Rgb = { r: 248, g: 81, b: 73 };
const LOSS_SOFT: Rgb = { r: 108, g: 46, b: 47 };

const LEVEL_COLORS: Record<HeatLevel, Rgb> = {
  0: PANEL,
  1: LOSS,
  2: LOSS_SOFT,
  3: GAIN_SOFT,
  4: GAIN,
};

const CELL = 56;
const GAP = 6;
const PAD = 18;
const HEADER = 26;
const COLUMNS = 7;
/** The pixel font is 3x5; at 1x it is unreadable at the size Discord shows. */
const TEXT_SCALE = 2;

/**
 * A 3x5 pixel font, covering only what this image prints.
 *
 * Enough for the date in each cell and the weekday header, at a size where an
 * anti-aliased font would be mush anyway. Each string is five rows of three
 * columns, '#' for on.
 */
const GLYPHS: Record<string, string> = {
  '0': '###' + '#.#' + '#.#' + '#.#' + '###',
  '1': '.#.' + '##.' + '.#.' + '.#.' + '###',
  '2': '###' + '..#' + '###' + '#..' + '###',
  '3': '###' + '..#' + '###' + '..#' + '###',
  '4': '#.#' + '#.#' + '###' + '..#' + '..#',
  '5': '###' + '#..' + '###' + '..#' + '###',
  '6': '###' + '#..' + '###' + '#.#' + '###',
  '7': '###' + '..#' + '..#' + '..#' + '..#',
  '8': '###' + '#.#' + '###' + '#.#' + '###',
  '9': '###' + '#.#' + '###' + '..#' + '###',
  M: '#.#' + '###' + '###' + '#.#' + '#.#',
  T: '###' + '.#.' + '.#.' + '.#.' + '.#.',
  W: '#.#' + '#.#' + '###' + '###' + '#.#',
  F: '###' + '#..' + '###' + '#..' + '#..',
  S: '###' + '#..' + '###' + '..#' + '###',
};

const GLYPH_W = 3;
const GLYPH_H = 5;

/** Draws `text` at 1x scale from its top-left corner. Unknown chars are skipped. */
function drawText(bitmap: Bitmap, text: string, x: number, y: number, color: Rgb, scale = 1): void {
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (glyph) {
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (glyph[row * GLYPH_W + col] !== '#') continue;
          bitmap.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += (GLYPH_W + 1) * scale;
  }
}

export function heatmapImageSize(rows: number): { width: number; height: number } {
  return {
    width: PAD * 2 + COLUMNS * CELL + (COLUMNS - 1) * GAP,
    height: PAD * 2 + HEADER + rows * CELL + (rows - 1) * GAP,
  };
}

/**
 * Renders the grid `buildHeatmapGrid` produced.
 *
 * Takes the grid rather than the raw rows so the picture and the text version
 * can never disagree about which day landed in which cell — they are the same
 * grid, drawn twice.
 */
export function renderHeatmapImage(grid: HeatmapCell[][], selectedDay?: string): Buffer {
  const { width, height } = heatmapImageSize(grid.length);
  const bitmap = new Bitmap(width, height, VOID);

  // Weekday header, Monday first, matching buildHeatmapGrid's own ordering.
  const dayLetters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  for (let col = 0; col < COLUMNS; col++) {
    const x = PAD + col * (CELL + GAP) + Math.round((CELL - GLYPH_W * TEXT_SCALE) / 2);
    drawText(bitmap, dayLetters[col], x, PAD, DIM, TEXT_SCALE);
  }

  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const cell = grid[row][col];
      const x = PAD + col * (CELL + GAP);
      const y = PAD + HEADER + row * (CELL + GAP);

      // A padding slot belongs to an adjacent month; leaving it as background
      // is what makes the month's own shape legible.
      if (!cell || cell.date === null) continue;

      bitmap.fillRect(x, y, CELL, CELL, LEVEL_COLORS[cell.level]);

      if (cell.date === selectedDay) {
        strokeRect(bitmap, x - 3, y - 3, CELL + 6, CELL + 6, PHOSPHOR);
      }

      // The date, top-left, in whichever of two tones stays readable on the
      // band behind it.
      const day = String(Number(cell.date.slice(8)));
      const onSaturated = cell.level === 1 || cell.level === 4;
      drawText(bitmap, day, x + 6, y + 6, onSaturated ? VOID : LABEL_ON_DARK, TEXT_SCALE);
    }
  }

  return bitmap.toPng();
}

function strokeRect(bitmap: Bitmap, x: number, y: number, width: number, height: number, color: Rgb): void {
  bitmap.fillRect(x, y, width, 1, color);
  bitmap.fillRect(x, y + height - 1, width, 1, color);
  bitmap.fillRect(x, y, 1, height, color);
  bitmap.fillRect(x + width - 1, y, 1, height, color);
}
