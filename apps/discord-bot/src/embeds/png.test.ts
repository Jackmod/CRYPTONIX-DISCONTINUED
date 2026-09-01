import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { Bitmap } from './png';

const BLACK = { r: 0, g: 0, b: 0 };
const RED = { r: 255, g: 0, b: 0 };

/** Walks the chunk structure the way a decoder would, checking every CRC. */
function chunks(png: Buffer): { type: string; data: Buffer }[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const found: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stated = png.readUInt32BE(offset + 8 + length);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length))).toBe(stated);
    found.push({ type, data });
    offset += 12 + length;
  }
  return found;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('Bitmap', () => {
  it('refuses a size nothing can be drawn on', () => {
    expect(() => new Bitmap(0, 10, BLACK)).toThrow(RangeError);
    expect(() => new Bitmap(10, -1, BLACK)).toThrow(RangeError);
    expect(() => new Bitmap(1.5, 10, BLACK)).toThrow(RangeError);
  });

  it('starts filled with the background', () => {
    const bitmap = new Bitmap(3, 3, RED);
    expect(bitmap.getPixel(0, 0)).toEqual(RED);
    expect(bitmap.getPixel(2, 2)).toEqual(RED);
  });

  it('fills a rectangle without touching what is outside it', () => {
    const bitmap = new Bitmap(5, 5, BLACK);
    bitmap.fillRect(1, 1, 2, 2, RED);
    expect(bitmap.getPixel(1, 1)).toEqual(RED);
    expect(bitmap.getPixel(2, 2)).toEqual(RED);
    expect(bitmap.getPixel(3, 3)).toEqual(BLACK);
    expect(bitmap.getPixel(0, 0)).toEqual(BLACK);
  });

  it('drops out-of-bounds pixels instead of wrapping onto the next row', () => {
    const bitmap = new Bitmap(4, 4, BLACK);
    bitmap.setPixel(-1, 2, RED);
    bitmap.setPixel(4, 2, RED);
    bitmap.setPixel(2, 4, RED);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(bitmap.getPixel(x, y)).toEqual(BLACK);
    }
  });

  it('clips a rectangle that runs off the edge', () => {
    const bitmap = new Bitmap(4, 4, BLACK);
    bitmap.fillRect(2, 2, 10, 10, RED);
    expect(bitmap.getPixel(3, 3)).toEqual(RED);
    expect(bitmap.getPixel(1, 1)).toEqual(BLACK);
  });
});

describe('toPng', () => {
  it('writes a signature, IHDR, IDAT and IEND, each with a valid CRC', () => {
    const parsed = chunks(new Bitmap(8, 4, RED).toPng());
    expect(parsed.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('declares the real dimensions and an 8-bit truecolour format', () => {
    const [ihdr] = chunks(new Bitmap(37, 19, BLACK).toPng());
    expect(ihdr.data.readUInt32BE(0)).toBe(37);
    expect(ihdr.data.readUInt32BE(4)).toBe(19);
    expect(ihdr.data[8]).toBe(8); // bit depth
    expect(ihdr.data[9]).toBe(2); // truecolour
    expect(ihdr.data[12]).toBe(0); // not interlaced
  });

  it('round-trips the pixels through the compressed data', () => {
    const bitmap = new Bitmap(3, 2, BLACK);
    bitmap.setPixel(2, 1, RED);
    const idat = chunks(bitmap.toPng()).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);

    // Each row is one filter byte followed by width*3 colour bytes.
    expect(raw.length).toBe(2 * (3 * 3 + 1));
    expect(raw[0]).toBe(0);
    expect(raw[10]).toBe(0);
    // Last pixel of the second row.
    expect([...raw.subarray(17, 20)]).toEqual([255, 0, 0]);
  });

  it('is deterministic, so an unchanged month renders identical bytes', () => {
    const a = new Bitmap(20, 20, RED).toPng();
    const b = new Bitmap(20, 20, RED).toPng();
    expect(a.equals(b)).toBe(true);
  });
});
