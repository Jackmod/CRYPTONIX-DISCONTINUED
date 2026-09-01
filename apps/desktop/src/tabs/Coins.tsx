import { useEffect, useState } from 'react';
import type { Coin, EngineClient } from '../api/client';
import { CoinLogo } from '../components/CoinLogo';
import { compactUsd, shortAddress } from '../components/Money';
import { ExternalLink } from '../components/ExternalLink';

/** Ranked momentum list from the scanner, Axiom button per row (spec §5.3). */
export function CoinsTab({ engine }: { engine: EngineClient }) {
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    engine
      .listCoins()
      .then((rows) => !cancelled && setCoins(rows))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [engine]);

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
          <div className="empty-title">The scanner has not flagged anything yet.</div>
          It is off unless <code>COIN_SCANNER_ENABLED=true</code> is set for the engine. The gates are deliberately
          strict, so a quiet hour is normal — <code>scripts/threshold-sweep.ts</code> shows what is passing right now.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Momentum</th>
                <th className="num">Age</th>
                <th className="num">5m volume</th>
                <th className="num">5m change</th>
                <th className="num">Buys / sells</th>
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
                        <CoinLogo mint={coin.mint} symbol={coin.symbol} imageUrl={coin.imageUrl} />
                        <div style={{ minWidth: 0 }}>
                          <div className="ident-name">{coin.symbol}</div>
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
                            style={{ width: `${coin.momentumScore ?? 0}%` }}
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
