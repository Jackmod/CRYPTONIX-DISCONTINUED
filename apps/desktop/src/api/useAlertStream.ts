import { useEffect, useRef, useState } from 'react';
import type { EngineClient } from './client';
import { mergeFeed, toFeedItem, type ConnectionState, type FeedItem } from './feed';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
/** Must match the engine's MAX_ALERT_REPLAY. */
const ENGINE_PAGE_SIZE = 50;
/** The rail holds this many; fetching further back would only be discarded. */
const FEED_CAP = 200;
/** Bounds a walk after a long disconnect: 4 pages is the rail's whole capacity. */
const MAX_CATCH_UP_PAGES = 4;

/**
 * Subscribes to the engine's alert socket and keeps the live rail filled.
 *
 * Mirrors the Discord bot's approach for the same reason: the socket only
 * delivers what is published while it is open, so a trade landing during a
 * reconnect would otherwise never appear. On every connection it asks the
 * engine for anything published since the highest id it has seen.
 *
 * The browser WebSocket cannot set headers, so the API key travels as a query
 * parameter here rather than as Authorization.
 */
export function useAlertStream(engine: EngineClient, wsUrl: string, apiKey: string) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  // A ref, not state: the reconnect closure must read the CURRENT high-water
  // mark, and re-running the effect on every alert would tear the socket down.
  const highestId = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let closed = false;

    type RawAlert = { id: number; type: string; payload: unknown; ts?: string };

    /**
     * Takes in a batch of raw alerts: renders what it can, and marks ALL of
     * them seen.
     *
     * The cursor has to move over every id, not only the ones this build can
     * draw. Advancing it from the rendered items alone meant a page made
     * entirely of alerts this version skips — the tweet alerts from the other
     * half of Phase 3 will do exactly that — left the cursor where it was, so
     * the walk fetched the same page again and never got past it.
     */
    const absorb = (rows: RawAlert[]) => {
      if (rows.length === 0) return;
      for (const row of rows) highestId.current = Math.max(highestId.current, row.id);
      const items = rows.map(toFeedItem).filter((item): item is FeedItem => item !== null);
      if (items.length > 0) setItems((current) => mergeFeed(current, items));
    };

    /**
     * Anything published while this client was not listening.
     *
     * Two different questions, deliberately asked with two different requests.
     * With nothing seen yet there is no cursor to resume from and the rail
     * wants the newest alerts; `/alerts?since=0` would answer with the OLDEST
     * page in the whole history, which is what this used to do. Once a cursor
     * exists, resuming from it is right — and it pages, because a long
     * disconnect leaves more than one page behind and stopping after the first
     * would strand the rail on a stale window.
     */
    const catchUp = async () => {
      try {
        if (highestId.current === 0) {
          absorb(await engine.listRecentAlerts(FEED_CAP));
          return;
        }

        for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
          const missed = await engine.listAlertsSince(highestId.current);
          if (missed.length === 0) return;
          absorb(missed);
          // A short page means the backlog is exhausted. A full one does not,
          // so ask again from the new high-water mark.
          if (missed.length < ENGINE_PAGE_SIZE) return;
        }
      } catch {
        // The socket is the primary path; a failed catch-up is not worth
        // surfacing, and the next reconnect tries again.
      }
    };

    const connect = () => {
      if (closed) return;
      setState((s) => (s === 'live' ? 'connecting' : s));

      const url = `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(apiKey)}`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        if (closed) return;
        backoff = INITIAL_BACKOFF_MS;
        setState('live');
        void catchUp();
      };

      socket.onmessage = (event) => {
        try {
          const alert = JSON.parse(String(event.data)) as RawAlert;
          // Marked seen whether or not it renders, so a live alert this build
          // skips does not leave the cursor behind for the next catch-up.
          if (typeof alert?.id === 'number') absorb([alert]);
        } catch {
          // One malformed frame must not take the feed down.
        }
      };

      socket.onerror = () => {
        // 'close' always follows; reconnecting is driven off that alone so one
        // failure cannot schedule two attempts.
      };

      socket.onclose = () => {
        if (closed) return;
        setState('down');
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    };

    // Fill the rail before the socket is even up, so the app is never blank
    // just because nothing has traded in the last few seconds.
    void catchUp();
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [engine, wsUrl, apiKey]);

  return { items, state };
}
