import { useEffect, useState } from 'react';
import type { EngineClient, Trade, Wallet } from '../api/client';
import { Identicon } from '../components/Identicon';
import { Sol, shortAddress } from '../components/Money';

/**
 * Own wallets first, then the rest alphabetically.
 *
 * `is_mine` pinned to the top is spec §5.3, and it is the right default: your
 * own position is the thing you check first, every time.
 */
export function sortWallets(wallets: Wallet[]): Wallet[] {
  return [...wallets].sort((a, b) => {
    if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function Balance({
  engine,
  walletId,
  liveToken,
}: {
  engine: EngineClient;
  walletId: number;
  liveToken: number;
}) {
  const [sol, setSol] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // Re-read whenever a trade lands: a balance shown next to a live feed that
  // just reported a 12 SOL buy has to move, or the screen contradicts itself.
  useEffect(() => {
    let cancelled = false;
    engine
      .getBalance(walletId)
      .then((value) => {
        if (cancelled) return;
        setSol(value);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [engine, walletId, liveToken]);

  // Balance comes from a live RPC call per row, so it is deliberately allowed
  // to fail on its own without taking the row with it.
  if (failed) return <span style={{ color: 'var(--dimmer)' }}>—</span>;
  if (sol === null) return <span style={{ color: 'var(--dimmer)' }}>·</span>;
  return <>{sol.toFixed(3)}</>;
}

function TradeHistory({
  engine,
  wallet,
  liveToken,
  onBack,
}: {
  engine: EngineClient;
  wallet: Wallet;
  liveToken: number;
  onBack: () => void;
}) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The view is keyed by wallet, so it never has to blank itself here — and
    // a live refresh must not flash the history back to "Loading".
    engine
      .listTrades(wallet.id)
      .then((rows) => {
        if (cancelled) return;
        setTrades(rows);
        setError(null);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [engine, wallet.id, liveToken]);

  return (
    <>
      <div className="view-head">
        <button className="btn" onClick={onBack}>
          ← Wallets
        </button>
        <h1 className="view-title">{wallet.label}</h1>
        <span className="view-sub">{shortAddress(wallet.address)}</span>
      </div>

      {error && <div className="banner">{error}</div>}

      {trades === null && !error ? (
        <div className="empty">Loading trades…</div>
      ) : trades && trades.length === 0 ? (
        <div className="empty">
          <div className="empty-title">No trades recorded yet.</div>
          Backfill runs when a wallet is added, and live trades appear the moment Helius delivers them.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Side</th>
                <th>Mint</th>
                <th className="num">SOL</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {(trades ?? []).map((trade) => (
                <tr key={trade.id}>
                  <td style={{ color: 'var(--dim)' }}>{new Date(trade.ts).toLocaleString()}</td>
                  <td className={trade.side === 'buy' ? 'gain' : 'loss'}>{trade.side.toUpperCase()}</td>
                  <td>{shortAddress(trade.mint)}</td>
                  <td className="num">{trade.solAmount.toFixed(4)}</td>
                  <td className="num">{trade.tokenAmount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function WalletsTab({
  engine,
  wallets,
  error,
  liveToken = 0,
}: {
  engine: EngineClient;
  wallets: Wallet[];
  error: string | null;
  /** Bumped when a new alert arrives, so live views re-read themselves. */
  liveToken?: number;
}) {
  const [selected, setSelected] = useState<Wallet | null>(null);

  if (selected) {
    return (
      <TradeHistory
        // Keyed by wallet so switching wallets starts from a clean slate
        // rather than showing the previous wallet's trades for a moment.
        key={selected.id}
        engine={engine}
        wallet={selected}
        liveToken={liveToken}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <>
      <div className="view-head">
        <h1 className="view-title">Wallets</h1>
        <span className="view-sub">{wallets.length} tracked</span>
      </div>

      {error && <div className="banner">{error}</div>}

      {wallets.length === 0 && !error ? (
        <div className="empty">
          <div className="empty-title">No wallets tracked yet.</div>
          Add one in <code>Settings</code>, or run <code>/track wallet</code> from Discord — both write to the same list.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Address</th>
                <th className="num">Balance (SOL)</th>
                <th>Backfill</th>
              </tr>
            </thead>
            <tbody>
              {sortWallets(wallets).map((wallet) => (
                <tr
                  key={wallet.id}
                  className={wallet.isMine ? 'row-pinned' : undefined}
                  data-clickable="true"
                  onClick={() => setSelected(wallet)}
                >
                  <td>
                    <div className="ident">
                      <Identicon address={wallet.address} />
                      <div style={{ minWidth: 0 }}>
                        {/*
                          A real button, not just a clickable row: a <tr> with
                          an onClick cannot be tabbed to or opened with Enter,
                          which left the whole table unreachable by keyboard.
                          The row click stays as a convenience for the mouse.
                        */}
                        <button className="link-btn ident-name" onClick={() => setSelected(wallet)}>
                          {wallet.label}
                        </button>
                        {wallet.isMine && <div className="ident-sub">yours</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ color: 'var(--dim)' }}>{shortAddress(wallet.address)}</td>
                  <td className="num">
                    <Balance engine={engine} walletId={wallet.id} liveToken={liveToken} />
                  </td>
                  <td style={{ color: 'var(--dim)' }}>{wallet.backfillStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export { Sol };
