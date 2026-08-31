import type { ChatInputCommandInteraction } from 'discord.js';
import type { EngineClient } from '../engine/client.js';

export interface CommandDeps {
  engine: EngineClient;
}

export interface BotCommand {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
}

/** Every command reports failure the same way: ephemeral, and never silent. */
export function describeError(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (status === 0) return '⚠️ The engine is unreachable. Is it running?';
  if (status === 404) return '⚠️ The engine could not find that wallet.';
  return `⚠️ Engine error: ${(err as Error).message}`;
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
