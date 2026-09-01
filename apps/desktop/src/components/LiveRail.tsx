import { useEffect, useRef, useState } from 'react';
import type { FeedItem } from '../api/feed';
import { CoinLogo } from './CoinLogo';
import { Identicon } from './Identicon';
import { ExternalLink } from './ExternalLink';

const KIND_LABEL: Record<FeedItem['kind'], string> = {
  buy: 'BUY',
  sell: 'SELL',
  coin: 'COIN',
  tweet: 'POST',
  other: '—',
};

function clockTime(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/**
 * The persistent live rail: wallet trades and new coins interleaved by time,
 * newest first (spec §5.3).
 *
 * Entries that arrived during this session glow once and settle — the phosphor
 * decay a CRT actually has. Items already present on first render do not, so
 * loading the app does not light up the whole column and teach the user to
 * ignore the signal.
 */
export function LiveRail({ items }: { items: FeedItem[] }) {
  const seen = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    // First render seeds the baseline rather than marking everything new.
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.id));
      return;
    }
    const arrivals = items.filter((i) => !seen.current!.has(i.id)).map((i) => i.id);
    if (arrivals.length === 0) return;
    for (const id of arrivals) seen.current!.add(id);
    setFresh(new Set(arrivals));
  }, [items]);

  return (
    <aside className="rail" aria-label="Live feed">
      <div className="rail-head">
        <span>Live feed</span>
        <span>{items.length}</span>
      </div>
      <div className="rail-body">
        {items.length === 0 ? (
          <div className="empty" style={{ margin: 'var(--s4)' }}>
            <div className="empty-title">Nothing has come through yet.</div>
            Track a wallet, and its trades appear here the moment they happen.
          </div>
        ) : (
          items.map((item) => (
            <div className="tick" key={item.id} data-fresh={fresh.has(item.id)}>
              <time className="tick-time" dateTime={item.at.toISOString()}>
                {clockTime(item.at)}
              </time>
              <div className="tick-body">
                <div className="tick-line">
                  <span className="tick-kind" data-kind={item.kind}>
                    {KIND_LABEL[item.kind]}
                  </span>
                  {item.kind === 'coin' || item.kind === 'tweet' ? (
                    // Both carry a real picture when one exists, and fall back
                    // to a generated mark keyed on their own identity.
                    <CoinLogo mint={item.what} symbol={item.what} imageUrl={item.imageUrl} size={16} />
                  ) : (
                    <Identicon address={item.what} size={16} />
                  )}
                  <span className="tick-what">{item.what}</span>
                </div>
                <div className="tick-detail">
                  {item.detail}
                  {item.link && (
                    <>
                      {' · '}
                      <ExternalLink href={item.link}>{item.kind === 'tweet' ? 'X' : 'Axiom'}</ExternalLink>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
