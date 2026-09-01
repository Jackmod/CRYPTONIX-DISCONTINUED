export interface DailyPnlRow {
  /** 'YYYY-MM-DD', as stored in pnl_daily.date */
  date: string;
  realizedPnlSol: number;
  tradeCount: number;
}

export interface PnlSummary {
  realizedSol: number;
  tradingDays: number;
  winDays: number;
  lossDays: number;
  /** winDays / tradingDays, or null when nothing was traded at all. */
  winRate: number | null;
  best: DailyPnlRow | null;
  worst: DailyPnlRow | null;
}

export function summarizePnl(rows: DailyPnlRow[]): PnlSummary {
  const realizedSol = rows.reduce((total, row) => total + row.realizedPnlSol, 0);

  // Only days that actually traded may influence win rate, best or worst.
  // Sorting by date first makes the tie-break (earlier date wins) fall out of
  // the strict > / < comparisons below without extra bookkeeping.
  const traded = rows.filter((row) => row.tradeCount > 0).sort((a, b) => a.date.localeCompare(b.date));

  let best: DailyPnlRow | null = null;
  let worst: DailyPnlRow | null = null;
  let winDays = 0;
  let lossDays = 0;

  for (const row of traded) {
    if (row.realizedPnlSol > 0) winDays++;
    else if (row.realizedPnlSol < 0) lossDays++;
    if (best === null || row.realizedPnlSol > best.realizedPnlSol) best = row;
    if (worst === null || row.realizedPnlSol < worst.realizedPnlSol) worst = row;
  }

  return {
    realizedSol,
    tradingDays: traded.length,
    winDays,
    lossDays,
    winRate: traded.length === 0 ? null : winDays / traded.length,
    best,
    worst,
  };
}
