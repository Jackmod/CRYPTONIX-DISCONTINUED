import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAlertStream } from './useAlertStream';
import type { AlertRecord, EngineClient } from './client';

/**
 * A WebSocket stand-in with no timers and no network.
 *
 * The hook's whole job is surviving a socket that drops, so the test needs to
 * drop it on demand rather than wait for a real one to fail.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closedByClient = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close() {
    this.closedByClient = true;
  }

  open() {
    act(() => this.onopen?.());
  }

  drop() {
    act(() => this.onclose?.());
  }

  deliver(data: unknown) {
    act(() => this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }
}

function engineWith(
  alerts: AlertRecord[] | (() => Promise<AlertRecord[]>),
  recent?: AlertRecord[] | (() => Promise<AlertRecord[]>)
): {
  engine: EngineClient;
  calls: number[];
  recentCalls: number[];
} {
  const calls: number[] = [];
  const recentCalls: number[] = [];
  const listAlertsSince = vi.fn(async (since: number) => {
    calls.push(since);
    return typeof alerts === 'function' ? alerts() : alerts;
  });
  // With nothing seen yet the hook seeds from /alerts/recent, not from a
  // cursor of 0 — so unless a test says otherwise, that answers the same rows.
  const source = recent ?? alerts;
  const listRecentAlerts = vi.fn(async (limit: number) => {
    recentCalls.push(limit);
    return typeof source === 'function' ? source() : source;
  });
  return {
    engine: { listAlertsSince, listRecentAlerts } as unknown as EngineClient,
    calls,
    recentCalls,
  };
}

function alert(id: number, label = 'whale'): AlertRecord {
  return {
    id,
    type: 'wallet_buy',
    refId: id,
    ts: '2026-09-01T00:00:00.000Z',
    payload: { walletLabel: label, mint: 'So11111111111111111111111111111111111111112', solAmount: 1 },
  };
}

function Probe({ engine, apiKey = 'k' }: { engine: EngineClient; apiKey?: string }) {
  const { items, state } = useAlertStream(engine, 'ws://engine/ws', apiKey);
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="ids">{items.map((i) => i.id).join(',')}</span>
    </div>
  );
}

const ids = () => screen.getByTestId('ids').textContent;
const state = () => screen.getByTestId('state').textContent;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAlertStream', () => {
  it('fills the rail from history before the socket is even open', async () => {
    const { engine } = engineWith([alert(1), alert(2)]);
    render(<Probe engine={engine} />);
    await waitFor(() => expect(ids()).toBe('2,1'));
  });

  it('sends the api key as a query parameter, since a browser socket cannot set headers', () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} apiKey="a b&c" />);
    expect(FakeSocket.instances[0].url).toBe('ws://engine/ws?apiKey=a%20b%26c');
  });

  it('reports live once the socket opens', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);
    FakeSocket.instances[0].open();
    await waitFor(() => expect(state()).toBe('live'));
  });

  it('appends alerts pushed over the socket', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].deliver(alert(5));
    await waitFor(() => expect(ids()).toBe('5'));
  });

  it('survives a malformed frame without losing the feed', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.deliver('{not json');
    socket.deliver(alert(6));
    await waitFor(() => expect(ids()).toBe('6'));
  });

  it('drops an alert type this build cannot render', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.deliver({ id: 9, type: 'tweet', payload: { text: 'hi' } });
    await waitFor(() => expect(state()).toBe('live'));
    expect(ids()).toBe('');
  });

  it('shows the connection as down when the socket closes', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].drop();
    await waitFor(() => expect(state()).toBe('down'));
  });

  it('reconnects after a backoff and catches up from the highest id seen', async () => {
    const { engine, calls } = engineWith([alert(1)]);
    render(<Probe engine={engine} />);
    await waitFor(() => expect(ids()).toBe('1'));

    const first = FakeSocket.instances[0];
    first.open();
    first.deliver(alert(4));
    await waitFor(() => expect(ids()).toBe('4,1'));

    first.drop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].open();
    // The catch-up asks only for what came after the newest row it holds, so a
    // trade landing mid-reconnect is not lost and nothing is re-fetched twice.
    await waitFor(() => expect(calls.at(-1)).toBe(4));
  });

  it('seeds from the newest alerts, not from an ascending page starting at zero', async () => {
    // Regression: `/alerts?since=0` is a capped ASCENDING page, so seeding
    // with it opened the rail on the oldest alerts in the entire history.
    const { engine, calls, recentCalls } = engineWith([], [alert(90), alert(91)]);
    render(<Probe engine={engine} />);
    await waitFor(() => expect(ids()).toBe('91,90'));
    expect(recentCalls).toEqual([200]);
    expect(calls).toEqual([]);
  });

  it('pages a long backlog instead of stopping after the first page', async () => {
    // A full page means there may be more; stopping there left the rail on a
    // stale window until the next reconnect.
    let nextId = 100;
    const page = async () => Array.from({ length: 50 }, () => alert(nextId++));
    const { engine, calls } = engineWith(page, [alert(99)]);

    render(<Probe engine={engine} />);
    await waitFor(() => expect(ids()).toBe('99'));

    const socket = FakeSocket.instances[0];
    socket.open();

    // Four pages of fifty is the rail's whole capacity; it stops there.
    await waitFor(() => expect(calls).toHaveLength(4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(calls).toHaveLength(4);
  });

  it('stops paging as soon as a short page arrives', async () => {
    const { engine, calls } = engineWith([alert(200)], [alert(199)]);
    render(<Probe engine={engine} />);
    await waitFor(() => expect(ids()).toBe('199'));

    FakeSocket.instances[0].open();
    await waitFor(() => expect(calls).toEqual([199]));
  });

  it('backs off further on each failed attempt rather than hammering the engine', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);

    FakeSocket.instances[0].drop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].drop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    // Still one second short of the doubled delay.
    expect(FakeSocket.instances).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('resets the backoff after a successful connection', async () => {
    const { engine } = engineWith([]);
    render(<Probe engine={engine} />);

    FakeSocket.instances[0].drop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    FakeSocket.instances[1].open();
    FakeSocket.instances[1].drop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('keeps rendering when catch-up fails', async () => {
    const { engine } = engineWith(async () => {
      throw new Error('engine down');
    });
    render(<Probe engine={engine} />);
    FakeSocket.instances[0].open();
    await waitFor(() => expect(state()).toBe('live'));
    expect(ids()).toBe('');
  });

  it('stops reconnecting once unmounted', async () => {
    const { engine } = engineWith([]);
    const { unmount } = render(<Probe engine={engine} />);
    const socket = FakeSocket.instances[0];
    unmount();
    expect(socket.closedByClient).toBe(true);

    // A close event arriving after teardown must not schedule another attempt.
    socket.onclose?.();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
