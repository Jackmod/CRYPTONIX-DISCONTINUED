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

/**
 * A numeric override, or undefined when unset or unparseable.
 *
 * Undefined means "use the documented default" rather than 0 -- a typo in a
 * threshold silently becoming 0 would turn every gate off and flood the
 * channel, which is exactly the failure worth avoiding here.
 */
function numberOr(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`${name}='${raw}' is not a number; using the default instead`);
    return undefined;
  }
  return value;
}

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

  /**
   * New-coin scanner. Off unless COIN_SCANNER_ENABLED is 'true', so an
   * existing deployment gains nothing it did not ask for.
   *
   * Every threshold is overridable because spec §12 expects them tuned against
   * real traffic after launch -- tuning must not need a code change. The
   * defaults live in @cryptonix/core's DEFAULT_MOMENTUM_THRESHOLDS.
   */
  coinScannerEnabled: process.env.COIN_SCANNER_ENABLED === 'true',
  // numberOr, not a raw Number(): an empty value gave 0 and '60s' gave NaN,
  // and setInterval clamps both to 1ms -- which would hammer DexScreener at
  // roughly a thousand requests a second. Floored for the same reason.
  coinScannerIntervalMs: Math.max(10_000, numberOr('COIN_SCANNER_INTERVAL_MS') ?? 60_000),
  coinThresholds: {
    maxAgeMinutes: numberOr('COIN_MAX_AGE_MINUTES'),
    minVolume5m: numberOr('COIN_MIN_VOLUME_5M'),
    minBuyRatio: numberOr('COIN_MIN_BUY_RATIO'),
    minPriceChange5m: numberOr('COIN_MIN_PRICE_CHANGE_5M'),
    minTrades5m: numberOr('COIN_MIN_TRADES_5M'),
    minLiquidityUsd: numberOr('COIN_MIN_LIQUIDITY_USD'),
  },

  /**
   * Twitter monitoring. Off unless a key is present.
   *
   * Discovery is the one part of this project that cannot be done for free:
   * X's free API tier is write-only, and Nitter was served cease-and-desist
   * letters on 2026-08-24 and archived. Rendering a tweet stays free either
   * way (see src/twitter/syndication.ts), so the Calls tab and the embeds work
   * without this — they just have nothing new to show.
   */
  twitterApiKey: process.env.TWITTER_API_KEY ?? '',
  // Floored like the coin scanner, and for a sharper reason: this provider
  // charges a floor fee PER CALL whether or not a tweet comes back, so a
  // mistyped interval is billable. One minute across all handles is cheap;
  // one second is not.
  tweetPollIntervalMs: Math.max(30_000, numberOr('TWEET_POLL_INTERVAL_MS') ?? 120_000),
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
