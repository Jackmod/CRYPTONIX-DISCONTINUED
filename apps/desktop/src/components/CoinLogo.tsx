import { useState } from 'react';
import { Identicon } from './Identicon';

/**
 * A coin's real on-chain logo (spec §5.3), falling back to a generated mark
 * only when there genuinely is no image.
 *
 * Two distinct fallback cases, both real: the provider has no logo for a very
 * new token, or it has one whose URL fails to load. Either way a broken-image
 * glyph in a dense table is worse than a deterministic placeholder, so the
 * mint drives an identicon instead.
 */
export function CoinLogo({ mint, symbol, imageUrl, size = 22 }: {
  mint: string;
  symbol: string;
  imageUrl: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  if (!imageUrl || failed) return <Identicon address={mint} size={size} />;

  return (
    <img
      className="avatar"
      src={imageUrl}
      alt={`${symbol} logo`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
