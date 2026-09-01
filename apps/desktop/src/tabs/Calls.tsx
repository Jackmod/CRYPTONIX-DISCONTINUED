import { useCallback, useEffect, useState } from 'react';
import type { EngineClient, EngineHealth, StoredTweet, TrackedHandle } from '../api/client';
import { ExternalLink } from '../components/ExternalLink';
import { Identicon } from '../components/Identicon';

/**
 * How often to re-read the followed list.
 *
 * `/track twitter` in Discord writes the same rows and publishes no alert, so
 * nothing pushes that change — the same reason the wallet list is polled. Only
 * while this tab is open, since that is the only time it is visible.
 */
const HANDLE_POLL_MS = 20_000;

/** How long ago, in the shortest form that is still true. */
function timeAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * An author's real avatar, falling back to a generated mark.
 *
 * Spec §5.3 wants the real picture wherever one exists. An avatar URL can rot
 * — accounts change them and X expires the old file — so a broken image is a
 * real case, not a theoretical one.
 */
function Avatar({ tweet }: { tweet: StoredTweet }) {
  const [failed, setFailed] = useState(false);

  if (!tweet.authorAvatarUrl || failed) return <Identicon address={tweet.handle} size={32} />;

  return (
    <img
      className="avatar"
      src={tweet.authorAvatarUrl}
      alt={`${tweet.authorName} avatar`}
      width={32}
      height={32}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function TweetCard({ tweet, now }: { tweet: StoredTweet; now: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const image = tweet.media.find((m) => m.type === 'photo' || m.type === 'animated_gif');

  return (
    <article className="tweet">
      <div className="tweet-head">
        <Avatar tweet={tweet} />
        <div style={{ minWidth: 0 }}>
          <div className="ident-name">{tweet.authorName}</div>
          <div className="ident-sub">@{tweet.handle}</div>
        </div>
        <time className="tweet-age" dateTime={tweet.postedAt} title={new Date(tweet.postedAt).toLocaleString()}>
          {timeAgo(tweet.postedAt, now)}
        </time>
      </div>

      {/* Whitespace preserved: a tweet's line breaks carry its meaning. */}
      <p className="tweet-text">{tweet.text}</p>

      {image && !imageFailed && (
        <img className="tweet-media" src={image.url} alt="" loading="lazy" onError={() => setImageFailed(true)} />
      )}

      <div className="tweet-foot">
        {tweet.likeCount !== null && <span>{tweet.likeCount.toLocaleString()} likes</span>}
        {tweet.replyCount !== null && <span>{tweet.replyCount.toLocaleString()} replies</span>}
        <ExternalLink href={tweet.url}>View on X</ExternalLink>
      </div>
    </article>
  );
}

/**
 * Tracked handles and their tweets (spec §5.3).
 *
 * Everything here except discovery works without a key: the cards render from
 * what the engine has stored, and adding or removing a handle is a plain
 * write. What needs `TWITTER_API_KEY` is the engine finding out that a handle
 * has posted — X's free tier is write-only, and Nitter was taken down in
 * August 2026 — so without one this fills up only as far as history goes.
 */
export function CallsTab({ engine, liveToken = 0 }: { engine: EngineClient; liveToken?: number }) {
  const [handles, setHandles] = useState<TrackedHandle[] | null>(null);
  const [tweets, setTweets] = useState<StoredTweet[] | null>(null);
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([engine.listHandles(), engine.listTweets(100)])
      .then(([h, t]) => {
        if (cancelled) return;
        setHandles(h);
        setTweets(t);
        setError(null);
      })
      .catch((err) => !cancelled && setError((err as Error).message));

    // Asked for separately, and allowed to fail. It only sharpens the wording
    // of an empty state; an engine too old to have /health, or a proxy
    // answering something unexpected, must not cost this tab its actual data.
    engine
      .getHealth()
      .then((hp) => !cancelled && setHealth(hp))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
    // liveToken: a tweet alert arrives on the same socket as everything else,
    // and a feed that never refreshes goes stale while it is open.
  }, [engine, reloadToken, liveToken]);

  useEffect(() => {
    const timer = setInterval(reload, HANDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await engine.trackHandle(input.trim());
      setInput('');
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (handle: TrackedHandle) => {
    setError(null);
    try {
      await engine.untrackHandle(handle.id);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Fixed per render, so every card's age is measured from one instant.
  const now = Date.now();

  return (
    <>
      <div className="view-head">
        <h1 className="view-title">Calls</h1>
        <span className="view-sub">tweets from tracked accounts</span>
      </div>

      {error && <div className="banner">{error}</div>}

      <form onSubmit={add} style={{ display: 'flex', gap: 'var(--s2)', marginBottom: 'var(--s4)' }}>
        <input
          className="input"
          style={{ flex: '1 1 260px', maxWidth: 340 }}
          placeholder="@handle, or a link to the profile"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="X handle"
          required
        />
        <button className="btn btn-primary" disabled={busy || input.trim() === ''}>
          {busy ? 'Adding…' : 'Follow'}
        </button>
      </form>

      {handles && handles.length > 0 && (
        <div className="chips">
          {handles.map((handle) => (
            <span className="chip" key={handle.id}>
              @{handle.handle}
              <button
                className="chip-x"
                onClick={() => remove(handle)}
                aria-label={`Stop following @${handle.handle}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {handles !== null && handles.length === 0 && !error && (
        <div className="empty">
          <div className="empty-title">No accounts followed yet.</div>
          Add one above, or run <code>/track twitter</code> from Discord — both write to the same list.
        </div>
      )}

      {tweets !== null && tweets.length === 0 && handles !== null && handles.length > 0 && (
        /*
         * Two different situations, and telling them apart matters: the engine
         * knows whether it is even looking. Saying "set TWITTER_API_KEY" when
         * it IS set sends the reader to fix the wrong thing.
         */
        <div className="empty">
          <div className="empty-title">Nothing posted yet.</div>
          {health?.features?.tweetMonitor === false ? (
            <>
              The engine is not looking: <code>TWITTER_API_KEY</code> is unset. Finding out an account
              has posted is the one part of Cryptonix with no free option — X's free tier is
              write-only, and Nitter was taken down in August 2026. Rendering costs nothing, so
              everything else on this screen already works.
            </>
          ) : (
            <>Tweets appear here as the engine finds them.</>
          )}
        </div>
      )}

      <div className="tweets">
        {(tweets ?? []).map((tweet) => (
          <TweetCard key={tweet.id} tweet={tweet} now={now} />
        ))}
      </div>
    </>
  );
}
