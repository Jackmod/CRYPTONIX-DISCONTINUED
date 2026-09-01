import { useState } from 'react';
import type { EngineClient, Wallet } from '../api/client';
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortWallets(wallets).map((wallet) => (
                <tr key={wallet.id} className={wallet.isMine ? 'row-pinned' : undefined}>
                  <td>
                    <div className="ident">
                      <Identicon address={wallet.address} />
                      <span className="ident-name" title={displayLabel(wallet)}>
                      {displayLabel(wallet)}
                    </span>
                    </div>
                  </td>
                  <td style={{ color: 'var(--dim)' }}>{shortAddress(wallet.address)}</td>
                  <td className="num">
                    <UntrackButton wallet={wallet} onConfirm={() => remove(wallet)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="stat-label" style={{ marginBottom: 'var(--s3)' }}>
        Engine
      </h2>
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
