import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time `Authorization: Bearer <key>` check, shared by the REST
 * middleware and the WebSocket upgrade handler so the two cannot drift apart.
 *
 * A plain `===` short-circuits on the first differing byte, leaking timing
 * information an attacker can use to recover the key one character at a time.
 * timingSafeEqual throws on differing lengths rather than returning false, so
 * the length check has to come first.
 */
export function isValidBearer(header: string | undefined, apiKey: string): boolean {
  // An empty key would be catastrophic rather than merely permissive: two
  // zero-length buffers compare equal, so `Bearer ` would authenticate anyone.
  if (!apiKey) return false;
  if (!header) return false;

  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;

  const received = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(apiKey);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
