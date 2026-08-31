import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Neutralise real .env loading. env.ts calls loadEnvFile(), which finds the
// repo-root .env — the real one, which contains every variable these tests
// deliberately remove. Without this mock, dotenv would put the deleted
// variable straight back and the missing-variable test would pass a value it
// was supposed to be missing.
vi.mock('dotenv', () => ({ config: vi.fn() }));

const REQUIRED = {
  DISCORD_TOKEN: 'token1',
  DISCORD_CLIENT_ID: 'client1',
  DISCORD_GUILD_ID: 'guild1',
  ENGINE_HTTP_URL: 'http://localhost:8787',
  ENGINE_API_KEY: 'engine-key',
  ENGINE_WS_URL: 'ws://localhost:8787/ws',
};

describe('env', () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED)) process.env[key] = value;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('reads every required variable', async () => {
    const { env } = await import('./env');

    expect(env.discordToken).toBe('token1');
    expect(env.engineWsUrl).toBe('ws://localhost:8787/ws');
  });

  it('throws a named error when a variable is missing', async () => {
    // Failing loudly at startup beats a bot that logs in fine and then
    // silently does nothing because a URL was undefined.
    delete process.env.ENGINE_WS_URL;

    await expect(import('./env')).rejects.toThrow('ENGINE_WS_URL');
  });

  it('treats DISCORD_GUILD_ID as an optional dev convenience', async () => {
    // Commands register globally so the bot works in servers it has never
    // seen. A dev guild id, when present, additionally registers there for
    // instant availability instead of waiting for global propagation.
    delete process.env.DISCORD_GUILD_ID;

    const { env } = await import('./env');

    expect(env.devGuildId).toBeUndefined();
  });
});
