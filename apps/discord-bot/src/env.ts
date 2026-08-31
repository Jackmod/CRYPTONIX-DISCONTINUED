import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Twin of apps/engine/src/env.ts — keep both in step. `pnpm --filter
// @cryptonix/discord-bot dev` runs with cwd set to apps/discord-bot, but .env
// lives at the repo root, and a bare `dotenv/config` only looks in cwd. Walk
// up to the nearest .env instead.
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
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  discordGuildId: required('DISCORD_GUILD_ID'),
  alertChannelId: required('DISCORD_ALERT_CHANNEL_ID'),
  engineHttpUrl: required('ENGINE_HTTP_URL'),
  engineWsUrl: required('ENGINE_WS_URL'),
};
