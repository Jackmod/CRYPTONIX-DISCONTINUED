import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { env } from './env.js';
import { EngineClient } from './engine/client.js';
import { AlertStream } from './engine/alert-stream.js';
import { GuildConfigCache } from './guilds/config-cache.js';
import { fanOutAlert } from './guilds/fan-out.js';
import { commands } from './commands/registry.js';
import { describeError } from './commands/types.js';

const engine = new EngineClient(env.engineHttpUrl, env.engineApiKey);
const guildConfigs = new GuildConfigCache(engine);
const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { engine, guildConfigs });
  } catch (err) {
    // A handler that throws past its own catch must not take the process down.
    console.error(`command ${interaction.commandName} failed`, err);
    const message = describeError(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// Joining a server is the moment someone is most likely to be looking. Point
// them at /setup rather than leaving a silent bot that never posts.
client.on(Events.GuildCreate, async (guild) => {
  const me = guild.members.me;
  const channel = guild.channels.cache.find(
    (c) => c.isTextBased() && me !== null && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === true
  );
  if (!channel?.isTextBased() || !('send' in channel)) return;

  await channel
    .send(
      'Thanks for adding **Cryptonix**. Run `/setup` in the channel you want alerts in — ' +
        'or `/setup channel:#some-channel` to pick a different one. Then `/track wallet` to start following a wallet.'
    )
    .catch(() => {});
});

client.on(Events.GuildDelete, (guild) => {
  // Stop trying to post to a server that removed us.
  guildConfigs.remove(guild.id);
});

const stream = new AlertStream({ url: env.engineWsUrl });

client.once(Events.ClientReady, async (ready) => {
  console.log(`discord bot ready as ${ready.user.tag}`);

  await guildConfigs.load();
  console.log(`loaded alert routing for ${guildConfigs.entries().length} server(s)`);

  stream.onAlert((alert) => {
    void fanOutAlert(alert, guildConfigs, async (channelId, message) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('send' in channel)) {
        throw new Error(`channel ${channelId} is not a text channel the bot can post to`);
      }
      await channel.send(message as Parameters<typeof channel.send>[0]);
    });
  });

  stream.start();
  console.log(`subscribed to engine alerts at ${env.engineWsUrl}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stream.stop();
    client.destroy();
    process.exit(0);
  });
}

client.login(env.discordToken).catch((err) => {
  console.error('discord login failed', err);
  process.exit(1);
});
