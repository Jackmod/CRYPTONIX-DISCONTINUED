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

  /**
   * Local changes not yet reflected in an applied engine snapshot.
   *
   * load() replaces the whole map with what the engine returns, which is
   * necessarily older than anything we did locally since the request went out.
   * Without these, two things broke: a /setup landing mid-load was overwritten
   * by the older snapshot (engine says configured, bot posts nothing), and a
   * guild the bot was kicked from was resurrected and stayed in the routing
   * table forever, costing one failed channels.fetch per alert.
   *
   * They are recorded unconditionally, not only while a load is in flight.
   * loadUntilSuccessful spends most of an outage asleep between attempts with
   * nothing in flight, and a change made in that window is just as unreflected
   * as one made during a request — and must equally be able to cancel a
   * pending entry left over from a failed attempt.
   *
   * The two collections are kept disjoint: recording in one clears the other,
   * so the most recent local intent for a guild is the only one that survives.
   */
  private pendingWrites = new Map<string, string>();
  private pendingRemovals = new Set<string>();

  constructor(private engine: Pick<EngineClient, 'listGuildConfigs'>) {}

  /** True once a load has actually succeeded. */
  get isLoaded(): boolean {
    return this.loadedOnce;
  }

  async load(): Promise<boolean> {
    try {
      const configs = await this.engine.listGuildConfigs();
      const loaded = new Map(configs.map((config) => [config.guildId, config.alertChannelId]));

      // Local changes win: they are newer than this snapshot by construction.
      for (const guildId of this.pendingRemovals) loaded.delete(guildId);
      for (const [guildId, channelId] of this.pendingWrites) loaded.set(guildId, channelId);
      this.channels = loaded;
      this.loadedOnce = true;

      // Applied — safe to forget now, and only now. Clearing on a failed
      // attempt instead would drop a change before any snapshot reflected it.
      this.pendingWrites.clear();
      this.pendingRemovals.clear();
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
    this.pendingWrites.set(guildId, alertChannelId);
    this.pendingRemovals.delete(guildId);
  }

  remove(guildId: string) {
    this.channels.delete(guildId);
    this.pendingRemovals.add(guildId);
    this.pendingWrites.delete(guildId);
  }

  entries() {
    return [...this.channels].map(([guildId, alertChannelId]) => ({ guildId, alertChannelId }));
  }
}
