import { useCallback, useEffect, useMemo, useState } from 'react';
import { EngineClient, type Wallet } from './api/client';
import { useAlertStream } from './api/useAlertStream';
import { LiveRail } from './components/LiveRail';
import { StatusCursor } from './components/StatusCursor';
import { WalletsTab } from './tabs/Wallets';
import { CoinsTab } from './tabs/Coins';
import { CallsTab } from './tabs/Calls';
import { PnlTab } from './tabs/Pnl';
import { SettingsTab, type Connection } from './tabs/Settings';

const TABS = ['Wallets', 'Coins', 'Calls', 'PnL', 'Settings'] as const;
type Tab = (typeof TABS)[number];

const STORAGE_KEY = 'cryptonix.connection';

/** How often to re-read the wallet list. Small payload, no rush. */
const WALLET_POLL_MS = 20_000;

const DEFAULT_CONNECTION: Connection = {
  httpUrl: 'http://localhost:8787',
  wsUrl: 'ws://localhost:8787/ws',
  apiKey: '',
};

/**
 * Connection settings persist on this machine only.
 *
 * Wrapped because storage throws outright in some contexts (a private window,
 * blocked site data), and a settings read must never stop the app rendering.
 */
function loadConnection(): Connection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONNECTION;
    const parsed = JSON.parse(raw) as Partial<Connection>;
    return {
      httpUrl: typeof parsed.httpUrl === 'string' ? parsed.httpUrl : DEFAULT_CONNECTION.httpUrl,
      wsUrl: typeof parsed.wsUrl === 'string' ? parsed.wsUrl : DEFAULT_CONNECTION.wsUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return DEFAULT_CONNECTION;
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>('Wallets');
  const [connection, setConnection] = useState<Connection>(loadConnection);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletsError, setWalletsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Rebuilt only when the connection changes, so every child sees a stable
  // client and effects keyed on it do not re-run on each render.
  const engine = useMemo(
    () => new EngineClient(connection.httpUrl, connection.apiKey),
    [connection.httpUrl, connection.apiKey]
  );

  const { items, state } = useAlertStream(engine, connection.wsUrl, connection.apiKey);

  const refreshWallets = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    engine
      .listWallets()
      .then((rows) => {
        if (cancelled) return;
        setWallets(rows);
        setWalletsError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setWallets([]);
        setWalletsError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, reloadToken]);

  /*
   * The wallet list is re-read on a timer.
   *
   * It changes from outside this app: `/track wallet` in Discord writes to the
   * same engine, and a backfill flips its own status when it finishes. Neither
   * publishes an alert, so the socket cannot carry the news and a poll is the
   * only way to see it. Driving this off the alert stream instead re-fetched
   * the list on every single trade, which is both wasteful and still blind to
   * a wallet added while nothing was trading.
   */
  useEffect(() => {
    const timer = setInterval(refreshWallets, WALLET_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshWallets]);

  // A trade, by contrast, does change a wallet's balance and history, so the
  // open detail views re-read themselves when one lands.
  const latestId = items[0]?.id ?? 0;

  const saveConnection = (next: Connection) => {
    setConnection(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not persisting is survivable; the app still works this session.
    }
  };

  return (
    <div className="shell">
      <nav className="nav" aria-label="Sections">
        <div className="wordmark">
          CRYPT<b>O</b>NIX
        </div>
        <ul className="nav-items">
          {TABS.map((name) => (
            <li key={name}>
              <button
                className="nav-item"
                aria-current={tab === name ? 'page' : undefined}
                onClick={() => setTab(name)}
              >
                <span className="nav-label">{name}</span>
                {name === 'Wallets' && wallets.length > 0 && <span className="nav-count">{wallets.length}</span>}
              </button>
            </li>
          ))}
        </ul>
        <StatusCursor state={state} />
      </nav>

      <main className="main">
        {tab === 'Wallets' && (
          <WalletsTab engine={engine} wallets={wallets} error={walletsError} liveToken={latestId} />
        )}
        {tab === 'Coins' && <CoinsTab engine={engine} />}
        {tab === 'Calls' && <CallsTab />}
        {tab === 'PnL' && <PnlTab engine={engine} wallets={wallets} />}
        {tab === 'Settings' && (
          <SettingsTab
            engine={engine}
            wallets={wallets}
            connection={connection}
            onConnectionChange={saveConnection}
            onWalletsChanged={refreshWallets}
          />
        )}
      </main>

      <LiveRail items={items} />
    </div>
  );
}
