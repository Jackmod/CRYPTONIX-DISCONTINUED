/**
 * SOL amounts, signed and coloured.
 *
 * Green and red appear here and in the PnL calendar and nowhere else in the
 * interface — see the note in tokens.css. Everything that is merely UI uses
 * amber, so these two colours never stop meaning "money".
 */
export function Sol({ value, decimals = 4 }: { value: number; decimals?: number }) {
  const cls = value > 0 ? 'gain' : value < 0 ? 'loss' : undefined;
  return (
    <span className={cls}>
      {value > 0 ? '+' : ''}
      {value.toFixed(decimals)}
    </span>
  );
}

export function compactUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
