import { describe, it, expect } from 'vitest';
import { summarizePnl } from './summarize';

describe('summarizePnl', () => {
  it('returns an empty summary for no rows', () => {
    const summary = summarizePnl([]);

    expect(summary.realizedSol).toBe(0);
    expect(summary.tradingDays).toBe(0);
    expect(summary.winRate).toBeNull();
    expect(summary.best).toBeNull();
    expect(summary.worst).toBeNull();
  });

  it('sums realized PnL across every row', () => {
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 2.5, tradeCount: 3 },
      { date: '2026-08-02', realizedPnlSol: -1.5, tradeCount: 2 },
    ]);

    expect(summary.realizedSol).toBeCloseTo(1.0);
  });

  it('excludes days with no trades from the win rate', () => {
    // A month with one winning day and twenty untraded days is a 100% win
    // rate, not 5%. Counting quiet days as losses would make every real
    // month look catastrophic.
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 5, tradeCount: 2 },
      { date: '2026-08-02', realizedPnlSol: 0, tradeCount: 0 },
      { date: '2026-08-03', realizedPnlSol: 0, tradeCount: 0 },
    ]);

    expect(summary.tradingDays).toBe(1);
    expect(summary.winDays).toBe(1);
    expect(summary.winRate).toBe(1);
  });

  it('counts a break-even trading day as neither a win nor a loss', () => {
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 4, tradeCount: 1 },
      { date: '2026-08-02', realizedPnlSol: 0, tradeCount: 5 },
      { date: '2026-08-03', realizedPnlSol: -2, tradeCount: 1 },
    ]);

    expect(summary.tradingDays).toBe(3);
    expect(summary.winDays).toBe(1);
    expect(summary.lossDays).toBe(1);
    expect(summary.winRate).toBeCloseTo(1 / 3);
  });

  it('reports the best and worst trading day', () => {
    const summary = summarizePnl([
      { date: '2026-08-01', realizedPnlSol: 1, tradeCount: 1 },
      { date: '2026-08-02', realizedPnlSol: 6.1, tradeCount: 4 },
      { date: '2026-08-03', realizedPnlSol: -3.44, tradeCount: 2 },
    ]);

    expect(summary.best?.date).toBe('2026-08-02');
    expect(summary.worst?.date).toBe('2026-08-03');
  });

  it('breaks best/worst ties toward the earlier date', () => {
    const summary = summarizePnl([
      { date: '2026-08-05', realizedPnlSol: 3, tradeCount: 1 },
      { date: '2026-08-02', realizedPnlSol: 3, tradeCount: 1 },
    ]);

    expect(summary.best?.date).toBe('2026-08-02');
  });

  it('never reports a win rate of zero when there is simply no data', () => {
    // null and 0 must not render the same: "no trades yet" is not "lost every
    // single day". The embed in Task 9 branches on exactly this.
    expect(summarizePnl([{ date: '2026-08-01', realizedPnlSol: 0, tradeCount: 0 }]).winRate).toBeNull();
  });
});
