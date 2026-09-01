import { deflateSync } from 'node:zlib';

/**
 * A minimal RGB PNG encoder.
 *
 * Hand-rolled on purpose. The alternatives — `canvas`, `sharp`, `resvg` — are
 * native modules that need a toolchain to install and break on a version bump
 * of Node, for a bot whose only drawing job is a grid of rectangles. `zlib` is
 * in the standard library and PNG's own compression is DEFLATE, so this is
 * about a hundred lines with nothing to go wrong at deploy time.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A fixed-size RGB canvas with the two primitives the heatmap needs. */
export class Bitmap {
  private readonly pixels: Buffer;

  constructor(readonly width: number, readonly height: number, background: Rgb) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`Bitmap: ${width}x${height} is not a drawable size`);
    }
    this.pixels = Buffer.alloc(width * height * 3);
    this.fillRect(0, 0, width, height, background);
  }

  /** Out-of-bounds pixels are dropped rather than wrapping to the next row. */
  setPixel(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 3;
    this.pixels[offset] = color.r;
    this.pixels[offset + 1] = color.g;
    this.pixels[offset + 2] = color.b;
  }

  fillRect(x: number, y: number, width: number, height: number, color: Rgb): void {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        this.setPixel(x + dx, y + dy, color);
      }
    }
  }

  getPixel(x: number, y: number): Rgb {
    const offset = (y * this.width + x) * 3;
    return { r: this.pixels[offset], g: this.pixels[offset + 1], b: this.pixels[offset + 2] };
  }

  toPng(): Buffer {
    // Each scanline is prefixed with its filter byte; 0 means "none", which
    // costs some compression and removes every way to get the filter wrong.
    const raw = Buffer.alloc(this.height * (this.width * 3 + 1));
    for (let y = 0; y < this.height; y++) {
      const rowStart = y * (this.width * 3 + 1);
      raw[rowStart] = 0;
      this.pixels.copy(raw, rowStart + 1, y * this.width * 3, (y + 1) * this.width * 3);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type 2: truecolour RGB
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    return Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
