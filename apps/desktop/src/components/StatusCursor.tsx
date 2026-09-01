import type { ConnectionState } from '../api/feed';

const LABEL: Record<ConnectionState, string> = {
  live: 'live',
  connecting: 'connecting',
  down: 'reconnecting',
};

/**
 * Connection state as a block cursor.
 *
 * It blinks only while genuinely connected, so the blink itself carries the
 * information rather than decorating — a still cursor means the feed is not
 * moving, which is exactly what the user needs to know before trusting an
 * empty rail.
 */
export function StatusCursor({ state }: { state: ConnectionState }) {
  return (
    <div className="status">
      <span className="cursor" data-state={state} aria-hidden="true">
        █
      </span>
      <span role="status">{LABEL[state]}</span>
    </div>
  );
}
