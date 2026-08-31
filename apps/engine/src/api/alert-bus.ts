import { EventEmitter } from 'node:events';

export interface AlertEvent {
  type: string;
  refId: number;
  payload: unknown;
}

export class AlertBus extends EventEmitter {
  publish(alert: AlertEvent) {
    this.emit('alert', alert);
  }
}
