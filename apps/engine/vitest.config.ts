import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Test files share one live Postgres DB and truncate overlapping tables
    // in beforeEach (see pnl-tracker.test.ts and wallet-monitor.test.ts, both
    // of which use wallet address 'Addr1'). Running files in parallel lets
    // one file's TRUNCATE race another file's INSERT, causing intermittent
    // unique-constraint failures. Force files to run one at a time.
    fileParallelism: false,
  },
});
