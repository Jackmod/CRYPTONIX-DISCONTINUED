/**
 * A deterministic identicon for a Solana address.
 *
 * Spec §5.3 is explicit: every surface shows the real image for what it is
 * showing, and wallets are the ONE exception — a raw address has no inherent
 * picture, so it gets a generated pattern instead of a photo, the same
 * approach Phantom and MetaMask take.
 *
 * Deterministic by construction: the same address always produces the same
 * pattern, on every machine, with no network call. That is what makes it
 * useful — you learn to recognise a wallet by its shape.
 */

/** FNV-1a: small, fast, and well spread for short strings. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Avalanche, and the reason it is not optional.
 *
 * FNV-1a multiplies by an odd constant, so bit 0 of the result is just the
 * parity of the input bytes — nothing mixes downward into it. Taking cells
 * straight off `hash(addr:x:y) & 1` therefore reduced to
 * `parity(addr) ^ parity(x) ^ parity(y)`, and every wallet in the app drew the
 * same checkerboard in a different colour. This is murmur3's finalizer: it
 * spreads the high bits down so any single bit depends on the whole input.
 */
function mix(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hue from the address, but saturation and lightness fixed.
 *
 * Free hue, constrained everything else: it keeps every identicon legible on
 * the dark ground and stops one landing on the same red or green the P&L
 * columns use, which would read as a value rather than an identity.
 */
function colorFor(seed: number): string {
  return `hsl(${mix(seed ^ 0x5bf03635) % 360} 55% 62%)`;
}

const CELLS = 5;
const HALF = Math.ceil(CELLS / 2);

/** True when this cell of the pattern is filled. */
function isFilled(seed: number, x: number, y: number): boolean {
  return (mix(seed ^ Math.imul(y * HALF + x + 1, 0x9e3779b1)) & 1) === 1;
}

export function Identicon({ address, size = 22 }: { address: string; size?: number }) {
  const seed = hash(address);
  const cell = size / CELLS;
  const fill = colorFor(seed);

  // Mirrored down the vertical axis: symmetry is what makes a 5x5 grid read
  // as a glyph rather than as noise.
  const squares: { x: number; y: number }[] = [];
  for (let y = 0; y < CELLS; y++) {
    for (let x = 0; x < HALF; x++) {
      if (!isFilled(seed, x, y)) continue;
      squares.push({ x, y });
      if (x !== CELLS - 1 - x) squares.push({ x: CELLS - 1 - x, y });
    }
  }

  return (
    <svg
      className="avatar"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Identicon for ${address}`}
    >
      <rect width={size} height={size} fill="var(--panel-raised)" />
      {squares.map((s) => (
        <rect key={`${s.x}-${s.y}`} x={s.x * cell} y={s.y * cell} width={cell} height={cell} fill={fill} />
      ))}
    </svg>
  );
}
