import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { EngineClient } from '../engine/client.js';
import type { GuildConfigCache } from '../guilds/config-cache.js';

export interface CommandDeps {
  engine: EngineClient;
  guildConfigs: GuildConfigCache;
}

export interface BotCommand {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
  /** Optional: fills in an option's suggestions as the user types. */
  autocomplete?(interaction: AutocompleteInteraction, deps: CommandDeps): Promise<void>;
}

/** Discord shows at most 25 suggestions, and truncates neither for you. */
export const MAX_CHOICES = 25;
const MAX_CHOICE_NAME = 100;

export interface WalletChoice {
  name: string;
  value: string;
}

/**
 * Tracked wallets as autocomplete choices, filtered by what has been typed.
 *
 * Addresses are 44 characters of base58 that nobody retypes correctly, so
 * `/untrack wallet` was effectively a copy-and-paste-only command. The value
 * is always the address, which is what both commands resolve against.
 */
export function walletChoices(
  wallets: { label: string; address: string; isMine: boolean }[],
  query: string
): WalletChoice[] {
  const needle = query.trim().toLowerCase();
  const matches = wallets.filter(
    (w) => needle === '' || w.label.toLowerCase().includes(needle) || w.address.toLowerCase().includes(needle)
  );

  // Your own wallets first, the same order the app uses.
  matches.sort((a, b) => {
    if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return matches.slice(0, MAX_CHOICES).map((w) => ({
    name: clampChoiceName(`${w.label}${w.isMine ? ' (yours)' : ''} — ${shortAddress(w.address)}`),
    value: w.address,
  }));
}

/** Discord rejects the whole response if any choice name is over 100 chars. */
function clampChoiceName(name: string): string {
  return name.length <= MAX_CHOICE_NAME ? name : `${name.slice(0, MAX_CHOICE_NAME - 1)}…`;
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
