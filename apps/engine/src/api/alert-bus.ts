import { EventEmitter } from 'node:events';

export interface AlertEvent {
  /**
   * The alerts-table row id. Monotonic, so a reconnecting client can ask
   * GET /alerts?since=<highest id it saw> and catch up on anything published
   * while it was disconnected. Without it a client has no way to know where
   * it left off — refId is a trade id and says nothing about alert ordering.
   */
  id: number;
  type: string;
  refId: number;
  payload: unknown;
}

export class AlertBus extends EventEmitter {
  publish(alert: AlertEvent) {
    this.emit('alert', alert);
  }
}
