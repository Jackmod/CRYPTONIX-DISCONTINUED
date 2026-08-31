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
  port: Number(process.env.PORT ?? 8787),
};
