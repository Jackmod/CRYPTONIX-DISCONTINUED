import { REST, Routes } from 'discord.js';
import { trackCommand } from './track.js';
import { untrackCommand } from './untrack.js';
import { pnlCommand } from './pnl.js';
import type { BotCommand } from './types.js';

export const commands: BotCommand[] = [trackCommand, untrackCommand, pnlCommand];

export async function registerCommands(token: string, clientId: string, guildId: string): Promise<void> {
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands.map((command) => command.data.toJSON()),
  });
}

// `pnpm --filter @cryptonix/discord-bot register-commands` runs this file directly.
if (process.argv[1]?.endsWith('registry.ts') || process.argv[1]?.endsWith('registry.js')) {
  const { env } = await import('../env.js');
  await registerCommands(env.discordToken, env.discordClientId, env.discordGuildId);
  console.log(`Registered ${commands.length} slash commands to guild ${env.discordGuildId}`);
}
