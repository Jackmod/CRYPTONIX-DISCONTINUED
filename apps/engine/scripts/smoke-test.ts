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
import { createDb, wallets } from '@cryptonix/db';

const PORT = process.env.PORT ?? 8787;
const BASE = `http://localhost:${PORT}`;
const SKIP_HELIUS = process.argv.includes('--skip-helius');
const ALERT_TIMEOUT_MS = 15_000;

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
    headers: { 'Content-Type': 'application/json' },
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
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const alertReceived = new Promise<any>((resolve) => {
    ws.on('message', (data) => resolve(JSON.parse(data.toString())));
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('1. Creating a wallet...' + (SKIP_HELIUS ? ' (--skip-helius: inserting directly, no Helius call)' : ''));
  let wallet: { id: number; address: string };

  if (SKIP_HELIUS) {
    const address = `SmokeTestWallet-${Date.now()}`;
    wallet = await createWalletDirectly(address, 'Smoke Test Wallet (--skip-helius)');
    console.log('   Inserted directly via drizzle:', wallet);
  } else {
    const { status, body } = await createWalletViaApi('SmokeTestWallet111', 'Smoke Test Wallet');
    if (status !== 201) {
      console.log(`   POST /wallets returned ${status}:`, body);
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
    headers: { 'Content-Type': 'application/json' },
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
  const tradesRes = await fetch(`${BASE}/wallets/${wallet.id}/trades`);
  const trades = await tradesRes.json();
  console.log('   Trades:', trades);
  if (trades.length !== 1) throw new Error('Expected exactly 1 trade');

  console.log('\nSmoke test passed.' + (SKIP_HELIUS ? ' (--skip-helius: wallet registration itself was NOT exercised)' : ''));
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
