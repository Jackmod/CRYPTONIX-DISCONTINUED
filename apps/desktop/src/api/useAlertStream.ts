import { useEffect, useRef, useState } from 'react';
import type { EngineClient } from './client';
import { mergeFeed, toFeedItem, type ConnectionState, type FeedItem } from './feed';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;

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

    const absorb = (incoming: FeedItem[]) => {
      if (incoming.length === 0) return;
      for (const item of incoming) highestId.current = Math.max(highestId.current, item.id);
      setItems((current) => mergeFeed(current, incoming));
    };

    /** Anything published while this client was not listening. */
    const catchUp = async () => {
      try {
        const missed = await engine.listAlertsSince(highestId.current);
        absorb(missed.map(toFeedItem).filter((item): item is FeedItem => item !== null));
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
          const alert = JSON.parse(String(event.data)) as { id: number; type: string; payload: unknown };
          const item = toFeedItem(alert);
          if (item) absorb([item]);
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
