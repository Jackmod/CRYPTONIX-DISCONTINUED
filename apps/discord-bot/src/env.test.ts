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
  DISCORD_ALERT_CHANNEL_ID: 'channel1',
  ENGINE_HTTP_URL: 'http://localhost:8787',
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
    expect(env.alertChannelId).toBe('channel1');
    expect(env.engineWsUrl).toBe('ws://localhost:8787/ws');
  });

  it('throws a named error when a variable is missing', async () => {
    // Failing loudly at startup beats a bot that logs in fine and then
    // silently posts nothing because the channel id was undefined.
    delete process.env.DISCORD_ALERT_CHANNEL_ID;

    await expect(import('./env')).rejects.toThrow('DISCORD_ALERT_CHANNEL_ID');
  });
});
