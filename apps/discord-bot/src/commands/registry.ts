import { REST, Routes } from 'discord.js';
import { trackCommand } from './track.js';
import { untrackCommand } from './untrack.js';
import { pnlCommand } from './pnl.js';
import { walletsCommand } from './wallets.js';
import { setupCommand } from './setup.js';
import type { BotCommand } from './types.js';

export const commands: BotCommand[] = [setupCommand, trackCommand, untrackCommand, walletsCommand, pnlCommand];

export async function registerCommands(token: string, clientId: string, devGuildId?: string): Promise<void> {
  const rest = new REST().setToken(token);
  const body = commands.map((command) => command.data.toJSON());

  // Global registration is what lets the bot work in servers it has never
  // seen. Discord can take up to an hour to propagate it.
  await rest.put(Routes.applicationCommands(clientId), { body });

  // A dev guild, when configured, gets the same commands immediately, so
  // iteration does not wait on global propagation.
  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
  }
}

// `pnpm --filter @cryptonix/discord-bot register-commands` runs this file directly.
if (process.argv[1]?.endsWith('registry.ts') || process.argv[1]?.endsWith('registry.js')) {
  const { env } = await import('../env.js');
  await registerCommands(env.discordToken, env.discordClientId, env.devGuildId);
  console.log(
    `Registered ${commands.length} slash commands globally` +
      (env.devGuildId ? ` and to dev guild ${env.devGuildId}` : '')
  );
}
