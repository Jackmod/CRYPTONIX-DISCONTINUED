import WebSocket from 'ws';

/** Exactly what apps/engine/src/api/alert-bus.ts publishes over /ws. */
export interface AlertEvent {
  /** alerts-table row id; monotonic, and how catch-up knows where to resume. */
  id: number;
  type: string;
  refId: number;
  payload: unknown;
}

/** The slice of a WebSocket this class uses, so tests can supply a fake. */
export interface AlertSocket {
  on(event: string, handler: (...args: any[]) => void): void;
  close(): void;
  /** Optional so a fake socket need not implement the heartbeat. */
  ping?(): void;
  terminate?(): void;
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
  /**
   * How often to ping the engine, and how long to wait for a pong.
   *
   * A TCP connection can go half-open — a NAT reaping an idle mapping, or the
   * engine host dying without sending a FIN. The socket then never emits
   * 'close', so reconnect logic driven only off that event waits forever while
   * alerts silently stop. Set to 0 to disable.
   */
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
}

function isAlertEvent(value: unknown): value is AlertEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AlertEvent).id === 'number' &&
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
  private openHandlers: (() => void)[] = [];
  private socket: AlertSocket | null = null;
  private delayMs: number;
  private stopped = false;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Incremented by stop(), so a reconnect scheduled before it cannot fire.
   *
   * A pending backoff timer survived stop(), and start() cleared `stopped` --
   * so a stop/start cycle left the old timer free to open a second socket
   * that nothing referenced or closed.
   */
  private generation = 0;

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
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
    this.delayMs = this.initialDelayMs;
  }

  onAlert(handler: (alert: AlertEvent) => void) {
    this.handlers.push(handler);
  }

  /**
   * Called on every successful connection, including reconnects.
   *
   * This is where a consumer catches up on what was published while it was
   * away: the socket itself only ever delivers what happens while it is open.
   */
  onOpen(handler: () => void) {
    this.openHandlers.push(handler);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  /**
   * Pings the engine periodically and tears the socket down if no pong comes
   * back.
   *
   * A TCP connection can go half-open — a NAT reaping an idle mapping, or the
   * engine host dying without a FIN. The socket emits no 'close' in that case,
   * so reconnect logic driven only off 'close' waits forever while alerts stop
   * arriving, with nothing in the logs. Terminating on a missed pong turns
   * that silence into a 'close', which the existing backoff already handles.
   */
  private startHeartbeat(socket: AlertSocket) {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0 || typeof socket.ping !== 'function') return;

    this.heartbeatTimer = setInterval(() => {
      if (this.pongTimer) return; // a check is already outstanding
      try {
        socket.ping?.();
      } catch {
        // socket already dead; the close handler will deal with it
        return;
      }
      this.pongTimer = setTimeout(() => {
        console.error('alert stream: no pong from the engine; reconnecting');
        this.pongTimer = null;
        // terminate() forces a 'close', which drives the normal backoff path.
        // Not `terminate?.() ?? close()`: terminate() returns undefined, so
        // that form called close() every time as well.
        try {
          if (typeof socket.terminate === 'function') socket.terminate();
          else socket.close();
        } catch {
          // already gone
        }
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
  }

  private connect() {
    const socket = this.createSocket(this.options.url);
    this.socket = socket;

    /**
     * True only while `socket` is the connection we are actually using.
     *
     * A stop()/start() cycle, or a reconnect, leaves the old socket's handlers
     * registered. Without this guard a stale 'close' would stop the NEW
     * socket's heartbeat and schedule a second connection, after which every
     * alert arrived twice and was posted twice.
     */
    const isCurrent = () => this.socket === socket;

    // A successful connection resets the backoff. Without this, a long-lived
    // bot that blips once would then wait the full capped delay to come back.
    socket.on('open', () => {
      if (!isCurrent()) return;
      this.delayMs = this.initialDelayMs;
      this.startHeartbeat(socket);
      for (const handler of this.openHandlers) handler();
    });

    socket.on('pong', () => {
      // Same currency guard as every other handler: a stale socket's pong must
      // not clear the CURRENT socket's timeout and suppress half-open detection.
      if (!isCurrent()) return;
      // Still alive; cancel the pending "no answer" timeout.
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });

    socket.on('message', (data: unknown) => {
      if (!isCurrent()) return;
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
      // A close from a socket we have already replaced must not touch the
      // current connection's heartbeat or schedule another reconnect.
      if (!isCurrent()) return;
      this.stopHeartbeat();
      if (this.stopped) return;
      const delay = this.delayMs;
      this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
      // Captured now: a stop() between scheduling and firing bumps the
      // generation, and this reconnect must then not happen even if start()
      // has since cleared `stopped`.
      const scheduledIn = this.generation;
      this.schedule(() => {
        if (!this.stopped && this.generation === scheduledIn) this.connect();
      }, delay);
    });
  }
}
