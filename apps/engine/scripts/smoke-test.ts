/**
 * End-to-end smoke test for the cryptonix engine.
 *
 * Drives the running engine over HTTP and WebSocket exactly like a real
 * client would: register a wallet, simulate an incoming Helius webhook,
 * confirm the resulting alert arrives over the WebSocket with the correct
 * Axiom link, then read the recorded trade back over REST.
 *
 * Usage (run against `pnpm --filter @cryptonix/engine dev` in another terminal):
 *   pnpm --filter @cryptonix/engine exec tsx scripts/smoke-test.ts
 *   pnpm --filter @cryptonix/engine exec tsx scripts/smoke-test.ts --skip-helius
 *
 * Default mode registers the wallet through POST /wallets, which calls the
 * real HeliusClient.createWalletWebhook. That needs a real HELIUS_API_KEY in
 * .env. Against a placeholder key, Helius rejects the request, the route
 * returns 500, and this script reports that plainly (SKIPPED, exit 1)
 * instead of hanging forever waiting for an alert that will never come, or
 * claiming success it didn't earn.
 *
 * --skip-helius bypasses wallet registration entirely: the wallet row is
 * inserted directly with drizzle (the same shape trackWallet() would insert
 * after a successful Helius call), with no Helius call anywhere in the run.
 * Everything downstream -- webhook -> parse -> alert -> WebSocket ->
 * REST-readback -- is exercised exactly as in the default path. This is how
 * to confirm the alert pipeline itself works even when no real Helius key
 * is configured yet.
 */
import WebSocket from 'ws';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createDb, wallets } from '@cryptonix/db';

// This script runs standalone via tsx (not through index.ts), so it needs
// its own .env loading. Mirrors env.ts's walk-up: cwd can be apps/engine
// (`pnpm --filter @cryptonix/engine exec tsx ...`) or the repo root, but
// .env always lives at the repo root.
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

const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const SKIP_HELIUS = process.argv.includes('--skip-helius');
const ALERT_TIMEOUT_MS = 15_000;

// /webhooks/helius now requires this header (see FIX 5: the endpoint is
// public by design via WEBHOOK_BASE_URL, so it must be authenticated). The
// running engine reads the same value from .env via env.ts -- read it the
// same way here so the two never drift apart.
//
// This is a function (rather than an inline `if (!x) exit` at module scope)
// so TypeScript's control-flow narrowing to `string` actually holds where
// WEBHOOK_SECRET is used below -- narrowing from an early-exit check does
// not carry across into a later function's closure, only within the same
// function body.
function requireWebhookSecret(): string {
  const value = process.env.WEBHOOK_SECRET;
  if (!value) {
    console.error('Missing WEBHOOK_SECRET in the environment -- the running engine needs it too (see .env).');
    process.exit(1);
  }
  return value;
}
const WEBHOOK_SECRET = requireWebhookSecret();

// Every engine route except /webhooks/helius, and the alert socket itself,
// now require the engine API key. Without it this script gets 401s that look
// like the engine is broken when it is simply protected.
const API_KEY = (() => {
  const key = process.env.ENGINE_API_KEY;
  if (!key) {
    console.error('ENGINE_API_KEY is not set. Add it to .env (it must match the value the engine runs with).');
    process.exit(1);
  }
  return key;
})();
const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** The normal path: register through the API, which calls the real Helius webhook API. */
async function createWalletViaApi(address: string, label: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/wallets`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ address, label, isMine: true }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** --skip-helius path: insert the wallet row directly, bypassing Helius entirely. */
async function createWalletDirectly(address: string, label: string) {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix';
  const db = createDb(databaseUrl);
  const [wallet] = await db.insert(wallets).values({ address, label, isMine: true }).returning();
  return wallet;
}

async function main() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const alertReceived = new Promise<any>((resolve) => {
    ws.on('message', (data) => resolve(JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err: Error) => {
      // The alert socket authenticates with the same ENGINE_API_KEY as the
      // REST calls and is opened first, so a key mismatch surfaces here as a
      // raw "Unexpected server response: 401" long before the REST branch
      // that explains it. Name the cause at the point it actually fails.
      if (err.message.includes('401')) {
        console.error('\nFAILED: the engine rejected our credentials on the alert socket.');
        console.error('   ENGINE_API_KEY in .env must match the value the running engine started with.');
        process.exit(1);
      }
      reject(err);
    });
  });

  console.log('1. Creating a wallet...' + (SKIP_HELIUS ? ' (--skip-helius: inserting directly, no Helius call)' : ''));
  let wallet: { id: number; address: string };

  if (SKIP_HELIUS) {
    const address = `SmokeTestWallet-${Date.now()}`;
    wallet = await createWalletDirectly(address, 'Smoke Test Wallet (--skip-helius)');
    console.log('   Inserted directly via drizzle:', wallet);
  } else {
    // Must be a real base58 pubkey: POST /wallets validates the address before
    // registering a webhook, so a placeholder like 'SmokeTestWallet111' (the
    // 'l' is not in the base58 alphabet) is rejected with 400 every time.
    //
    // Deliberately NOT a well-known address. This registers a live Helius
    // `enhanced`/SWAP webhook, so pointing it at something busy (wrapped SOL,
    // say) would have Helius flood /webhooks/helius indefinitely and make
    // every run backfill 20 pages of that account's history. This is
    // PublicKey(Buffer.alloc(32, 7)) — structurally valid, and an account
    // nobody holds the key to, so it never trades.
    const SMOKE_ADDRESS = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx';

    let { status, body } = await createWalletViaApi(SMOKE_ADDRESS, 'Smoke Test Wallet');

    if (status === 409) {
      // Left over from a previous run. Untrack and retry so the script is
      // repeatable rather than passing only against a clean database.
      console.log('   Already tracked from an earlier run; untracking and retrying...');
      const cleanup = await fetch(`${BASE}/wallets/${body.wallet.id}`, { method: 'DELETE', headers: authed });
      if (!cleanup.ok) {
        // Silently ignoring this would land us back in the generic branch
        // below, reporting a cleanup failure as a missing HELIUS_API_KEY.
        console.log(`\nFAILED: could not remove the leftover wallet (DELETE returned ${cleanup.status}).`);
        console.log('   Remove it by hand, or re-run with --skip-helius.');
        ws.close();
        process.exit(1);
      }
      ({ status, body } = await createWalletViaApi(SMOKE_ADDRESS, 'Smoke Test Wallet'));
    }

    if (status !== 201) {
      console.log(`   POST /wallets returned ${status}:`, body);
      // Distinguish the failure modes. Reporting an auth or validation problem
      // as "needs a real HELIUS_API_KEY" sends you chasing the wrong thing.
      if (status === 401) {
        console.log('\nFAILED: the engine rejected our credentials.');
        console.log('   ENGINE_API_KEY in .env must match the value the running engine started with.');
        ws.close();
        process.exit(1);
      }
      if (status === 400) {
        console.log('\nFAILED: the engine rejected the request as invalid - see the error above.');
        ws.close();
        process.exit(1);
      }
      if (status === 502) {
        // Helius refused and the engine passed its reason through. By far the
        // most common cause is a WEBHOOK_BASE_URL Helius cannot reach.
        console.log('\nSKIPPED: Helius refused to register the webhook.');
        console.log('   WEBHOOK_BASE_URL must be a public https URL that Helius can POST to.');
        console.log('   Run `ngrok http 8787`, put that https URL in .env, restart the engine, and retry.');
        console.log('   Or re-run with --skip-helius to exercise webhook -> alert -> WebSocket -> REST without Helius.');
        ws.close();
        process.exit(1);
      }
      console.log(
        '\nSKIPPED: wallet registration needs a real HELIUS_API_KEY in .env — the rest of the flow was not exercised'
      );
      console.log(
        '   (POST /wallets calls the real Helius webhook-create API; against the placeholder key in .env, Helius rejects it and the route 500s.)'
      );
      console.log('   Re-run with --skip-helius to verify webhook -> alert -> WebSocket -> REST readback without Helius.');
      ws.close();
      process.exit(1);
    }
    wallet = body;
    console.log('   Created:', wallet);
  }

  console.log('2. Simulating an incoming Helius webhook (a buy)...');
  await fetch(`${BASE}/webhooks/helius`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: WEBHOOK_SECRET },
    body: JSON.stringify([
      {
        signature: 'smoke-sig-1',
        timestamp: Math.floor(Date.now() / 1000),
        type: 'SWAP',
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: wallet.address, mint: 'SmokeMint1', tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: wallet.address, toUserAccount: 'Pool', amount: 2_000_000_000 }],
      },
    ]),
  });

  console.log('3. Waiting for the WebSocket alert...');
  const alert = await withTimeout(alertReceived, ALERT_TIMEOUT_MS, 'WebSocket alert for the simulated buy');
  console.log('   Received alert:', alert);
  if (alert.payload.axiomLink !== 'https://axiom.trade/t/SmokeMint1') {
    throw new Error('Axiom link mismatch!');
  }

  console.log('4. Checking trade history via REST...');
  const tradesRes = await fetch(`${BASE}/wallets/${wallet.id}/trades`, { headers: authed });
  const trades = await tradesRes.json();
  console.log('   Trades:', trades);
  if (trades.length !== 1) throw new Error('Expected exactly 1 trade');

  // Clean up after ourselves. On the non-skip path this wallet holds a live
  // Helius webhook against the free tier's address cap; leaving it behind
  // means every run permanently consumes another slot.
  console.log('5. Untracking the smoke-test wallet...');
  const cleanup = await fetch(`${BASE}/wallets/${wallet.id}`, { method: 'DELETE', headers: authed });
  if (cleanup.ok) {
    console.log('   Removed, and its Helius webhook released.');
  } else {
    console.log(`   WARNING: cleanup returned ${cleanup.status}. Wallet ${wallet.id} is still tracked.`);
    if (!SKIP_HELIUS) console.log('   It still holds a Helius webhook address slot - remove it by hand.');
  }

  console.log('\nSmoke test passed.' + (SKIP_HELIUS ? ' (--skip-helius: wallet registration itself was NOT exercised)' : ''));
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
