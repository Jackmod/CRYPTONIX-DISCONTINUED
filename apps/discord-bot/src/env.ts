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
  // Optional. Commands register globally so the bot works in any server;
  // when this is set they ALSO register to that one guild, which Discord
  // makes available instantly rather than after global propagation.
  devGuildId: process.env.DISCORD_GUILD_ID || undefined,
  // DISCORD_ALERT_CHANNEL_ID is deliberately absent: alert routing is
  // per-server, stored in discord_guilds and set with /setup.
  engineHttpUrl: required('ENGINE_HTTP_URL'),
  // Must match the engine's ENGINE_API_KEY; every engine route except the
  // Helius webhook rejects requests without it.
  engineApiKey: required('ENGINE_API_KEY'),
  engineWsUrl: required('ENGINE_WS_URL'),
};
