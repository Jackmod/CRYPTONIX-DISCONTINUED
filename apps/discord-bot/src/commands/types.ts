import type { ChatInputCommandInteraction } from 'discord.js';
import type { EngineClient } from '../engine/client.js';
import type { GuildConfigCache } from '../guilds/config-cache.js';

export interface CommandDeps {
  engine: EngineClient;
  guildConfigs: GuildConfigCache;
}

export interface BotCommand {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
}

/** Every command reports failure the same way: ephemeral, and never silent. */
export function describeError(err: unknown): string {
  // This runs inside the catch that exists to stop a throwing handler killing
  // the process, so it must survive a rejection with null or undefined.
  if (err === null || err === undefined) return '⚠️ Something went wrong.';
  const status = (err as { status?: number }).status;
  if (status === 0) return '⚠️ The engine is unreachable. Is it running?';
  if (status === 401) return '⚠️ The bot is not authorised to talk to the engine. Check ENGINE_API_KEY matches on both sides.';
  if (status === 404) return '⚠️ The engine could not find that wallet.';
  // 400 means the engine rejected the input and its message says why, in
  // words meant for a person - show it rather than a generic failure.
  if (status === 400) return `⚠️ ${(err as Error).message ?? 'invalid request'}`;
  return `⚠️ Engine error: ${(err as Error).message ?? String(err)}`;
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
