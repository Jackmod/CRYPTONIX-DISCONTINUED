import { describe, it, expect } from 'vitest';
import { buildPnlEmbed } from './pnl';

const rows = [
  { date: '2026-08-01', realizedPnlSol: 6.1, tradeCount: 4 },
  { date: '2026-08-02', realizedPnlSol: -3.44, tradeCount: 2 },
  { date: '2026-08-03', realizedPnlSol: 1.2, tradeCount: 1 },
];

describe('buildPnlEmbed', () => {
  it('titles the embed with the wallet and month', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();

    expect(data.title).toContain('Me');
    expect(data.title).toContain('2026-08');
  });

  it('shows realized PnL with an explicit sign', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();
    const realized = data.fields?.find((f) => f.name.includes('Realized'));

    expect(realized?.value).toContain('+3.86');
  });

  it('shows a negative total without a stray plus sign', () => {
    const data = buildPnlEmbed({
      walletLabel: 'Me',
      month: '2026-08',
      rows: [{ date: '2026-08-01', realizedPnlSol: -2.5, tradeCount: 1 }],
    }).toJSON();
    const realized = data.fields?.find((f) => f.name.includes('Realized'));

    expect(realized?.value).toContain('-2.5000');
    expect(realized?.value).not.toContain('+');
  });

  it('renders the heatmap grid in the description', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();

    expect(data.description).toContain('🟢');
    expect(data.description).toContain('⬛'); // padding for a month not starting on Monday
  });

  it('renders an em dash rather than 0% when nothing was traded', () => {
    // summarizePnl returns null for win rate on an empty month. Printing "0%"
    // would read as "lost every trade" instead of "no trades".
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows: [] }).toJSON();
    const winRate = data.fields?.find((f) => f.name.includes('Win rate'));

    expect(winRate?.value).toBe('—');
  });

  it('names the best and worst day', () => {
    const data = buildPnlEmbed({ walletLabel: 'Me', month: '2026-08', rows }).toJSON();
    const best = data.fields?.find((f) => f.name.includes('Best'));
    const worst = data.fields?.find((f) => f.name.includes('Worst'));

    expect(best?.value).toContain('2026-08-01');
    expect(worst?.value).toContain('2026-08-02');
  });
});
