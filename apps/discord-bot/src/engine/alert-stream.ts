import WebSocket from 'ws';

/** Exactly what apps/engine/src/api/alert-bus.ts publishes over /ws. */
export interface AlertEvent {
  type: string;
  refId: number;
  payload: unknown;
}

/** The slice of a WebSocket this class uses, so tests can supply a fake. */
export interface AlertSocket {
  on(event: string, handler: (...args: any[]) => void): void;
  close(): void;
}

export interface AlertStreamOptions {
  url: string;
  /**
   * Sent as `Authorization: Bearer <key>` on the upgrade request. The engine
   * rejects the handshake without it: the socket carries the live trade feed
   * of every tracked wallet, and the engine is publicly reachable.
   */
  apiKey?: string;
  createSocket?: (url: string) => AlertSocket;
  schedule?: (fn: () => void, ms: number) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

function isAlertEvent(value: unknown): value is AlertEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AlertEvent).type === 'string' &&
    typeof (value as AlertEvent).refId === 'number'
  );
}

export class AlertStream {
  private readonly createSocket: (url: string) => AlertSocket;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  private handlers: ((alert: AlertEvent) => void)[] = [];
  private socket: AlertSocket | null = null;
  private delayMs: number;
  private stopped = false;

  constructor(private options: AlertStreamOptions) {
    this.createSocket =
      options.createSocket ??
      ((url) =>
        new WebSocket(url, {
          headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
        }) as unknown as AlertSocket);
    this.schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.initialDelayMs = options.initialDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.delayMs = this.initialDelayMs;
  }

  onAlert(handler: (alert: AlertEvent) => void) {
    this.handlers.push(handler);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private connect() {
    const socket = this.createSocket(this.options.url);
    this.socket = socket;

    // A successful connection resets the backoff. Without this, a long-lived
    // bot that blips once would then wait the full capped delay to come back.
    socket.on('open', () => {
      this.delayMs = this.initialDelayMs;
    });

    socket.on('message', (data: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        console.error('alert stream: ignoring unparseable message');
        return;
      }
      if (!isAlertEvent(parsed)) return;
      for (const handler of this.handlers) handler(parsed);
    });

    // 'error' fires alongside 'close' on a failed connection; reconnecting is
    // driven off 'close' alone so one failure does not schedule two attempts.
    socket.on('error', (err: Error) => {
      console.error('alert stream: socket error', err.message);
    });

    socket.on('close', () => {
      if (this.stopped) return;
      const delay = this.delayMs;
      this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
      this.schedule(() => {
        if (!this.stopped) this.connect();
      }, delay);
    });
  }
}
