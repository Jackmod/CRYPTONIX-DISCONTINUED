import { useEffect, useState } from 'react';
import { EngineError, type EngineClient, type EngineHealth, type Wallet } from '../api/client';
import { Identicon } from '../components/Identicon';
import { displayLabel, shortAddress } from '../components/Money';
import { sortWallets } from './Wallets';

export interface Connection {
  httpUrl: string;
  wsUrl: string;
  apiKey: string;
}

/**
 * Untracking deletes that wallet's trades and PnL, and nothing restores them
 * short of a fresh backfill — so the button asks once before it does that.
 */
function UntrackButton({ wallet, onConfirm }: { wallet: Wallet; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button className="btn btn-danger" onClick={() => setArmed(true)}>
        Untrack
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 'var(--s2)', alignItems: 'center' }}>
      <span style={{ color: 'var(--dim)', fontSize: 11 }}>Delete its history?</span>
      <button
        className="btn btn-danger"
        onClick={onConfirm}
        aria-label={`Confirm untracking ${displayLabel(wallet)}`}
      >
        Untrack
      </button>
      <button className="btn" onClick={() => setArmed(false)}>
        Keep
      </button>
    </span>
  );
}

/**
 * One row of the tracked list, editable in place.
 *
 * Renaming goes through the engine's PATCH, not through untrack-and-retrack:
 * that deletes the wallet's trades and PnL and then costs a fresh Helius
 * backfill, which is an absurd price for fixing a typo.
 */
function WalletRow({
  wallet,
  onSave,
  onRemove,
}: {
  wallet: Wallet;
  onSave: (changes: { label: string; isMine: boolean }) => Promise<void>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(wallet.label);
  const [isMine, setIsMine] = useState(wallet.isMine);
  const [busy, setBusy] = useState(false);

  const open = () => {
    // Reopened from the row's current values, not from whatever was typed and
    // abandoned last time.
    setLabel(wallet.label);
    setIsMine(wallet.isMine);
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ label: label.trim(), isMine });
      setEditing(false);
    } catch {
      // The banner above says what the engine refused; the row stays open on
      // the unsaved edit rather than closing as though it had gone through.
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <tr className={wallet.isMine ? 'row-pinned' : undefined}>
        <td>
          <div className="ident">
            <Identicon address={wallet.address} />
            <span className="ident-name" title={displayLabel(wallet)}>
              {displayLabel(wallet)}
            </span>
          </div>
        </td>
        <td style={{ color: 'var(--dim)' }}>{shortAddress(wallet.address)}</td>
        <td style={{ color: 'var(--dim)' }}>{wallet.isMine ? 'yours' : ''}</td>
        <td className="num">
          <span style={{ display: 'inline-flex', gap: 'var(--s2)' }}>
            <button className="btn" onClick={open} aria-label={`Edit ${displayLabel(wallet)}`}>
              Edit
            </button>
            <UntrackButton wallet={wallet} onConfirm={onRemove} />
          </span>
        </td>
      </tr>
    );
  }

  return (
    <tr className={wallet.isMine ? 'row-pinned' : undefined}>
      <td>
        <div className="ident">
          <Identicon address={wallet.address} />
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label={`Label for ${shortAddress(wallet.address)}`}
            autoFocus
          />
        </div>
      </td>
      <td style={{ color: 'var(--dim)' }}>{shortAddress(wallet.address)}</td>
      <td>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s1)', color: 'var(--dim)' }}>
          <input
            type="checkbox"
            checked={isMine}
            onChange={(e) => setIsMine(e.target.checked)}
            aria-label={`Mark ${shortAddress(wallet.address)} as yours`}
          />
          mine
        </label>
      </td>
      <td className="num">
        <span style={{ display: 'inline-flex', gap: 'var(--s2)' }}>
          <button className="btn btn-primary" onClick={save} disabled={busy || label.trim() === ''}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </span>
      </td>
    </tr>
  );
}

/**
 * What the engine reports about itself.
 *
 * The place someone looks when a list is empty and they want to know whether
 * that is the answer or the problem. A failed check is shown as unreachable
 * rather than hidden, because "cannot ask" is itself the useful answer.
 */
function EngineStatus({ engine }: { engine: EngineClient }) {
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [problem, setProblem] = useState<{ heading: string; detail: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProblem(null);
    setHealth(null);
    engine
      .getHealth()
      .then((h) => !cancelled && setHealth(h))
      .catch((err) => !cancelled && setProblem(describeProblem(err)));
    return () => {
      cancelled = true;
    };
  }, [engine]);

  if (problem) {
    return (
      <p className="status-line" role="status">
        <span className="loss">{problem.heading}</span> {problem.detail}
      </p>
    );
  }
  if (health === null) return null;

  return (
    <p className="status-line" role="status">
      <span className="gain">Connected.</span> Coin scanner{' '}
      <b>{health.features?.coinScanner ? 'on' : 'off'}</b>, tweet monitor{' '}
      <b>{health.features?.tweetMonitor ? 'on' : 'off'}</b>.
    </p>
  );
}

/**
 * Says which failure this is, because the fixes are different.
 *
 * A 404 in particular is NOT "unreachable" — the engine answered, it simply
 * predates this route. Reporting that as unreachable sends someone to check a
 * URL and a key that are both fine, when what they need is to update the
 * engine.
 */
function describeProblem(err: unknown): { heading: string; detail: string } {
  const status = err instanceof EngineError ? err.status : undefined;
  if (status === 0) {
    return { heading: 'Not reachable.', detail: 'Check the URL below, and that the engine is running.' };
  }
  if (status === 401) {
    return { heading: 'Not authorised.', detail: 'The key below does not match the engine ENGINE_API_KEY.' };
  }
  if (status === 404) {
    return {
      heading: 'Engine is older than this app.',
      detail: 'It has no /health route. Everything else still works; update the engine to see its status.',
    };
  }
  return { heading: 'Status unavailable.', detail: (err as Error).message };
}

/**
 * Manage tracked wallets and where the app points (spec §5.3).
 *
 * Everything here writes through the engine, which is the single writer — so
 * a wallet added on this screen is the same row `/track wallet` creates in
 * Discord, visible to both immediately, with nothing to synchronise.
 */
export function SettingsTab({
  engine,
  wallets,
  connection,
  onConnectionChange,
  onWalletsChanged,
}: {
  engine: EngineClient;
  wallets: Wallet[];
  connection: Connection;
  onConnectionChange: (next: Connection) => void;
  onWalletsChanged: () => void;
}) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [isMine, setIsMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(connection);
  const [saved, setSaved] = useState(false);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // The engine rejects an empty label with 400, so supply one rather than
      // sending a request that cannot succeed.
      await engine.trackWallet(address.trim(), label.trim() || shortAddress(address.trim()), isMine);
      setAddress('');
      setLabel('');
      setIsMine(false);
      onWalletsChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (wallet: Wallet) => {
    setError(null);
    try {
      await engine.untrackWallet(wallet.id);
      onWalletsChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async (wallet: Wallet, changes: { label: string; isMine: boolean }) => {
    setError(null);
    try {
      await engine.updateWallet(wallet.id, changes);
      onWalletsChanged();
    } catch (err) {
      setError((err as Error).message);
      // Rethrown so the row keeps the unsaved edit on screen.
      throw err;
    }
  };

  return (
    <>
      <div className="view-head">
        <h1 className="view-title">Settings</h1>
      </div>

      {error && <div className="banner">{error}</div>}

      <h2 className="stat-label" style={{ marginBottom: 'var(--s3)' }}>
        Track a wallet
      </h2>
      <form onSubmit={add} style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginBottom: 'var(--s5)' }}>
        <input
          className="input"
          style={{ flex: '2 1 340px' }}
          placeholder="Solana address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          required
          aria-label="Solana address"
        />
        <input
          className="input"
          style={{ flex: '1 1 160px' }}
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="Label"
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s1)', color: 'var(--dim)' }}>
          <input type="checkbox" checked={isMine} onChange={(e) => setIsMine(e.target.checked)} />
          mine
        </label>
        <button className="btn btn-primary" disabled={busy || address.trim() === ''}>
          {busy ? 'Adding…' : 'Track wallet'}
        </button>
      </form>

      <h2 className="stat-label" style={{ marginBottom: 'var(--s3)' }}>
        Tracked wallets
      </h2>
      {wallets.length === 0 ? (
        <div className="empty" style={{ marginBottom: 'var(--s5)' }}>
          Nothing tracked yet. Add an address above.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table" style={{ marginBottom: 'var(--s5)' }}>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Address</th>
                <th>Mine</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortWallets(wallets).map((wallet) => (
                <WalletRow
                  key={wallet.id}
                  wallet={wallet}
                  onSave={(changes) => save(wallet, changes)}
                  onRemove={() => remove(wallet)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="stat-label" style={{ marginBottom: 'var(--s2)' }}>
        Engine
      </h2>
      {/* Keyed on the connection so saving a new one re-checks immediately. */}
      <EngineStatus key={`${connection.httpUrl}|${connection.apiKey}`} engine={engine} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConnectionChange(draft);
          setSaved(true);
        }}
        className="field-list"
      >
        {/* Visible labels, not placeholders: these fields arrive pre-filled, so
            a placeholder would never be on screen when it is needed. */}
        <label className="field">
          <span className="field-label">HTTP URL</span>
          <input
            className="input"
            value={draft.httpUrl}
            onChange={(e) => {
              setDraft({ ...draft, httpUrl: e.target.value });
              setSaved(false);
            }}
            aria-label="Engine HTTP URL"
          />
        </label>
        <label className="field">
          <span className="field-label">WebSocket URL</span>
          <input
            className="input"
            value={draft.wsUrl}
            onChange={(e) => {
              setDraft({ ...draft, wsUrl: e.target.value });
              setSaved(false);
            }}
            aria-label="Engine WebSocket URL"
          />
        </label>
        <label className="field">
          <span className="field-label">API key</span>
          <input
            className="input"
            type="password"
            value={draft.apiKey}
            onChange={(e) => {
              setDraft({ ...draft, apiKey: e.target.value });
              setSaved(false);
            }}
            aria-label="Engine API key"
          />
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s3)' }}>
          <button className="btn btn-primary">Save connection</button>
          {saved && (
            <span role="status" style={{ color: 'var(--dim)', fontSize: 11 }}>
              Saved. Reconnecting.
            </span>
          )}
        </div>
        <p style={{ color: 'var(--dimmer)', fontSize: 11, margin: 0 }}>
          The key must match the engine's <code>ENGINE_API_KEY</code>. It is stored on this machine only.
        </p>
      </form>
    </>
  );
}
