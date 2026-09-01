import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

// `pnpm --filter @cryptonix/engine dev` runs with cwd set to apps/engine, but
// .env lives at the repo root. A bare `dotenv/config` only looks in cwd, so
// the documented run command would die on "Missing required env var".
// Walk up from cwd to the nearest .env instead.
function loadEnvFile() {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config(); // nothing found; fall back to dotenv's default behavior
}

loadEnvFile();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  heliusApiKey: required('HELIUS_API_KEY'),
  webhookBaseUrl: required('WEBHOOK_BASE_URL'),
  // WEBHOOK_BASE_URL is by design a public URL, so /webhooks/helius must be
  // authenticated: Helius echoes this secret back as the Authorization header
  // on every delivery (see helius/client.ts's authHeader), and the route
  // checks it before writing anything (see api/server.ts).
  webhookSecret: required('WEBHOOK_SECRET'),
  // Guards every route except /webhooks/helius. WEBHOOK_BASE_URL must be
  // publicly reachable for Helius to deliver, which exposes this whole API;
  // without a key anyone who finds the host owns the wallet list.
  apiKey: required('ENGINE_API_KEY'),
  port: Number(process.env.PORT ?? 8787),
};

// Helius must be able to POST to WEBHOOK_BASE_URL from the public internet.
// A localhost or private address is accepted by our config but rejected by
// Helius on every wallet registration ("Invalid webhook URL format"), which
// otherwise only shows up as a failed /track much later. Say so at startup.
const webhookHost = (() => {
  try {
    // URL.hostname keeps the brackets on an IPv6 literal ('[::1]'), so strip
    // them before matching or the loopback case never fires.
    return new URL(env.webhookBaseUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
})();

/** RFC1918 and friends: addresses Helius cannot route to from the internet. */
function isUnreachableFromInternet(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true; // link-local
  // 172.16.0.0/12 is 172.16 through 172.31, not all of 172.
  const match = /^172\.(\d{1,3})\./.exec(host);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return false;
}

if (isUnreachableFromInternet(webhookHost)) {
  console.warn(
    `WEBHOOK_BASE_URL points at ${webhookHost}, which Helius cannot reach. ` +
      'Wallet registration will fail until it is a public URL (e.g. run `ngrok http 8787` and use that https URL).'
  );
}
