import { describe, it, expect } from 'vitest';
import { buildPnlEmbed, buildPnlReply } from './pnl';

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

  it('summarises only the month it is titled with', () => {
    // GET /wallets/:id/pnl returns every day the wallet ever traded. Before
    // this, the heatmap showed August while Realized/Win rate/Best/Worst
    // silently reported all-time figures under an August heading.
    const data = buildPnlEmbed({
      walletLabel: 'Me',
      month: '2026-08',
      rows: [
        { date: '2026-07-15', realizedPnlSol: 100, tradeCount: 5 }, // different month
        { date: '2026-08-01', realizedPnlSol: 2, tradeCount: 1 },
        { date: '2026-09-02', realizedPnlSol: -50, tradeCount: 3 }, // different month
      ],
    }).toJSON();

    const realized = data.fields?.find((f) => f.name.includes('Realized'));
    const tradingDays = data.fields?.find((f) => f.name.includes('Trading days'));
    const best = data.fields?.find((f) => f.name.includes('Best'));

    expect(realized?.value).toContain('+2.0000');
    expect(tradingDays?.value).toBe('1');
    expect(best?.value).toContain('2026-08-01');
  });

  it('reports an empty month as empty even when other months have data', () => {
    const data = buildPnlEmbed({
      walletLabel: 'Me',
      month: '2026-08',
      rows: [{ date: '2026-07-15', realizedPnlSol: 100, tradeCount: 5 }],
    }).toJSON();

    const winRate = data.fields?.find((f) => f.name.includes('Win rate'));
    expect(winRate?.value).toBe('—');
  });
});

describe('buildPnlReply', () => {
  const options = { walletLabel: 'whale', month: '2026-08', rows };

  it('attaches the rendered heatmap and points the embed at it', () => {
    const reply = buildPnlReply(options);
    expect(reply.files).toHaveLength(1);
    expect(reply.files[0].name).toBe('pnl-heatmap.png');
    expect(reply.embeds[0].toJSON().image?.url).toBe('attachment://pnl-heatmap.png');
  });

  it('attaches a real PNG, not an empty buffer', () => {
    const attachment = buildPnlReply(options).files[0];
    const png = attachment.attachment as Buffer;
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(200);
  });

  it('keeps the text heatmap in the description as the fallback', () => {
    // It survives a failed attachment, copies as text, and reads aloud.
    expect(buildPnlReply(options).embeds[0].toJSON().description).toContain('⬜');
  });

  it('answers with an explanation when the month cannot be laid out at all', () => {
    // buildHeatmapGrid refuses a year under 100, and the embed builds the grid
    // too — so the whole reply must degrade rather than throw past the command.
    const reply = buildPnlReply({ ...options, month: '0026-08' });
    expect(reply.files).toEqual([]);
    expect(reply.embeds).toHaveLength(1);
    expect(reply.embeds[0].toJSON().description).toContain('not a month');
    expect(reply.embeds[0].toJSON().image).toBeUndefined();
  });

  it('clamps a title Discord would reject for a very long wallet label', () => {
    const reply = buildPnlReply({ ...options, walletLabel: 'x'.repeat(400) });
    expect(reply.embeds[0].toJSON().title!.length).toBeLessThanOrEqual(256);
  });

  it('renders only the requested month into the picture', () => {
    const withOther = [...rows, { date: '2026-07-15', realizedPnlSol: 999, tradeCount: 9 }];
    const a = buildPnlReply({ ...options, rows: withOther }).files[0].attachment as Buffer;
    const b = buildPnlReply(options).files[0].attachment as Buffer;
    expect(a.equals(b)).toBe(true);
  });
});
