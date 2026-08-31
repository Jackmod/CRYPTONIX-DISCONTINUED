import { describe, it, expect } from 'vitest';
import { AlertStream, type AlertSocket } from './alert-stream';

class FakeSocket implements AlertSocket {
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  closed = false;

  on(event: string, handler: (...args: any[]) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
  close() {
    this.closed = true;
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
  });
  return { stream, sockets, delays, runPending: () => pending.shift()?.() };
}

describe('AlertStream', () => {
  it('forwards a parsed alert to the handler', () => {
    const { stream, sockets } = build();
    const received: any[] = [];
    stream.onAlert((alert) => received.push(alert));
    stream.start();

    sockets[0].emit('message', JSON.stringify({ type: 'wallet_buy', refId: 3, payload: { mint: 'Mint1' } }));

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
