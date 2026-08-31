import type { EngineClient } from '../engine/client.js';

/**
 * Guild → alert channel, held in memory because alerts arrive on a socket and
 * must be posted immediately. Querying the engine per alert would put a round
 * trip on the hot path and make the bot useless exactly when the engine is
 * struggling. One entry per server, changed only by /setup.
 */
export class GuildConfigCache {
  private channels = new Map<string, string>();

  constructor(private engine: Pick<EngineClient, 'listGuildConfigs'>) {}

  async load(): Promise<void> {
    try {
      const configs = await this.engine.listGuildConfigs();
      this.channels = new Map(configs.map((config) => [config.guildId, config.alertChannelId]));
    } catch (err) {
      // Starting with an empty table is recoverable — /setup repopulates it,
      // and the next load() picks up the rest. Crashing here would put the bot
      // in a restart loop whenever the engine came up second.
      console.error('could not load guild configs; starting with none', err);
    }
  }

  set(guildId: string, alertChannelId: string) {
    this.channels.set(guildId, alertChannelId);
  }

  remove(guildId: string) {
    this.channels.delete(guildId);
  }

  entries() {
    return [...this.channels].map(([guildId, alertChannelId]) => ({ guildId, alertChannelId }));
  }
}
