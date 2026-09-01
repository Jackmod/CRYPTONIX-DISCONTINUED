import { useEffect, useMemo, useState } from 'react';
import { buildHeatmapGrid, summarizePnl, type DailyPnlRow } from '@cryptonix/core';
import type { DailyPnl, EngineClient, Trade, Wallet } from '../api/client';
import { Sol, displayLabel, shortAddress } from '../components/Money';
import { sortWallets } from './Wallets';

/** Current month in UTC, matching the calendar's own arithmetic. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Colour band for a day.
 *
 * Scaled against the month's own best and worst rather than an absolute SOL
 * figure — the same rule the Discord heatmap follows, and for the same reason:
 * a quiet month would otherwise render uniformly blank and a volatile one
 * uniformly saturated, and neither tells you anything.
 */
function levelFor(pnl: number, traded: boolean, best: number, worst: number): string {
  if (!traded) return 'none';
  if (pnl > 0) return best > 0 && pnl >= best / 2 ? 'gain-2' : 'gain-1';
  if (pnl < 0) return worst < 0 && pnl <= worst / 2 ? 'loss-2' : 'loss-1';
  return 'none';
}

export function PnlTab({ engine, wallets }: { engine: EngineClient; wallets: Wallet[] }) {
  const ordered = useMemo(() => sortWallets(wallets), [wallets]);
  const [walletId, setWalletId] = useState<number | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<DailyPnl[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [dayTrades, setDayTrades] = useState<Trade[] | null>(null);

  // Default to your own wallet: it is the one you check first. A selection
  // that no longer exists — untracked here or from Discord — falls back to
  // that same default rather than asking the engine for a deleted wallet.
  const selectionExists = ordered.some((w) => w.id === walletId);
  const active = (selectionExists ? walletId : null) ?? ordered[0]?.id ?? null;

  useEffect(() => {
    if (active === null) return;
    let cancelled = false;
    setRows(null);
    setDay(null);
    engine
      .listPnl(active)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [engine, active]);

  useEffect(() => {
    if (active === null || day === null) {
      setDayTrades(null);
      return;
    }
    let cancelled = false;
    engine
      .listTrades(active)
      .then((trades) => {
        if (cancelled) return;
        setDayTrades(trades.filter((t) => t.ts.slice(0, 10) === day));
      })
      .catch(() => !cancelled && setDayTrades([]));
    return () => {
      cancelled = true;
    };
  }, [engine, active, day]);

  const monthRows: DailyPnlRow[] = useMemo(
    () => (rows ?? []).filter((r) => r.date.startsWith(`${month}-`)),
    [rows, month]
  );
  const summary = useMemo(() => summarizePnl(monthRows), [monthRows]);
  const grid = useMemo(() => buildHeatmapGrid(monthRows, month), [monthRows, month]);

  const traded = monthRows.filter((r) => r.tradeCount > 0);
  const best = traded.reduce((max, r) => Math.max(max, r.realizedPnlSol), 0);
  const worst = traded.reduce((min, r) => Math.min(min, r.realizedPnlSol), 0);
  const byDate = new Map(monthRows.map((r) => [r.date, r]));

  if (ordered.length === 0) {
    return (
      <>
        <div className="view-head">
          <h1 className="view-title">PnL</h1>
        </div>
        <div className="empty">
          <div className="empty-title">Nothing to chart yet.</div>
          Track a wallet first — PnL is computed from its trade history.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="view-head">
        <h1 className="view-title">PnL</h1>
        <select
          className="input"
          value={active ?? ''}
          onChange={(e) => setWalletId(Number(e.target.value))}
          aria-label="Wallet"
        >
          {ordered.map((w) => (
            <option key={w.id} value={w.id}>
              {w.isMine ? `${displayLabel(w)} (yours)` : displayLabel(w)}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ←
        </button>
        <span className="view-sub">{month}</span>
        <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          →
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="stat-row">
        <div>
          <div className="stat-label">Realized</div>
          <div className="stat-value">
            <Sol value={summary.realizedSol} /> <span style={{ fontSize: 12, color: 'var(--dim)' }}>SOL</span>
          </div>
        </div>
        <div>
          <div className="stat-label">Win rate</div>
          <div className="stat-value">
            {/* null means no trading days at all. Rendering that as 0% would
                claim every day lost, which is a different statement. */}
            {summary.winRate === null ? '—' : `${Math.round(summary.winRate * 100)}%`}
          </div>
        </div>
        <div>
          <div className="stat-label">Trading days</div>
          <div className="stat-value">{summary.tradingDays}</div>
        </div>
        <div>
          <div className="stat-label">Best</div>
          <div className="stat-value">{summary.best ? <Sol value={summary.best.realizedPnlSol} decimals={2} /> : '—'}</div>
        </div>
        <div>
          <div className="stat-label">Worst</div>
          <div className="stat-value">
            {summary.worst ? <Sol value={summary.worst.realizedPnlSol} decimals={2} /> : '—'}
          </div>
        </div>
      </div>

      <div className="pnl-grid">
        <div>
          <div className="cal-dow" aria-hidden="true">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          {/* A group, not a grid: role="grid" promises rows and gridcells that
              this is not, and a wrong role reads worse than none. */}
          <div className="cal" role="group" aria-label={`Daily PnL for ${month}`}>
            {grid.flat().map((cell, i) => {
              if (cell.date === null) return <div key={i} className="cal-cell" data-level="pad" aria-hidden="true" />;
              const row = byDate.get(cell.date);
              const level = levelFor(row?.realizedPnlSol ?? 0, (row?.tradeCount ?? 0) > 0, best, worst);
              const summaryText = `${cell.date}: ${(row?.realizedPnlSol ?? 0).toFixed(4)} SOL, ${
                row?.tradeCount ?? 0
              } trades`;
              return (
                <button
                  key={cell.date}
                  className="cal-cell"
                  data-level={level}
                  aria-pressed={day === cell.date}
                  // The visible text is just the day number, so the full
                  // reading has to be spelled out; `title` alone loses to it.
                  aria-label={summaryText}
                  title={summaryText}
                  onClick={() => setDay(day === cell.date ? null : cell.date)}
                >
                  {/* The date, so a day is identifiable without hovering it. */}
                  <span>{Number(cell.date.slice(8))}</span>
                </button>
              );
            })}
          </div>

          <div className="legend">
            <span className="legend-swatch" style={{ background: 'var(--loss)' }} /> loss
            <span className="legend-swatch" style={{ background: 'var(--panel-raised)' }} /> no trades
            <span className="legend-swatch" style={{ background: 'var(--gain)' }} /> gain
            <span style={{ marginLeft: 'var(--s2)' }}>· weeks run Monday→Sunday</span>
          </div>
        </div>

        {/* The day's trades sit beside the calendar, at the height of the cell
            that opened them, rather than below the fold. */}
        <div className="pnl-day">
          {day === null ? (
            <div className="empty">Click a day to see the trades behind it.</div>
          ) : (
            <>
              <div className="view-head">
                <h2 className="view-title" style={{ fontSize: 13 }}>
                  {day}
                </h2>
                <button className="btn" onClick={() => setDay(null)}>
                  close
                </button>
              </div>
              {dayTrades === null ? (
                <div className="empty">Loading…</div>
              ) : dayTrades.length === 0 ? (
                <div className="empty">No trades recorded on this day.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Side</th>
                        <th>Mint</th>
                        <th className="num">SOL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dayTrades.map((t) => (
                        <tr key={t.id}>
                          <td style={{ color: 'var(--dim)' }}>{new Date(t.ts).toLocaleTimeString()}</td>
                          <td className={t.side === 'buy' ? 'gain' : 'loss'}>{t.side.toUpperCase()}</td>
                          <td>{shortAddress(t.mint)}</td>
                          <td className="num">{t.solAmount.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
