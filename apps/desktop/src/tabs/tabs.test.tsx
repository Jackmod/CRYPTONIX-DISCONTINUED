import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Coin, DailyPnl, EngineClient, StoredTweet, Trade, Wallet } from '../api/client';
import { EngineError } from '../api/client';
import { WalletsTab, sortWallets } from './Wallets';
import { CoinsTab } from './Coins';
import { CallsTab } from './Calls';
import { PnlTab } from './Pnl';
import { SettingsTab } from './Settings';

const ADDR_A = 'AAAA1111111111111111111111111111111111111111';
const ADDR_B = 'BBBB2222222222222222222222222222222222222222';

function wallet(over: Partial<Wallet> = {}): Wallet {
  return {
    id: 1,
    address: ADDR_A,
    label: 'whale',
    isMine: false,
    heliusWebhookId: null,
    backfillStatus: 'done',
    addedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function trade(over: Partial<Trade> = {}): Trade {
  return {
    id: 1,
    walletId: 1,
    signature: 'sig',
    mint: 'So11111111111111111111111111111111111111112',
    side: 'buy',
    solAmount: 1.25,
    tokenAmount: 1000,
    ts: '2026-09-03T10:00:00.000Z',
    ...over,
  };
}

function coin(over: Partial<Coin> = {}): Coin {
  return {
    mint: 'MintMintMintMintMintMintMintMintMintMint11',
    symbol: 'PEPE',
    momentumScore: 82,
    imageUrl: null,
    stats: { ageMinutes: 12.4, volume5m: 12_500, priceChange5m: 42.4, buys5m: 60, sells5m: 20 },
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function fakeEngine(over: Partial<Record<keyof EngineClient, unknown>> = {}): EngineClient {
  return {
    listWallets: vi.fn(async () => []),
    listTrades: vi.fn(async () => []),
    listPnl: vi.fn(async () => []),
    getBalance: vi.fn(async () => 1.5),
    listCoins: vi.fn(async () => []),
    listHandles: vi.fn(async () => []),
    trackHandle: vi.fn(async () => ({ id: 1, handle: 'ansem' })),
    untrackHandle: vi.fn(async () => undefined),
    listTweets: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({ ok: true, features: { coinScanner: true, tweetMonitor: true } })),
    listAlertsSince: vi.fn(async () => []),
    trackWallet: vi.fn(async () => wallet()),
    updateWallet: vi.fn(async () => wallet()),
    untrackWallet: vi.fn(async () => undefined),
    ...over,
  } as unknown as EngineClient;
}

describe('sortWallets', () => {
  it('pins your own wallets above the rest', () => {
    const rows = [wallet({ id: 1, label: 'aaa' }), wallet({ id: 2, label: 'zzz', isMine: true })];
    expect(sortWallets(rows).map((w) => w.id)).toEqual([2, 1]);
  });

  it('orders the rest alphabetically', () => {
    const rows = [wallet({ id: 1, label: 'zeta' }), wallet({ id: 2, label: 'alpha' })];
    expect(sortWallets(rows).map((w) => w.label)).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [wallet({ id: 1, label: 'z' }), wallet({ id: 2, label: 'a' })];
    sortWallets(rows);
    expect(rows.map((w) => w.id)).toEqual([1, 2]);
  });
});

describe('WalletsTab', () => {
  it('points at both ways to add a wallet when the list is empty', () => {
    render(<WalletsTab engine={fakeEngine()} wallets={[]} error={null} />);
    expect(screen.getByText('No wallets tracked yet.')).toBeInTheDocument();
    expect(screen.getByText('/track wallet')).toBeInTheDocument();
  });

  it('shows the engine error instead of an empty state when the fetch failed', () => {
    render(<WalletsTab engine={fakeEngine()} wallets={[]} error="cannot reach the engine" />);
    expect(screen.getByText('cannot reach the engine')).toBeInTheDocument();
    expect(screen.queryByText('No wallets tracked yet.')).not.toBeInTheDocument();
    // Not a bare header with no rows under it either.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('marks your own wallet and shows a live balance', async () => {
    const engine = fakeEngine({ getBalance: vi.fn(async () => 12.3456) });
    render(<WalletsTab engine={engine} wallets={[wallet({ isMine: true })]} error={null} />);
    expect(screen.getByText('yours')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('12.346')).toBeInTheDocument());
  });

  it('degrades one row to a dash when its balance call fails, keeping the table', async () => {
    const engine = fakeEngine({
      getBalance: vi.fn(async () => {
        throw new EngineError('rpc down', 0);
      }),
    });
    render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} />);
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
    expect(screen.getByText('whale')).toBeInTheDocument();
  });

  it('shows that wallet all-time PnL alongside its trades', async () => {
    const engine = fakeEngine({
      listTrades: vi.fn(async () => [trade()]),
      listPnl: vi.fn(async () => [
        { date: '2026-08-01', realizedPnlSol: 4, tradeCount: 2 },
        { date: '2026-08-02', realizedPnlSol: -1, tradeCount: 1 },
      ]),
    });
    render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} />);
    fireEvent.click(screen.getByText('whale'));
    await waitFor(() => expect(screen.getByText('+3.0000')).toBeInTheDocument());
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(engine.listPnl).toHaveBeenCalledWith(1);
  });

  it('keeps the trade table when PnL fails on its own', async () => {
    const engine = fakeEngine({
      listTrades: vi.fn(async () => [trade()]),
      listPnl: vi.fn(async () => {
        throw new EngineError('pnl unavailable', 500);
      }),
    });
    render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} />);
    fireEvent.click(screen.getByText('whale'));
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument());
    expect(screen.getByText('PnL is unavailable for this wallet right now.')).toBeInTheDocument();
  });

  it('opens that wallet history when a row is clicked', async () => {
    const engine = fakeEngine({ listTrades: vi.fn(async () => [trade()]) });
    render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} />);
    fireEvent.click(screen.getByText('whale'));
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument());
    expect(engine.listTrades).toHaveBeenCalledWith(1);
  });

  it('explains an empty history rather than showing a bare table', async () => {
    render(<WalletsTab engine={fakeEngine()} wallets={[wallet()]} error={null} />);
    fireEvent.click(screen.getByText('whale'));
    await waitFor(() => expect(screen.getByText('No trades recorded yet.')).toBeInTheDocument());
  });

  it('names a wallet with no label by its address, rather than leaving the row blank', async () => {
    render(<WalletsTab engine={fakeEngine()} wallets={[wallet({ label: '' })]} error={null} />);
    expect(screen.getByRole('button', { name: 'AAAA…1111' })).toBeInTheDocument();
  });

  it('keeps the whole label available on hover when it is truncated on screen', () => {
    render(<WalletsTab engine={fakeEngine()} wallets={[wallet({ label: 'x'.repeat(120) })]} error={null} />);
    expect(screen.getByRole('button', { name: 'x'.repeat(120) })).toHaveAttribute('title', 'x'.repeat(120));
  });

  it('opens a wallet from the keyboard, not only by clicking the row', async () => {
    // Regression: the row was a <tr onClick>, unreachable by tab or Enter.
    const engine = fakeEngine({ listTrades: vi.fn(async () => [trade()]) });
    render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} />);
    const opener = screen.getByRole('button', { name: 'whale' });
    opener.focus();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument());
  });

  it('re-reads the open history when a trade lands', async () => {
    const engine = fakeEngine({ listTrades: vi.fn(async () => [trade()]) });
    const { rerender } = render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} liveToken={1} />);
    fireEvent.click(screen.getByText('whale'));
    await waitFor(() => expect(engine.listTrades).toHaveBeenCalledTimes(1));

    rerender(<WalletsTab engine={engine} wallets={[wallet()]} error={null} liveToken={2} />);
    await waitFor(() => expect(engine.listTrades).toHaveBeenCalledTimes(2));
    // The table must not flash back to a loading state under the reader.
    expect(screen.queryByText('Loading trades…')).not.toBeInTheDocument();
  });

  it('starts a different wallet history clean rather than showing the last one', async () => {
    const a = wallet({ id: 1, label: 'aaa' });
    const b = wallet({ id: 2, label: 'bbb' });
    const engine = fakeEngine({
      listTrades: vi.fn(async (id: number) => (id === 1 ? [trade()] : [])),
    });
    render(<WalletsTab engine={engine} wallets={[a, b]} error={null} />);
    fireEvent.click(screen.getByText('aaa'));
    await waitFor(() => expect(screen.getByText('BUY')).toBeInTheDocument());
    fireEvent.click(screen.getByText('← Wallets'));
    fireEvent.click(screen.getByText('bbb'));
    await waitFor(() => expect(screen.getByText('No trades recorded yet.')).toBeInTheDocument());
    expect(screen.queryByText('BUY')).not.toBeInTheDocument();
  });

  it('recovers a balance that failed once the next read succeeds', async () => {
    let fail = true;
    const engine = fakeEngine({
      getBalance: vi.fn(async () => {
        if (fail) throw new EngineError('rpc down', 0);
        return 9.5;
      }),
    });
    const { rerender } = render(<WalletsTab engine={engine} wallets={[wallet()]} error={null} liveToken={1} />);
    await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());

    fail = false;
    rerender(<WalletsTab engine={engine} wallets={[wallet()]} error={null} liveToken={2} />);
    await waitFor(() => expect(screen.getByText('9.500')).toBeInTheDocument());
  });

  it('goes back to the list from a history view', async () => {
    render(<WalletsTab engine={fakeEngine()} wallets={[wallet()]} error={null} />);
    fireEvent.click(screen.getByText('whale'));
    await waitFor(() => expect(screen.getByText('← Wallets')).toBeInTheDocument());
    fireEvent.click(screen.getByText('← Wallets'));
    expect(screen.getByText('1 tracked')).toBeInTheDocument();
  });
});

describe('CoinsTab', () => {
  it('says the scanner is off when the engine reports it is off', async () => {
    const engine = fakeEngine({
      getHealth: vi.fn(async () => ({ ok: true, features: { coinScanner: false, tweetMonitor: true } })),
    });
    render(<CoinsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('The scanner is off.')).toBeInTheDocument());
    expect(screen.getByText('COIN_SCANNER_ENABLED=true')).toBeInTheDocument();
  });

  it('still lists coins when the health check fails outright', async () => {
    // An engine too old to have /health, or a proxy answering oddly, must not
    // cost this tab its actual data.
    const engine = fakeEngine({
      listCoins: vi.fn(async () => [coin()]),
      getHealth: vi.fn(async () => {
        throw new EngineError('not found', 404);
      }),
    });
    render(<CoinsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('PEPE')).toBeInTheDocument());
  });

  it('says the hour was quiet when the scanner IS running', async () => {
    // Telling someone to set a variable they already set sends them to fix
    // the wrong thing.
    render(<CoinsTab engine={fakeEngine()} />);
    await waitFor(() =>
      expect(screen.getByText('The scanner has not flagged anything yet.')).toBeInTheDocument()
    );
    expect(screen.queryByText('COIN_SCANNER_ENABLED=true')).not.toBeInTheDocument();
  });

  it('renders a scored coin with its stats', async () => {
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => [coin()]) })} />);
    await waitFor(() => expect(screen.getByText('PEPE')).toBeInTheDocument());
    const row = screen.getByText('PEPE').closest('tr')!;
    expect(within(row).getByText('82')).toBeInTheDocument();
    expect(within(row).getByText('12m')).toBeInTheDocument();
    expect(within(row).getByText('$12.5k')).toBeInTheDocument();
    expect(within(row).getByText('60 / 20')).toBeInTheDocument();
  });

  it('colours a rise as a gain and a fall as a loss', async () => {
    const rows = [coin(), coin({ mint: 'Other', symbol: 'DUD', stats: { priceChange5m: -12 } })];
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => rows) })} />);
    await waitFor(() => expect(screen.getByText('DUD')).toBeInTheDocument());
    expect(screen.getByText('PEPE').closest('tr')!.querySelector('.gain')).toBeTruthy();
    expect(screen.getByText('DUD').closest('tr')!.querySelector('.loss')).toBeTruthy();
  });

  it('draws the momentum bar in proportion to the score', async () => {
    const rows = [coin({ momentumScore: 94 }), coin({ mint: 'Other', symbol: 'DUD', momentumScore: 12 })];
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => rows) })} />);
    await waitFor(() => expect(screen.getByText('DUD')).toBeInTheDocument());
    const fills = screen.getAllByTestId('meter-fill');
    expect(fills[0]).toHaveStyle({ width: '94%' });
    expect(fills[1]).toHaveStyle({ width: '12%' });
    // Regression: as a <span> the fill was inline, so no width ever applied.
    expect(fills[0].tagName).toBe('DIV');
  });

  it('names a coin with no symbol by its mint, rather than leaving the row blank', async () => {
    const rows = [coin({ symbol: '  ', mint: 'MintMintMintMintMintMintMintMintMintMint11' })];
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => rows) })} />);
    await waitFor(() => expect(screen.getAllByText('Mint…nt11').length).toBeGreaterThan(0));
  });

  it('clamps a corrupt score so the bar cannot overflow its track', async () => {
    const rows = [coin({ momentumScore: 250 }), coin({ mint: 'B', symbol: 'NEG', momentumScore: -40 })];
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => rows) })} />);
    await waitFor(() => expect(screen.getByText('NEG')).toBeInTheDocument());
    const fills = screen.getAllByTestId('meter-fill');
    expect(fills[0]).toHaveStyle({ width: '100%' });
    expect(fills[1]).toHaveStyle({ width: '0%' });
    // The number stays honest about what was actually reported.
    expect(screen.getByText('250')).toBeInTheDocument();
  });

  it('shows a zero-width bar rather than a full one when the score is missing', async () => {
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => [coin({ momentumScore: null })]) })} />);
    await waitFor(() => expect(screen.getByText('PEPE')).toBeInTheDocument());
    expect(screen.getByTestId('meter-fill')).toHaveStyle({ width: '0%' });
  });

  it('shows a dash for a stat the provider did not return', async () => {
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => [coin({ stats: null })]) })} />);
    await waitFor(() => expect(screen.getByText('PEPE')).toBeInTheDocument());
    const row = within(screen.getByText('PEPE').closest('tr')!);
    // Age and 5m volume; the change column falls back to 0.0% instead.
    expect(row.getAllByText('—')).toHaveLength(2);
  });

  it('says how long ago it found each coin, which the age column does not', async () => {
    // "Age" is the token's age WHEN FOUND — it never changes. How stale the
    // signal is now is the number that decides whether to act on it.
    const now = Date.now();
    const rows = [
      coin({ mint: 'A', symbol: 'FRESH', firstSeenAt: new Date(now - 30_000).toISOString() }),
      coin({ mint: 'B', symbol: 'MINS', firstSeenAt: new Date(now - 12 * 60_000).toISOString() }),
      coin({ mint: 'C', symbol: 'HOURS', firstSeenAt: new Date(now - 5 * 3_600_000).toISOString() }),
      coin({ mint: 'D', symbol: 'DAYS', firstSeenAt: new Date(now - 3 * 86_400_000).toISOString() }),
    ];
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => rows) })} />);
    await waitFor(() => expect(screen.getByText('DAYS')).toBeInTheDocument());
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(screen.getByText('12m ago')).toBeInTheDocument();
    expect(screen.getByText('5h ago')).toBeInTheDocument();
    expect(screen.getByText('3d ago')).toBeInTheDocument();
  });

  it('shows a dash rather than NaN when the timestamp is unusable', async () => {
    const rows = [coin({ firstSeenAt: 'not a date' })];
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => rows) })} />);
    await waitFor(() => expect(screen.getByText('PEPE')).toBeInTheDocument());
    expect(within(screen.getByText('PEPE').closest('tr')!).getByText('—')).toBeInTheDocument();
  });

  it('re-reads the list when the scanner publishes a new coin', async () => {
    const engine = fakeEngine({ listCoins: vi.fn(async () => [coin()]) });
    const { rerender } = render(<CoinsTab engine={engine} liveToken={1} />);
    await waitFor(() => expect(engine.listCoins).toHaveBeenCalledTimes(1));
    rerender(<CoinsTab engine={engine} liveToken={2} />);
    await waitFor(() => expect(engine.listCoins).toHaveBeenCalledTimes(2));
  });

  it('links each coin to Axiom by mint', async () => {
    render(<CoinsTab engine={fakeEngine({ listCoins: vi.fn(async () => [coin()]) })} />);
    await waitFor(() => expect(screen.getByText('Axiom')).toBeInTheDocument());
    expect(screen.getByText('Axiom')).toHaveAttribute(
      'href',
      'https://axiom.trade/t/MintMintMintMintMintMintMintMintMintMint11'
    );
  });

  it('surfaces an engine failure', async () => {
    const engine = fakeEngine({
      listCoins: vi.fn(async () => {
        throw new EngineError('unauthorized', 401);
      }),
    });
    render(<CoinsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('unauthorized')).toBeInTheDocument());
  });
});

describe('CallsTab', () => {
  const handle = { id: 1, handle: 'ansem', lastTweetId: null, addedAt: '2026-09-01T00:00:00.000Z' };
  const tweet = (over: Partial<StoredTweet> = {}): StoredTweet => ({
    id: '1900000000000000002',
    handle: 'ansem',
    authorName: 'Ansem',
    authorAvatarUrl: 'https://pbs.twimg.com/a.jpg',
    text: 'sending it',
    media: [],
    url: 'https://x.com/ansem/status/1900000000000000002',
    likeCount: 12,
    replyCount: 3,
    postedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
  });

  it('points at both ways to follow an account when none are', async () => {
    render(<CallsTab engine={fakeEngine()} />);
    await waitFor(() => expect(screen.getByText('No accounts followed yet.')).toBeInTheDocument());
    expect(screen.getByText('/track twitter')).toBeInTheDocument();
  });

  it('follows a handle through the engine, so the bot sees it too', async () => {
    const engine = fakeEngine();
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(engine.listHandles).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('X handle'), { target: { value: '  @ansem  ' } });
    fireEvent.click(screen.getByText('Follow'));
    await waitFor(() => expect(engine.trackHandle).toHaveBeenCalledWith('@ansem'));
  });

  it('cannot submit an empty handle', async () => {
    render(<CallsTab engine={fakeEngine()} />);
    await waitFor(() => expect(screen.getByText('Follow')).toBeDisabled());
  });

  it('lists followed handles as removable chips', async () => {
    const engine = fakeEngine({ listHandles: vi.fn(async () => [handle]) });
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('@ansem')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Stop following @ansem'));
    await waitFor(() => expect(engine.untrackHandle).toHaveBeenCalledWith(1));
  });

  it('renders a tweet card with author, handle, text and a link back to X', async () => {
    const engine = fakeEngine({ listHandles: vi.fn(async () => [handle]), listTweets: vi.fn(async () => [tweet()]) });
    render(<CallsTab engine={engine} />);

    await waitFor(() => expect(screen.getByText('sending it')).toBeInTheDocument());
    expect(screen.getByText('Ansem')).toBeInTheDocument();
    expect(screen.getByAltText('Ansem avatar')).toHaveAttribute('src', 'https://pbs.twimg.com/a.jpg');
    expect(screen.getByText('View on X')).toHaveAttribute(
      'href',
      'https://x.com/ansem/status/1900000000000000002'
    );
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  it('falls back to a generated mark when an avatar url has rotted', async () => {
    const engine = fakeEngine({ listHandles: vi.fn(async () => [handle]), listTweets: vi.fn(async () => [tweet()]) });
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(screen.getByAltText('Ansem avatar')).toBeInTheDocument());

    fireEvent.error(screen.getByAltText('Ansem avatar'));
    expect(screen.getByLabelText('Identicon for ansem')).toBeInTheDocument();
  });

  it('shows an attached picture, and drops it if it fails to load', async () => {
    const withMedia = tweet({ media: [{ type: 'photo', url: 'https://pbs/1.jpg' }] });
    const engine = fakeEngine({
      listHandles: vi.fn(async () => [handle]),
      listTweets: vi.fn(async () => [withMedia]),
    });
    const { container } = render(<CallsTab engine={engine} />);
    await waitFor(() => expect(container.querySelector('.tweet-media')).toBeTruthy());

    fireEvent.error(container.querySelector('.tweet-media')!);
    expect(container.querySelector('.tweet-media')).toBeNull();
  });

  it('explains that only discovery needs a key, when the engine has none', async () => {
    const engine = fakeEngine({
      listHandles: vi.fn(async () => [handle]),
      getHealth: vi.fn(async () => ({ ok: true, features: { coinScanner: true, tweetMonitor: false } })),
    });
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('Nothing posted yet.')).toBeInTheDocument());
    expect(screen.getByText('TWITTER_API_KEY')).toBeInTheDocument();
  });

  it('still renders tweets when the health check fails outright', async () => {
    const engine = fakeEngine({
      listHandles: vi.fn(async () => [handle]),
      listTweets: vi.fn(async () => [tweet()]),
      getHealth: vi.fn(async () => {
        throw new EngineError('not found', 404);
      }),
    });
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('sending it')).toBeInTheDocument());
  });

  it('does not blame a missing key when the engine already has one', async () => {
    const engine = fakeEngine({ listHandles: vi.fn(async () => [handle]) });
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('Nothing posted yet.')).toBeInTheDocument());
    expect(screen.queryByText('TWITTER_API_KEY')).not.toBeInTheDocument();
  });

  it('re-reads when a tweet alert lands', async () => {
    const engine = fakeEngine({ listHandles: vi.fn(async () => [handle]) });
    const { rerender } = render(<CallsTab engine={engine} liveToken={1} />);
    await waitFor(() => expect(engine.listTweets).toHaveBeenCalledTimes(1));
    rerender(<CallsTab engine={engine} liveToken={2} />);
    await waitFor(() => expect(engine.listTweets).toHaveBeenCalledTimes(2));
  });

  it('re-reads the followed list on a timer, so a Discord follow shows up', async () => {
    // `/track twitter` writes the same rows and publishes no alert, so nothing
    // pushes that change.
    let rows: typeof handle[] = [];
    const engine = fakeEngine({ listHandles: vi.fn(async () => rows) });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(screen.getByText('No accounts followed yet.')).toBeInTheDocument());

    rows = [handle];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await waitFor(() => expect(screen.getByText('@ansem')).toBeInTheDocument());
    vi.useRealTimers();
  });

  it('surfaces why the engine refused a handle', async () => {
    const engine = fakeEngine({
      trackHandle: vi.fn(async () => {
        throw new EngineError('that is not an X handle', 400);
      }),
    });
    render(<CallsTab engine={engine} />);
    await waitFor(() => expect(engine.listHandles).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('X handle'), { target: { value: 'nope nope' } });
    fireEvent.click(screen.getByText('Follow'));
    await waitFor(() => expect(screen.getByText('that is not an X handle')).toBeInTheDocument());
  });
});

describe('PnlTab', () => {
  const pnl = (date: string, sol: number, trades = 2): DailyPnl => ({
    date,
    realizedPnlSol: sol,
    tradeCount: trades,
  });

  it('asks for a wallet first rather than charting nothing', () => {
    render(<PnlTab engine={fakeEngine()} wallets={[]} />);
    expect(screen.getByText('Nothing to chart yet.')).toBeInTheDocument();
  });

  it('defaults to your own wallet', async () => {
    const engine = fakeEngine();
    const wallets = [wallet({ id: 1, label: 'other' }), wallet({ id: 2, label: 'mine', isMine: true })];
    render(<PnlTab engine={engine} wallets={wallets} />);
    await waitFor(() => expect(engine.listPnl).toHaveBeenCalledWith(2));
  });

  it('summarises only the month on screen', async () => {
    const rows = [pnl('2026-09-01', 2), pnl('2026-09-02', -1), pnl('2026-08-31', 100)];
    const engine = fakeEngine({ listPnl: vi.fn(async () => rows) });
    const { container } = render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() => expect(container.querySelectorAll('.cal-cell').length).toBeGreaterThan(0));
    // September only: +2 and -1 net to +1, and August's 100 is excluded.
    expect(screen.getByText('+1.0000')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows a dash, not 0%, when the month had no trading days', async () => {
    const engine = fakeEngine({ listPnl: vi.fn(async () => [pnl('2026-09-01', 0, 0)]) });
    render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() => expect(screen.getByText('Win rate')).toBeInTheDocument());
    expect(screen.getByText('Win rate').nextElementSibling).toHaveTextContent('—');
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('falls back to a real wallet when the selected one is untracked', async () => {
    const a = wallet({ id: 1, label: 'aaa' });
    const b = wallet({ id: 2, label: 'bbb' });
    const engine = fakeEngine();
    const { rerender } = render(<PnlTab engine={engine} wallets={[a, b]} />);
    fireEvent.change(screen.getByLabelText('Wallet'), { target: { value: '2' } });
    await waitFor(() => expect(engine.listPnl).toHaveBeenCalledWith(2));

    // Wallet 2 goes away — untracked here, or from Discord.
    rerender(<PnlTab engine={engine} wallets={[a]} />);
    await waitFor(() => expect(engine.listPnl).toHaveBeenLastCalledWith(1));
  });

  it('clears a stale error once a later read succeeds', async () => {
    let fail = true;
    const engine = fakeEngine({
      listPnl: vi.fn(async () => {
        if (fail) throw new EngineError('pnl unavailable', 500);
        return [];
      }),
    });
    const a = wallet({ id: 1, label: 'aaa' });
    const b = wallet({ id: 2, label: 'bbb' });
    render(<PnlTab engine={engine} wallets={[a, b]} />);
    await waitFor(() => expect(screen.getByText('pnl unavailable')).toBeInTheDocument());

    fail = false;
    fireEvent.change(screen.getByLabelText('Wallet'), { target: { value: '2' } });
    await waitFor(() => expect(screen.queryByText('pnl unavailable')).not.toBeInTheDocument());
  });

  it('walks back a month, and across a year boundary', async () => {
    render(<PnlTab engine={fakeEngine()} wallets={[wallet()]} />);
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText('2025-12')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('2026-01')).toBeInTheDocument();
  });

  it('scales the colour bands against the month rather than an absolute figure', async () => {
    const rows = [pnl('2026-09-01', 10), pnl('2026-09-02', 1), pnl('2026-09-03', -10), pnl('2026-09-04', -1)];
    const engine = fakeEngine({ listPnl: vi.fn(async () => rows) });
    const { container } = render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() => expect(container.querySelectorAll('.cal-cell').length).toBeGreaterThan(0));
    const level = (date: string) =>
      container.querySelector(`[title^="${date}"]`)?.getAttribute('data-level');
    expect(level('2026-09-01')).toBe('gain-2');
    expect(level('2026-09-02')).toBe('gain-1');
    expect(level('2026-09-03')).toBe('loss-2');
    expect(level('2026-09-04')).toBe('loss-1');
  });

  it('reads out the full day, not just its number', async () => {
    const engine = fakeEngine({ listPnl: vi.fn(async () => [pnl('2026-09-01', 2, 3)]) });
    render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() =>
      expect(screen.getByLabelText('2026-09-01: 2.0000 SOL, 3 trades')).toBeInTheDocument()
    );
  });

  it('leaves a day with no trades unlevelled', async () => {
    const engine = fakeEngine({ listPnl: vi.fn(async () => [pnl('2026-09-01', 0, 0)]) });
    const { container } = render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() => expect(container.querySelectorAll('.cal-cell').length).toBeGreaterThan(0));
    expect(container.querySelector('[title^="2026-09-01"]')?.getAttribute('data-level')).toBe('none');
  });

  it('opens that day trades when a cell is clicked', async () => {
    const engine = fakeEngine({
      listPnl: vi.fn(async () => [pnl('2026-09-03', 2)]),
      listTrades: vi.fn(async () => [trade({ ts: '2026-09-03T10:00:00.000Z' }), trade({ id: 2, ts: '2026-09-04T10:00:00.000Z' })]),
    });
    const { container } = render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() => expect(container.querySelector('[title^="2026-09-03"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[title^="2026-09-03"]')!);
    // Only the clicked day, not the whole history.
    await waitFor(() => expect(screen.getAllByText('BUY')).toHaveLength(1));
  });

  it('says so when a clicked day has no trades', async () => {
    const engine = fakeEngine({ listPnl: vi.fn(async () => [pnl('2026-09-03', 0, 0)]) });
    const { container } = render(<PnlTab engine={engine} wallets={[wallet()]} />);
    await waitFor(() => expect(container.querySelector('[title^="2026-09-03"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[title^="2026-09-03"]')!);
    await waitFor(() => expect(screen.getByText('No trades recorded on this day.')).toBeInTheDocument());
  });
});

describe('SettingsTab', () => {
  const connection = { httpUrl: 'http://localhost:8787', wsUrl: 'ws://localhost:8787/ws', apiKey: 'k' };

  function renderSettings(over: Partial<Record<string, unknown>> = {}) {
    const engine = (over.engine as EngineClient) ?? fakeEngine();
    const onWalletsChanged = vi.fn();
    const onConnectionChange = vi.fn();
    render(
      <SettingsTab
        engine={engine}
        wallets={(over.wallets as Wallet[]) ?? []}
        connection={connection}
        onConnectionChange={onConnectionChange}
        onWalletsChanged={onWalletsChanged}
      />
    );
    return { engine, onWalletsChanged, onConnectionChange };
  }

  it('tracks a wallet through the engine, so the bot sees it too', async () => {
    const { engine, onWalletsChanged } = renderSettings();
    fireEvent.change(screen.getByLabelText('Solana address'), { target: { value: ADDR_B } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'degen' } });
    fireEvent.click(screen.getByText('Track wallet'));
    await waitFor(() => expect(engine.trackWallet).toHaveBeenCalledWith(ADDR_B, 'degen', false));
    expect(onWalletsChanged).toHaveBeenCalled();
  });

  it('supplies a label when the user left it blank, since the engine requires one', async () => {
    const { engine } = renderSettings();
    fireEvent.change(screen.getByLabelText('Solana address'), { target: { value: ADDR_B } });
    fireEvent.click(screen.getByText('Track wallet'));
    await waitFor(() => expect(engine.trackWallet).toHaveBeenCalledWith(ADDR_B, 'BBBB…2222', false));
  });

  it('trims surrounding whitespace off a pasted address', async () => {
    const { engine } = renderSettings();
    fireEvent.change(screen.getByLabelText('Solana address'), { target: { value: `  ${ADDR_B}  ` } });
    fireEvent.click(screen.getByText('Track wallet'));
    await waitFor(() => expect(engine.trackWallet).toHaveBeenCalledWith(ADDR_B, 'BBBB…2222', false));
  });

  it('cannot submit an empty address', () => {
    renderSettings();
    expect(screen.getByText('Track wallet')).toBeDisabled();
  });

  it('shows why the engine refused, and keeps what was typed', async () => {
    const engine = fakeEngine({
      trackWallet: vi.fn(async () => {
        throw new EngineError('that address is already tracked', 409);
      }),
    });
    renderSettings({ engine });
    fireEvent.change(screen.getByLabelText('Solana address'), { target: { value: ADDR_B } });
    fireEvent.click(screen.getByText('Track wallet'));
    await waitFor(() => expect(screen.getByText('that address is already tracked')).toBeInTheDocument());
    expect(screen.getByLabelText('Solana address')).toHaveValue(ADDR_B);
  });

  it('renames a wallet without destroying its history', () => {
    // The only alternative was untrack-and-retrack, which deletes the trades
    // and PnL under it and costs a fresh Helius backfill to get back.
    const { engine } = renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByLabelText('Edit whale'));
    fireEvent.change(screen.getByLabelText('Label for AAAA…1111'), { target: { value: '  Ansem  ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(engine.updateWallet).toHaveBeenCalledWith(1, { label: 'Ansem', isMine: false });
    expect(engine.untrackWallet).not.toHaveBeenCalled();
  });

  it('marks a wallet as yours after the fact', () => {
    const { engine } = renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByLabelText('Edit whale'));
    fireEvent.click(screen.getByLabelText('Mark AAAA…1111 as yours'));
    fireEvent.click(screen.getByText('Save'));
    expect(engine.updateWallet).toHaveBeenCalledWith(1, { label: 'whale', isMine: true });
  });

  it('cannot save an empty label, which the engine would refuse anyway', () => {
    renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByLabelText('Edit whale'));
    fireEvent.change(screen.getByLabelText('Label for AAAA…1111'), { target: { value: '   ' } });
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('discards an edit that was cancelled', () => {
    const { engine } = renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByLabelText('Edit whale'));
    fireEvent.change(screen.getByLabelText('Label for AAAA…1111'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(engine.updateWallet).not.toHaveBeenCalled();

    // Reopening starts from the stored value, not from what was abandoned.
    fireEvent.click(screen.getByLabelText('Edit whale'));
    expect(screen.getByLabelText('Label for AAAA…1111')).toHaveValue('whale');
  });

  it('keeps the edit on screen when the engine refuses it', async () => {
    const engine = fakeEngine({
      updateWallet: vi.fn(async () => {
        throw new EngineError('label must be 100 characters or fewer', 400);
      }),
    });
    renderSettings({ engine, wallets: [wallet()] });
    fireEvent.click(screen.getByLabelText('Edit whale'));
    fireEvent.change(screen.getByLabelText('Label for AAAA…1111'), { target: { value: 'too long' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('label must be 100 characters or fewer')).toBeInTheDocument());
    expect(screen.getByLabelText('Label for AAAA…1111')).toHaveValue('too long');
  });

  it('asks before deleting a wallet history', () => {
    const { engine } = renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByText('Untrack'));
    expect(screen.getByText('Delete its history?')).toBeInTheDocument();
    expect(engine.untrackWallet).not.toHaveBeenCalled();
  });

  it('untracks a wallet once confirmed', async () => {
    const { engine, onWalletsChanged } = renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByText('Untrack'));
    fireEvent.click(screen.getByLabelText('Confirm untracking whale'));
    await waitFor(() => expect(engine.untrackWallet).toHaveBeenCalledWith(1));
    expect(onWalletsChanged).toHaveBeenCalled();
  });

  it('keeps the wallet when the confirmation is declined', () => {
    const { engine } = renderSettings({ wallets: [wallet()] });
    fireEvent.click(screen.getByText('Untrack'));
    fireEvent.click(screen.getByText('Keep'));
    expect(screen.queryByText('Delete its history?')).not.toBeInTheDocument();
    expect(engine.untrackWallet).not.toHaveBeenCalled();
  });

  it('reports a failed untrack rather than pretending it worked', async () => {
    const engine = fakeEngine({
      untrackWallet: vi.fn(async () => {
        throw new EngineError('wallet not found', 404);
      }),
    });
    renderSettings({ engine, wallets: [wallet()] });
    fireEvent.click(screen.getByText('Untrack'));
    fireEvent.click(screen.getByLabelText('Confirm untracking whale'));
    await waitFor(() => expect(screen.getByText('wallet not found')).toBeInTheDocument());
  });

  it('reports what the engine says it is doing', async () => {
    const engine = fakeEngine({
      getHealth: vi.fn(async () => ({ ok: true, features: { coinScanner: true, tweetMonitor: false } })),
    });
    renderSettings({ engine });

    await waitFor(() => expect(screen.getByText('Connected.')).toBeInTheDocument());
    const line = screen.getByText('Connected.').closest('p')!;
    expect(line).toHaveTextContent('Coin scanner on');
    expect(line).toHaveTextContent('tweet monitor off');
  });

  it.each([
    [0, 'Not reachable.'],
    [401, 'Not authorised.'],
    [404, 'Engine is older than this app.'],
    [500, 'Status unavailable.'],
  ])('names the failure behind status %i, because the fixes differ', async (status, heading) => {
    // A 404 especially is NOT unreachable: the engine answered, it just
    // predates the route. Saying "unreachable" sends someone to check a URL
    // and a key that are both fine.
    const engine = fakeEngine({
      getHealth: vi.fn(async () => {
        throw new EngineError('boom', status);
      }),
    });
    renderSettings({ engine });

    await waitFor(() => expect(screen.getByText(heading)).toBeInTheDocument());
  });

  it('labels every engine field visibly, since they arrive pre-filled', () => {
    renderSettings();
    for (const name of ['HTTP URL', 'WebSocket URL', 'API key']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('confirms that the connection was saved', () => {
    renderSettings();
    expect(screen.queryByText('Saved. Reconnecting.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Save connection'));
    expect(screen.getByText('Saved. Reconnecting.')).toBeInTheDocument();
  });

  it('drops the saved notice once the form is edited again', () => {
    renderSettings();
    fireEvent.click(screen.getByText('Save connection'));
    fireEvent.change(screen.getByLabelText('Engine API key'), { target: { value: 'x' } });
    expect(screen.queryByText('Saved. Reconnecting.')).not.toBeInTheDocument();
  });

  it('saves the connection only when submitted', () => {
    const { onConnectionChange } = renderSettings();
    fireEvent.change(screen.getByLabelText('Engine API key'), { target: { value: 'new-key' } });
    expect(onConnectionChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save connection'));
    expect(onConnectionChange).toHaveBeenCalledWith({ ...connection, apiKey: 'new-key' });
  });

  it('masks the api key on screen', () => {
    renderSettings();
    expect(screen.getByLabelText('Engine API key')).toHaveAttribute('type', 'password');
  });
});
