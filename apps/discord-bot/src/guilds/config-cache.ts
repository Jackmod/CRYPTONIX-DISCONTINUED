import type { EngineClient } from '../engine/client.js';

/**
 * Guild → alert channel, held in memory because alerts arrive on a socket and
 * must be posted immediately. Querying the engine per alert would put a round
 * trip on the hot path and make the bot useless exactly when the engine is
 * struggling. One entry per server, changed only by /setup.
 */
export class GuildConfigCache {
  private channels = new Map<string, string>();
  private loadedOnce = false;

  constructor(private engine: Pick<EngineClient, 'listGuildConfigs'>) {}

  /** True once a load has actually succeeded. */
  get isLoaded(): boolean {
    return this.loadedOnce;
  }

  async load(): Promise<boolean> {
    try {
      const configs = await this.engine.listGuildConfigs();
      this.channels = new Map(configs.map((config) => [config.guildId, config.alertChannelId]));
      this.loadedOnce = true;
      return true;
    } catch (err) {
      // Starting with an empty table is recoverable — crashing here would put
      // the bot in a restart loop whenever the engine came up second. But it
      // must not be permanent: see loadUntilSuccessful.
      console.error('could not load guild configs', err);
      return false;
    }
  }

  /**
   * Keeps retrying until a load succeeds.
   *
   * A single load() at startup was not enough. If the engine happened to be
   * down for those few seconds, the routing table stayed empty for the life of
   * the process: the alert socket reconnects on its own, so alerts kept
   * arriving and kept fanning out to nobody, with no error and no recovery
   * short of a restart or someone re-running /setup in every server.
   */
  async loadUntilSuccessful(retryDelayMs = 5_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
    while (!(await this.load())) {
      console.error(`retrying guild config load in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
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
