import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Every file in this suite boots an engine against the same Postgres
    // database and truncates it in startStack(). Running files in parallel
    // lets one file's TRUNCATE delete rows another file is mid-way through
    // asserting on, which surfaces as phantom 500s and empty result sets.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
