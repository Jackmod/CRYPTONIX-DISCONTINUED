import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { env } from './env.js';
import { EngineClient } from './engine/client.js';
import { AlertStream } from './engine/alert-stream.js';
import { GuildConfigCache } from './guilds/config-cache.js';
import { fanOutAlert } from './guilds/fan-out.js';
import { AlertReplay } from './alerts/replay.js';
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

/** Must match the engine's MAX_ALERT_REPLAY. */
const ALERT_PAGE_SIZE = 50;

/**
 * Owns the alert cursor, de-duplication and backlog walk.
 *
 * Deliberately a separate, tested unit: every bug in this area (replaying
 * history on restart, stopping after one page, double-posting, skipping ids a
 * live alert jumped over) was invisible here in the wiring.
 */
const replay = new AlertReplay({
  listAlertsSince: (since) => engine.listAlertsSince(since),
  getAlertHead: () => engine.getAlertHead(),
  pageSize: ALERT_PAGE_SIZE,
  deliver: (alert) =>
    fanOutAlert(alert, guildConfigs, async (channelId, message) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('send' in channel)) {
        throw new Error(`channel ${channelId} is not a text channel the bot can post to`);
      }
      await channel.send(message as Parameters<typeof channel.send>[0]);
    }),
});

/**
 * Drops routing rows for servers the bot is no longer in.
 *
 * GuildDelete handles a kick that happens while we are running, but a kick
 * during an engine outage — or while the bot is offline entirely — leaves a
 * row nothing ever removes. It is reloaded on the next start and then costs a
 * failed channels.fetch on every alert, forever.
 */
async function reconcileGuildConfigs() {
  const configs = await engine.listGuildConfigs();
  const stale = configs.filter((config) => !client.guilds.cache.has(config.guildId));

  for (const config of stale) {
    console.log(`removing routing for guild ${config.guildId}: the bot is no longer a member`);
    guildConfigs.remove(config.guildId);
    await engine
      .deleteGuildConfig(config.guildId)
      .catch((err) => console.error(`could not remove guild ${config.guildId} config`, err));
  }
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`discord bot ready as ${ready.user.tag}`);

  // Both of these must finish before the socket opens, and both retry rather
  // than give up. Starting the stream first would fan alerts out to an empty
  // routing table — and they would still be marked delivered, so they would be
  // lost for good — or run a catch-up from a cursor of 0 and replay the entire
  // alert history into every configured channel.
  await guildConfigs.loadUntilSuccessful();
  console.log(`loaded alert routing for ${guildConfigs.entries().length} server(s)`);
  await reconcileGuildConfigs().catch((err) => console.error('guild reconciliation failed', err));

  const head = await replay.start();
  console.log(`resuming alerts after id ${head}`);

  stream.onAlert((alert) => {
    // Each guild's send is guarded inside fanOutAlert, but building the message
    // happens before that loop. An unhandled rejection here would take the
    // process down, so the whole call gets a boundary.
    replay.handleLive(alert).catch((err) => {
      console.error(`failed to fan out alert ${alert.id}`, err);
    });
  });

  // Every (re)connection asks for what it missed while it was away.
  stream.onOpen(() => {
    void replay.catchUp().then(
      (posted) => {
        if (posted > 0) console.log(`replayed ${posted} alert(s) missed while disconnected`);
      },
      (err) => console.error('alert catch-up failed', err)
    );
  });

  stream.start();
  console.log(`subscribed to engine alerts at ${env.engineWsUrl}`);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A second signal should still kill us rather than queue another shutdown.
    if (shuttingDown) process.exit(1);
    shuttingDown = true;

    stream.stop();
    // destroy() is async: exiting without awaiting it abandoned in-flight
    // editReply calls and skipped the clean gateway close, so Discord saw the
    // bot time out instead of disconnect.
    void client
      .destroy()
      .catch((err) => console.error('error closing the Discord client', err))
      .finally(() => process.exit(0));
  });
}

client.login(env.discordToken).catch((err) => {
  console.error('discord login failed', err);
  process.exit(1);
});
