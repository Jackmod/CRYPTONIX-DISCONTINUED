import { useEffect, useState } from 'react';
import type { Coin, EngineClient, EngineHealth } from '../api/client';
import { CoinLogo } from '../components/CoinLogo';
import { compactUsd, shortAddress } from '../components/Money';
import { ExternalLink } from '../components/ExternalLink';

/**
 * How long ago the scanner found this, in the shortest form that is still true.
 *
 * The Age column is the token's age WHEN IT WAS FOUND, which is what the
 * momentum score was computed against and never changes. How stale the signal
 * is now is a different number, and the one that decides whether it is still
 * worth acting on.
 */
function foundAgo(firstSeenAt: string, now: number): string {
  const minutes = Math.floor((now - new Date(firstSeenAt).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * A coin's name on screen.
 *
 * A token can genuinely ship without a symbol, and a nameless row cannot be
 * told apart from its neighbours.
 */
function displaySymbol(coin: { symbol: string; mint: string }): string {
  const symbol = coin.symbol.trim();
  return symbol === '' ? shortAddress(coin.mint) : symbol;
}

/** Ranked momentum list from the scanner, Axiom button per row (spec §5.3). */
export function CoinsTab({ engine, liveToken = 0 }: { engine: EngineClient; liveToken?: number }) {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<EngineHealth | null>(null);

  // Re-read when an alert lands: the scanner publishes a new coin over the
  // same socket, and a list that never refreshes goes stale while it is open.
  useEffect(() => {
    let cancelled = false;
    engine
      .listCoins()
      .then((rows) => {
        if (cancelled) return;
        setCoins(rows);
        setError(null);
      })
      .catch((err) => !cancelled && setError((err as Error).message));

    // Separate, and allowed to fail: it only sharpens the wording of the empty
    // state, and must not cost this tab its actual data.
    engine
      .getHealth()
      .then((hp) => !cancelled && setHealth(hp))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
  }, [engine, liveToken]);

  // Fixed once per render, so every row's "ago" is measured from one instant.
  const now = Date.now();

  return (
    <>
      <div className="view-head">
        <h1 className="view-title">Coins</h1>
        <span className="view-sub">ranked by momentum at the time they were found</span>
      </div>

      {error && <div className="banner">{error}</div>}

      {coins === null && !error ? (
        <div className="empty">Loading coins…</div>
      ) : coins && coins.length === 0 ? (
        <div className="empty">
          {/* The engine knows whether the scanner is even running, so say which
              of the two situations this is rather than guessing. */}
          {health?.features?.coinScanner === false ? (
            <>
              <div className="empty-title">The scanner is off.</div>
              Set <code>COIN_SCANNER_ENABLED=true</code> for the engine to start looking.
            </>
          ) : (
            <>
              <div className="empty-title">The scanner has not flagged anything yet.</div>
              The gates are deliberately strict, so a quiet hour is normal —{' '}
              <code>scripts/threshold-sweep.ts</code> shows what is passing right now.
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Momentum</th>
                <th className="num" title="The token's age when the scanner found it">Age at find</th>
                <th className="num">5m volume</th>
                <th className="num">5m change</th>
                <th className="num">Buys / sells</th>
                <th className="num">Found</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(coins ?? []).map((coin) => {
                const s = coin.stats ?? {};
                const change = s.priceChange5m ?? 0;
                return (
                  <tr key={coin.mint}>
                    <td>
                      <div className="ident">
                        <CoinLogo mint={coin.mint} symbol={displaySymbol(coin)} imageUrl={coin.imageUrl} />
                        <div style={{ minWidth: 0 }}>
                          <div className="ident-name" title={displaySymbol(coin)}>
                            {displaySymbol(coin)}
                          </div>
                          <div className="ident-sub">{shortAddress(coin.mint)}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="meter">
                        {/* Divs, not spans: width and height do not apply to a
                            non-replaced inline element, so the bar drew nothing. */}
                        <div className="meter-track">
                          <div
                            className="meter-fill"
                            // Clamped: a score outside 0-100 is corrupt data, and
                            // a bar wider than its track would misrepresent it.
                            // The number beside it stays exactly as reported.
                            style={{ width: `${Math.max(0, Math.min(100, coin.momentumScore ?? 0))}%` }}
                            data-testid="meter-fill"
                          />
                        </div>
                        <span style={{ color: 'var(--dim)' }}>{coin.momentumScore ?? 0}</span>
                      </div>
                    </td>
                    <td className="num">{s.ageMinutes === undefined ? '—' : `${Math.round(s.ageMinutes)}m`}</td>
                    <td className="num">{s.volume5m === undefined ? '—' : compactUsd(s.volume5m)}</td>
                    <td className={`num ${change > 0 ? 'gain' : change < 0 ? 'loss' : ''}`}>
                      {change > 0 ? '+' : ''}
                      {change.toFixed(1)}%
                    </td>
                    <td className="num">
                      {s.buys5m ?? 0} / {s.sells5m ?? 0}
                    </td>
                    <td className="num" style={{ color: 'var(--dim)' }} title={coin.firstSeenAt}>
                      {foundAgo(coin.firstSeenAt, now)}
                    </td>
                    <td>
                      <ExternalLink className="btn btn-primary" href={`https://axiom.trade/t/${coin.mint}`}>
                        Axiom
                      </ExternalLink>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
