import { describe, it, expect, vi } from 'vitest';
import { AlertStream, type AlertSocket } from './alert-stream';

class FakeSocket implements AlertSocket {
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  closed = false;
  terminated = false;
  pings = 0;

  on(event: string, handler: (...args: any[]) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
  close() {
    this.closed = true;
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
  }
  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
}

function build() {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const pending: (() => void)[] = [];
  const stream = new AlertStream({
    url: 'ws://engine/ws',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (fn, ms) => {
      delays.push(ms);
      pending.push(fn);
    },
    initialDelayMs: 100,
    maxDelayMs: 800,
    heartbeatMs: 0, // off by default; the heartbeat tests opt in
  });
  return { stream, sockets, delays, runPending: () => pending.shift()?.() };
}

describe('AlertStream', () => {
  it('forwards a parsed alert to the handler', () => {
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    sockets[0].emit('message', JSON.stringify({ id: 7, type: 'wallet_buy', refId: 3, payload: { mint: 'Mint1' } }));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('wallet_buy');
    expect(received[0].refId).toBe(3);
  });

  it('ignores a malformed message instead of throwing', () => {
    // One bad frame must not take down the alert pipeline. The engine's own
    // ws.ts makes the same guarantee on its side.
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    expect(() => sockets[0].emit('message', 'not json at all')).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('ignores a JSON message that is not an alert', () => {
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    sockets[0].emit('message', JSON.stringify({ hello: 'world' }));

    expect(received).toHaveLength(0);
  });

  it('reconnects after a close, backing off each time', () => {
    const { stream, sockets, delays, runPending } = build();
    stream.start();

    sockets[0].emit('close');
    runPending();
    expect(sockets).toHaveLength(2);

    sockets[1].emit('close');
    runPending();
    expect(sockets).toHaveLength(3);

    expect(delays).toEqual([100, 200]);
  });

  it('caps the backoff delay', () => {
    const { stream, sockets, delays, runPending } = build();
    stream.start();

    for (let i = 0; i < 6; i++) {
      sockets[sockets.length - 1].emit('close');
      runPending();
    }

    expect(Math.max(...delays)).toBe(800);
  });

  it('resets the backoff once a connection succeeds', () => {
    // Without this, a bot that has been up for days and briefly blips would
    // wait the full capped delay before reconnecting.
    const { stream, sockets, delays, runPending } = build();
    stream.start();

    sockets[0].emit('close');
    runPending();
    sockets[1].emit('open');
    sockets[1].emit('close');
    runPending();

    expect(delays).toEqual([100, 100]);
  });

  it('stops reconnecting after stop()', () => {
    const { stream, sockets, runPending } = build();
    stream.start();
    stream.stop();

    sockets[0].emit('close');
    runPending();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });
});

describe('AlertStream heartbeat', () => {
  it('terminates a socket that stops answering pings', async () => {
    // A half-open connection (NAT reap, host death without a FIN) emits no
    // 'close', so backoff driven only off that event waits forever while
    // alerts silently stop. The heartbeat turns that silence into a close.
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new AlertStream({
      url: 'ws://engine/ws',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: () => {},
      heartbeatMs: 1_000,
      heartbeatTimeoutMs: 500,
    });
    stream.start();
    sockets[0].emit('open');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0].pings).toBe(1);
    expect(sockets[0].terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(500); // pong never arrives
    expect(sockets[0].terminated).toBe(true);

    stream.stop();
    vi.useRealTimers();
  });

  it('keeps a socket that answers its pings', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new AlertStream({
      url: 'ws://engine/ws',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: () => {},
      heartbeatMs: 1_000,
      heartbeatTimeoutMs: 500,
    });
    stream.start();
    sockets[0].emit('open');

    // Answer the ping, then run past the timeout window it opened. Advancing
    // far enough to trigger a SECOND unanswered ping would correctly terminate
    // — that is the previous test — so stay inside this cycle.
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[0].emit('pong');
    await vi.advanceTimersByTimeAsync(900);

    expect(sockets[0].terminated).toBe(false);

    stream.stop();
    vi.useRealTimers();
  });

  it('survives many cycles while the engine keeps answering', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new AlertStream({
      url: 'ws://engine/ws',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: () => {},
      heartbeatMs: 1_000,
      heartbeatTimeoutMs: 500,
    });
    stream.start();
    sockets[0].emit('open');

    for (let cycle = 0; cycle < 10; cycle++) {
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[0].emit('pong');
    }

    expect(sockets[0].pings).toBe(10);
    expect(sockets[0].terminated).toBe(false);

    stream.stop();
    vi.useRealTimers();
  });

  it('stops pinging once the stream is stopped', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new AlertStream({
      url: 'ws://engine/ws',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: () => {},
      heartbeatMs: 1_000,
      heartbeatTimeoutMs: 500,
    });
    stream.start();
    sockets[0].emit('open');
    await vi.advanceTimersByTimeAsync(1_000);
    const pingsBeforeStop = sockets[0].pings;

    stream.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sockets[0].pings).toBe(pingsBeforeStop);
    vi.useRealTimers();
  });
});

describe('AlertStream: stale sockets', () => {
  it('ignores a close from a socket it has already replaced', () => {
    // A stop()/start() cycle leaves the old socket's handlers registered.
    // Without a currency check its stale 'close' scheduled a second
    // connection, after which every alert arrived - and was posted - twice.
    const { stream, sockets, delays, runPending } = build();
    stream.start();
    const first = sockets[0];

    stream.stop();
    stream.start(); // a fresh socket is now current
    expect(sockets).toHaveLength(2);

    first.emit('close'); // the old one finally reports closing
    runPending();

    expect(sockets).toHaveLength(2); // no extra connection was scheduled
    expect(delays).toEqual([]);
  });

  it('ignores messages from a socket it has already replaced', () => {
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();
    const first = sockets[0];

    stream.stop();
    stream.start();

    first.emit('message', JSON.stringify({ id: 1, type: 'wallet_buy', refId: 1, payload: {} }));

    expect(received).toHaveLength(0);
  });
});

describe('AlertStream: stop cancels pending work', () => {
  it('does not open a socket from a reconnect scheduled before stop()', async () => {
    // The backoff timer survived stop(), and start() cleared `stopped` -- so a
    // stop/start cycle let the stale timer open a second socket that nothing
    // referenced or closed.
    const { stream, sockets, runPending } = build();
    stream.start();

    sockets[0].emit('close'); // a reconnect is now scheduled
    stream.stop();
    stream.start(); // fresh socket; the stale timer must not add another

    const socketsAfterRestart = sockets.length;
    runPending(); // the pre-stop timer fires

    expect(sockets).toHaveLength(socketsAfterRestart);
  });
});
