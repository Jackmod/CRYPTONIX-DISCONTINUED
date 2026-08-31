import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { env } from './env.js';
import { EngineClient } from './engine/client.js';
import { AlertStream } from './engine/alert-stream.js';
import { buildWalletTradeMessage, isWalletAlertPayload } from './embeds/wallet-buy.js';
import { commands } from './commands/registry.js';
import { describeError } from './commands/types.js';

const engine = new EngineClient(env.engineHttpUrl);
const commandsByName = new Map(commands.map((command) => [command.data.name, command]));

// Guilds is the only intent needed: slash commands and channel posting do not
// require any privileged intent, so the bot works without toggling anything
// extra in the Developer Portal.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandsByName.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { engine });
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

const stream = new AlertStream({ url: env.engineWsUrl });

client.once(Events.ClientReady, async (ready) => {
  console.log(`discord bot ready as ${ready.user.tag}`);

  const channel = await client.channels.fetch(env.alertChannelId);
  if (!channel?.isTextBased() || !('send' in channel)) {
    throw new Error(`DISCORD_ALERT_CHANNEL_ID ${env.alertChannelId} is not a text channel the bot can post to`);
  }

  stream.onAlert(async (alert) => {
    // Phase 3 adds tweet and new-coin alerts to this same socket. Anything this
    // version does not understand is logged and skipped, never rendered.
    if (alert.type !== 'wallet_buy' && alert.type !== 'wallet_sell') return;
    if (!isWalletAlertPayload(alert.payload)) {
      console.error(`alert ${alert.refId} has an unexpected payload shape; skipping`);
      return;
    }

    try {
      await channel.send(buildWalletTradeMessage(alert.payload));
    } catch (err) {
      // A Discord outage or a revoked permission must not kill the process —
      // the engine keeps recording trades either way.
      console.error('failed to post alert to Discord', err);
    }
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
