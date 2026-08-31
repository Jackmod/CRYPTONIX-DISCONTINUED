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

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Command replies interpolate user-supplied text (a wallet label, an
  // address someone typed). Without this, `/pnl wallet:@everyone` would make
  // the bot emit a mass ping on behalf of an unprivileged member. Nothing this
  // bot sends ever needs to mention anyone.
  allowedMentions: { parse: [] },
});

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
  // Stop trying to post to a server that removed us — in the cache AND in the
  // engine. Clearing only the cache left the row behind, so the next restart
  // reloaded it and every alert failed fetching a channel we can no longer see.
  guildConfigs.remove(guild.id);
  engine.deleteGuildConfig(guild.id).catch((err) => {
    console.error(`could not remove guild ${guild.id} config from the engine`, err);
  });
});

const stream = new AlertStream({ url: env.engineWsUrl, apiKey: env.engineApiKey });

client.once(Events.ClientReady, async (ready) => {
  console.log(`discord bot ready as ${ready.user.tag}`);

  // Not awaited: if the engine is down right now this retries in the
  // background rather than blocking login, so /setup still works and the
  // routing table fills in as soon as the engine is reachable.
  void guildConfigs.loadUntilSuccessful().then(() => {
    console.log(`loaded alert routing for ${guildConfigs.entries().length} server(s)`);
  });

  stream.onAlert((alert) => {
    // fanOutAlert guards each guild's send individually, but building the
    // message happens before that loop. An unhandled rejection here would
    // take the process down, so the whole call gets a boundary.
    fanOutAlert(alert, guildConfigs, async (channelId, message) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('send' in channel)) {
        throw new Error(`channel ${channelId} is not a text channel the bot can post to`);
      }
      await channel.send(message as Parameters<typeof channel.send>[0]);
    }).catch((err) => {
      console.error(`failed to fan out alert ${alert.refId}`, err);
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
