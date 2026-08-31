# Cryptonix Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cryptonix monorepo and engine core — wallet tracking, live buy detection, Axiom link generation, and PnL calculation — as working, testable software you can drive with `curl` before any Discord bot or desktop UI exists.

**Architecture:** pnpm/Turborepo TypeScript monorepo. `packages/core` holds pure domain logic (Axiom link building, swap parsing, FIFO PnL math) with no I/O, fully unit-tested. `packages/db` holds the Drizzle/Postgres schema. `apps/engine` wires those into a wallet monitor (Helius webhooks → parsed trades → alerts), a PnL tracker (historical backfill + FIFO), a REST API, and a WebSocket alert broadcaster.

**Tech Stack:** TypeScript, pnpm workspaces, Turborepo, Drizzle ORM, PostgreSQL (local via Docker for now), Express, `ws`, Vitest, Helius API (free tier).

**Spec:** `docs/superpowers/specs/2026-08-30-cryptonix-design.md`

## Global Constraints

- Solana only — no other chains (spec §2/§3).
- Free-tier infrastructure only: Helius free tier, no paid services in this plan (spec §2, §7).
- No automated trade execution — the system only produces Axiom links, never places trades (spec §3).
- Each monitor/module is isolated and independently testable; no god-files — one clear responsibility per file (spec §8, §9).
- PnL is computed natively in SOL via FIFO cost-basis matching, not per-token USD feeds (spec §5.1, §6).
- Full historical backfill runs whenever a wallet (tracked or `is_mine`) is added (spec §5.1, user decision).

---

## Prerequisites (do this before Task 1)

You need one free external credential and one local tool:

1. **Helius API key** — go to https://www.helius.dev, sign up free, create a project, copy the API key from the dashboard. This is the only external account this plan needs.
2. **Docker** — for a local Postgres instance. If you don't have it, install Docker Desktop. (When Cryptonix later deploys to the cloud, `DATABASE_URL` just points at a hosted Postgres like Neon instead — no code changes.)
3. **Node.js 20+** and **pnpm** (`npm i -g pnpm`).

Keep the Helius API key handy — Task 1 puts it in `.env`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.env` (not committed)
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.base.json`

**Interfaces:**
- Produces: the workspace root every later task's `package.json` extends, and `.env` vars (`DATABASE_URL`, `HELIUS_API_KEY`, `WEBHOOK_BASE_URL`, `PORT`) every later task reads.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "cryptonix",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "dev": "turbo run dev --parallel"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  },
  "packageManager": "pnpm@9.12.0"
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  }
}
```

Deliberately no `rootDir`/`outDir` here: TypeScript resolves path-valued
compiler options relative to the config file that *declares* them, not
the file that extends it — so a shared `outDir`/`rootDir` in this root
file would resolve relative to the repo root for every package, not
each package's own directory. Each package sets `rootDir`/`outDir`
itself (see Task 2 Step 1 and onward).

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
dist
.env
*.log
.turbo
.superpowers
```

- [ ] **Step 6: Create `.env.example` and your real `.env`**

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test
HELIUS_API_KEY=your-helius-api-key-here
WEBHOOK_BASE_URL=http://localhost:8787
PORT=8787
```

Copy this to `.env` and paste in your real Helius API key from the Prerequisites step.

- [ ] **Step 7: Start local Postgres via Docker**

```bash
docker run -d --name cryptonix-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
docker exec cryptonix-pg psql -U postgres -c "CREATE DATABASE cryptonix;"
docker exec cryptonix-pg psql -U postgres -c "CREATE DATABASE cryptonix_test;"
```

- [ ] **Step 8: Create `packages/config/package.json` and shared tsconfig**

`packages/config/package.json`:
```json
{
  "name": "@cryptonix/config",
  "version": "0.0.0",
  "private": true,
  "files": ["tsconfig.base.json"]
}
```

`packages/config/tsconfig.base.json` — re-export the root one so app packages have a stable import path:
```json
{
  "extends": "../../tsconfig.base.json"
}
```

- [ ] **Step 9: Install and commit**

```bash
pnpm install
git add -A
git commit -m "Scaffold pnpm/Turborepo monorepo"
```

---

### Task 2: `packages/core` — Axiom link builder

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/axiom-links/build-link.ts`
- Test: `packages/core/src/axiom-links/build-link.test.ts`

**Interfaces:**
- Produces: `buildAxiomLink(mint: string): string`

- [ ] **Step 1: Scaffold the package**

`packages/core/package.json`:
```json
{
  "name": "@cryptonix/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@cryptonix/config": "workspace:*",
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "@cryptonix/config/tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/axiom-links/build-link.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildAxiomLink } from './build-link';

describe('buildAxiomLink', () => {
  it('builds an axiom.trade link from a mint address', () => {
    expect(buildAxiomLink('So11111111111111111111111111111111111111112'))
      .toBe('https://axiom.trade/t/So11111111111111111111111111111111111111112');
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @cryptonix/core test
```
Expected: FAIL — `build-link.ts` does not exist yet.

- [ ] **Step 4: Implement**

`packages/core/src/axiom-links/build-link.ts`:
```ts
export function buildAxiomLink(mint: string): string {
  return `https://axiom.trade/t/${mint}`;
}
```

- [ ] **Step 5: Run and confirm it passes**

```bash
pnpm --filter @cryptonix/core test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "core: add Axiom link builder"
```

---

### Task 3: `packages/core` — swap transaction parser

**Files:**
- Create: `packages/core/src/wallet-parsing/types.ts`
- Create: `packages/core/src/wallet-parsing/parse-swap.ts`
- Test: `packages/core/src/wallet-parsing/parse-swap.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `HeliusEnhancedTransaction`, `HeliusTokenTransfer`, `HeliusNativeTransfer` types; `ParsedSwap` type; `parseSwap(tx: HeliusEnhancedTransaction, walletAddress: string): ParsedSwap | null`. `apps/engine`'s Helius client and wallet monitor consume these.

- [ ] **Step 1: Define the Helius payload shape**

`packages/core/src/wallet-parsing/types.ts`:
```ts
export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusEnhancedTransaction {
  signature: string;
  timestamp: number; // unix seconds
  type: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
}

export interface ParsedSwap {
  signature: string;
  ts: Date;
  mint: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
}
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/wallet-parsing/parse-swap.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseSwap } from './parse-swap';
import type { HeliusEnhancedTransaction } from './types';

const WALLET = 'WalletAddr111';
const OTHER = 'PoolAddr222';
const MINT = 'TokenMint333';

function tx(overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return {
    signature: 'sig1',
    timestamp: 1_735_000_000,
    type: 'SWAP',
    tokenTransfers: [],
    nativeTransfers: [],
    ...overrides,
  };
}

describe('parseSwap', () => {
  it('parses a buy: wallet receives token, pays SOL', () => {
    const result = parseSwap(
      tx({
        tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, mint: MINT, tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 2_000_000_000 }],
      }),
      WALLET
    );
    expect(result).toEqual({
      signature: 'sig1',
      ts: new Date(1_735_000_000 * 1000),
      mint: MINT,
      side: 'buy',
      solAmount: 2,
      tokenAmount: 1000,
    });
  });

  it('parses a sell: wallet sends token, receives SOL', () => {
    const result = parseSwap(
      tx({
        tokenTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, mint: MINT, tokenAmount: 500 }],
        nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, amount: 1_500_000_000 }],
      }),
      WALLET
    );
    expect(result).toEqual({
      signature: 'sig1',
      ts: new Date(1_735_000_000 * 1000),
      mint: MINT,
      side: 'sell',
      solAmount: 1.5,
      tokenAmount: 500,
    });
  });

  it('returns null when the wallet is not involved in any token transfer', () => {
    const result = parseSwap(
      tx({
        tokenTransfers: [{ fromUserAccount: OTHER, toUserAccount: 'SomeoneElse', mint: MINT, tokenAmount: 10 }],
      }),
      WALLET
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @cryptonix/core test
```
Expected: FAIL — `parse-swap.ts` does not exist.

- [ ] **Step 4: Implement**

`packages/core/src/wallet-parsing/parse-swap.ts`:
```ts
import type { HeliusEnhancedTransaction, ParsedSwap } from './types';

const LAMPORTS_PER_SOL = 1_000_000_000;

export function parseSwap(tx: HeliusEnhancedTransaction, walletAddress: string): ParsedSwap | null {
  const incoming = tx.tokenTransfers.find((t) => t.toUserAccount === walletAddress);
  const outgoing = tx.tokenTransfers.find((t) => t.fromUserAccount === walletAddress);

  const ts = new Date(tx.timestamp * 1000);

  if (incoming) {
    const solPaid = tx.nativeTransfers
      .filter((n) => n.fromUserAccount === walletAddress)
      .reduce((sum, n) => sum + n.amount, 0);
    return {
      signature: tx.signature,
      ts,
      mint: incoming.mint,
      side: 'buy',
      solAmount: solPaid / LAMPORTS_PER_SOL,
      tokenAmount: incoming.tokenAmount,
    };
  }

  if (outgoing) {
    const solReceived = tx.nativeTransfers
      .filter((n) => n.toUserAccount === walletAddress)
      .reduce((sum, n) => sum + n.amount, 0);
    return {
      signature: tx.signature,
      ts,
      mint: outgoing.mint,
      side: 'sell',
      solAmount: solReceived / LAMPORTS_PER_SOL,
      tokenAmount: outgoing.tokenAmount,
    };
  }

  return null;
}

export type { HeliusEnhancedTransaction, HeliusTokenTransfer, HeliusNativeTransfer, ParsedSwap } from './types';
```

- [ ] **Step 5: Run and confirm it passes**

```bash
pnpm --filter @cryptonix/core test
```
Expected: PASS, all 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "core: add Helius swap transaction parser"
```

---

### Task 4: `packages/core` — FIFO PnL calculator

**Files:**
- Create: `packages/core/src/pnl/fifo.ts`
- Test: `packages/core/src/pnl/fifo.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Lot` type, `applyFifo(lots: Lot[], sellTokenAmount: number, sellSolReceived: number): { remainingLots: Lot[]; realizedPnlSol: number }`. `apps/engine`'s PnL tracker consumes this.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/pnl/fifo.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { applyFifo, type Lot } from './fifo';

describe('applyFifo', () => {
  it('consumes a single lot fully and computes profit', () => {
    const lots: Lot[] = [{ solCost: 2, tokenAmount: 1000 }];
    const { remainingLots, realizedPnlSol } = applyFifo(lots, 1000, 3);
    expect(remainingLots).toEqual([]);
    expect(realizedPnlSol).toBeCloseTo(1); // sold for 3, cost was 2
  });

  it('partially consumes a lot, leaving the remainder', () => {
    const lots: Lot[] = [{ solCost: 4, tokenAmount: 1000 }];
    const { remainingLots, realizedPnlSol } = applyFifo(lots, 250, 1.5);
    expect(remainingLots).toEqual([{ solCost: 3, tokenAmount: 750 }]);
    expect(realizedPnlSol).toBeCloseTo(0.5); // cost of 250 tokens = 1, sold for 1.5
  });

  it('consumes across multiple lots oldest-first', () => {
    const lots: Lot[] = [
      { solCost: 1, tokenAmount: 100 }, // unit cost 0.01
      { solCost: 3, tokenAmount: 100 }, // unit cost 0.03
    ];
    const { remainingLots, realizedPnlSol } = applyFifo(lots, 150, 2);
    // consumes all of lot 1 (cost 1) + half of lot 2 (cost 1.5) = cost basis 2.5
    expect(remainingLots).toEqual([{ solCost: 1.5, tokenAmount: 50 }]);
    expect(realizedPnlSol).toBeCloseTo(-0.5);
  });

  it('does not mutate the input lots array', () => {
    const lots: Lot[] = [{ solCost: 2, tokenAmount: 1000 }];
    applyFifo(lots, 500, 1);
    expect(lots).toEqual([{ solCost: 2, tokenAmount: 1000 }]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm --filter @cryptonix/core test
```
Expected: FAIL — `fifo.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/core/src/pnl/fifo.ts`:
```ts
export interface Lot {
  solCost: number;
  tokenAmount: number;
}

export interface FifoOutcome {
  remainingLots: Lot[];
  realizedPnlSol: number;
}

export function applyFifo(lots: Lot[], sellTokenAmount: number, sellSolReceived: number): FifoOutcome {
  const remaining = lots.map((lot) => ({ ...lot }));
  let toSell = sellTokenAmount;
  let costBasisConsumed = 0;

  while (toSell > 0 && remaining.length > 0) {
    const lot = remaining[0];
    const unitCost = lot.solCost / lot.tokenAmount;

    if (lot.tokenAmount <= toSell) {
      costBasisConsumed += lot.solCost;
      toSell -= lot.tokenAmount;
      remaining.shift();
    } else {
      const consumedCost = unitCost * toSell;
      costBasisConsumed += consumedCost;
      lot.tokenAmount -= toSell;
      lot.solCost -= consumedCost;
      toSell = 0;
    }
  }

  return { remainingLots: remaining, realizedPnlSol: sellSolReceived - costBasisConsumed };
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
pnpm --filter @cryptonix/core test
```
Expected: PASS, all 4 tests.

- [ ] **Step 5: Create the package's barrel export**

`packages/core/src/index.ts`:
```ts
export * from './axiom-links/build-link';
export * from './wallet-parsing/parse-swap'; // re-exports the ./wallet-parsing/types too
export * from './pnl/fifo';
```

- [ ] **Step 6: Build and commit**

```bash
pnpm --filter @cryptonix/core build
git add packages/core
git commit -m "core: add FIFO PnL calculator, barrel export"
```

---

### Task 5: `packages/db` — schema and client

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `wallets`, `walletTrades`, `pnlDaily`, `alerts` Drizzle tables; `createDb(connectionString: string): Db`; `type Db`. `apps/engine` consumes all of these.

- [ ] **Step 1: Scaffold the package**

`packages/db/package.json`:
```json
{
  "name": "@cryptonix/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@cryptonix/config": "workspace:*",
    "drizzle-kit": "^0.28.0",
    "@types/pg": "^8.11.0",
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

`packages/db/tsconfig.json`:
```json
{
  "extends": "@cryptonix/config/tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the schema**

`packages/db/src/schema.ts`:
```ts
import { pgTable, serial, text, boolean, timestamp, doublePrecision, integer, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const wallets = pgTable('wallets', {
  id: serial('id').primaryKey(),
  address: text('address').notNull().unique(),
  label: text('label').notNull(),
  isMine: boolean('is_mine').notNull().default(false),
  heliusWebhookId: text('helius_webhook_id'),
  backfillStatus: text('backfill_status').notNull().default('pending'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
});

export const walletTrades = pgTable('wallet_trades', {
  id: serial('id').primaryKey(),
  walletId: integer('wallet_id').notNull().references(() => wallets.id),
  signature: text('signature').notNull(),
  mint: text('mint').notNull(),
  side: text('side').notNull(),
  solAmount: doublePrecision('sol_amount').notNull(),
  tokenAmount: doublePrecision('token_amount').notNull(),
  ts: timestamp('ts').notNull(),
}, (table) => ({
  walletSigIdx: uniqueIndex('wallet_trades_wallet_sig_idx').on(table.walletId, table.signature),
}));

export const pnlDaily = pgTable('pnl_daily', {
  id: serial('id').primaryKey(),
  walletId: integer('wallet_id').notNull().references(() => wallets.id),
  date: text('date').notNull(),
  realizedPnlSol: doublePrecision('realized_pnl_sol').notNull().default(0),
  tradeCount: integer('trade_count').notNull().default(0),
}, (table) => ({
  walletDateIdx: uniqueIndex('pnl_daily_wallet_date_idx').on(table.walletId, table.date),
}));

export const alerts = pgTable('alerts', {
  id: serial('id').primaryKey(),
  type: text('type').notNull(),
  refId: integer('ref_id').notNull(),
  payload: jsonb('payload').notNull(),
  ts: timestamp('ts').notNull().defaultNow(),
});
```

- [ ] **Step 3: Write the client**

`packages/db/src/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Db = NodePgDatabase<typeof schema>;
```

`packages/db/src/index.ts`:
```ts
export * from './schema';
export * from './client';
```

- [ ] **Step 4: Configure Drizzle Kit and generate the migration**

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

```bash
cd packages/db
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix pnpm db:generate
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix pnpm db:push
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm db:push
cd ../..
```
This creates the tables in both your dev and test databases.

- [ ] **Step 5: Write a smoke test that the schema round-trips**

`packages/db/src/schema.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, wallets } from './index';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

describe('wallets table', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE wallets CASCADE');
  });

  it('inserts and reads back a wallet', async () => {
    const [inserted] = await db.insert(wallets).values({ address: 'Addr1', label: 'Test' }).returning();
    expect(inserted.id).toBeDefined();
    expect(inserted.isMine).toBe(false);

    const rows = await db.select().from(wallets);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe('Addr1');
  });
});
```

- [ ] **Step 6: Run and confirm it passes**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/db test
```
Expected: PASS.

- [ ] **Step 7: Build and commit**

```bash
pnpm --filter @cryptonix/db build
git add packages/db
git commit -m "db: add Drizzle schema, client, and migrations"
```

---

### Task 6: `apps/engine` — Helius client

**Files:**
- Create: `apps/engine/package.json`
- Create: `apps/engine/tsconfig.json`
- Create: `apps/engine/vitest.config.ts`
- Create: `apps/engine/src/env.ts`
- Create: `apps/engine/src/helius/client.ts`
- Test: `apps/engine/src/helius/client.test.ts`

**Interfaces:**
- Consumes: `HeliusEnhancedTransaction` from `@cryptonix/core`.
- Produces: `env` object (`databaseUrl`, `heliusApiKey`, `webhookBaseUrl`, `port`); `HeliusClient` class with `createWalletWebhook(address: string): Promise<string>`, `getTransactionHistory(address: string, before?: string): Promise<HeliusEnhancedTransaction[]>`. The wallet monitor and PnL tracker (Tasks 7-8) consume this class. (Webhook deletion, for an "untrack wallet" flow, is added alongside that feature in the Discord bot plan — no code here would exercise it yet.)

- [ ] **Step 1: Scaffold the app**

`apps/engine/package.json`:
```json
{
  "name": "@cryptonix/engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@cryptonix/core": "workspace:*",
    "@cryptonix/db": "workspace:*",
    "dotenv": "^16.4.0",
    "express": "^4.21.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@cryptonix/config": "workspace:*",
    "@types/express": "^5.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

`apps/engine/tsconfig.json`:
```json
{
  "extends": "@cryptonix/config/tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/engine/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node' } });
```

- [ ] **Step 2: Write env config**

`apps/engine/src/env.ts`:
```ts
import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  heliusApiKey: required('HELIUS_API_KEY'),
  webhookBaseUrl: required('WEBHOOK_BASE_URL'),
  port: Number(process.env.PORT ?? 8787),
};
```

- [ ] **Step 3: Write the failing test for the Helius client**

`apps/engine/src/helius/client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeliusClient } from './client';

describe('HeliusClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a webhook and returns its id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ webhookID: 'wh_123' }),
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com' });

    const id = await client.createWalletWebhook('Addr1');

    expect(id).toBe('wh_123');
    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/webhooks?api-key=key1');
    expect(JSON.parse(options.body).accountAddresses).toEqual(['Addr1']);
  });

  it('throws when the webhook create request fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com' });

    await expect(client.createWalletWebhook('Addr1')).rejects.toThrow('Helius webhook create failed');
  });

  it('fetches transaction history', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [{ signature: 'sig1' }],
    });
    const client = new HeliusClient({ apiKey: 'key1', webhookBaseUrl: 'https://example.com' });

    const history = await client.getTransactionHistory('Addr1');

    expect(history).toEqual([{ signature: 'sig1' }]);
  });
});
```

- [ ] **Step 4: Run and confirm it fails**

```bash
pnpm --filter @cryptonix/engine test
```
Expected: FAIL — `client.ts` does not exist.

- [ ] **Step 5: Implement**

`apps/engine/src/helius/client.ts`:
```ts
import type { HeliusEnhancedTransaction } from '@cryptonix/core';

const HELIUS_BASE = 'https://api.helius.xyz/v0';

export interface HeliusClientConfig {
  apiKey: string;
  webhookBaseUrl: string;
}

export class HeliusClient {
  constructor(private config: HeliusClientConfig) {}

  async createWalletWebhook(address: string): Promise<string> {
    const res = await fetch(`${HELIUS_BASE}/webhooks?api-key=${this.config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL: `${this.config.webhookBaseUrl}/webhooks/helius`,
        transactionTypes: ['SWAP'],
        accountAddresses: [address],
        webhookType: 'enhanced',
      }),
    });
    if (!res.ok) throw new Error(`Helius webhook create failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { webhookID: string };
    return data.webhookID;
  }

  async getTransactionHistory(address: string, before?: string): Promise<HeliusEnhancedTransaction[]> {
    const url = new URL(`${HELIUS_BASE}/addresses/${address}/transactions`);
    url.searchParams.set('api-key', this.config.apiKey);
    url.searchParams.set('type', 'SWAP');
    if (before) url.searchParams.set('before', before);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Helius history fetch failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<HeliusEnhancedTransaction[]>;
  }
}
```

- [ ] **Step 6: Run and confirm it passes**

```bash
pnpm --filter @cryptonix/engine test
```
Expected: PASS, all 3 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/engine
git commit -m "engine: scaffold app, add env config and Helius client"
```

---

### Task 7: `apps/engine` — wallet monitor and alert bus

**Files:**
- Create: `apps/engine/src/api/alert-bus.ts`
- Create: `apps/engine/src/monitors/wallet-monitor.ts`
- Test: `apps/engine/src/monitors/wallet-monitor.test.ts`

**Interfaces:**
- Consumes: `Db`, `wallets`, `walletTrades`, `alerts` from `@cryptonix/db`; `parseSwap`, `buildAxiomLink`, `HeliusEnhancedTransaction` from `@cryptonix/core`; `HeliusClient` from Task 6.
- Produces: `AlertBus` (extends `EventEmitter`, `publish(alert: { type: string; refId: number; payload: unknown }): void`, emits `'alert'`); `WalletMonitor` class with `trackWallet(address: string, label: string, isMine: boolean): Promise<Wallet>` and `handleWebhookPayload(transactions: HeliusEnhancedTransaction[]): Promise<void>`. Tasks 8-9 (PnL tracker, API server) consume both.

- [ ] **Step 1: Write the alert bus (small enough it needs no separate test — covered by wallet-monitor's tests below)**

`apps/engine/src/api/alert-bus.ts`:
```ts
import { EventEmitter } from 'node:events';

export interface AlertEvent {
  type: string;
  refId: number;
  payload: unknown;
}

export class AlertBus extends EventEmitter {
  publish(alert: AlertEvent) {
    this.emit('alert', alert);
  }
}
```

- [ ] **Step 2: Write the failing tests for the wallet monitor**

`apps/engine/src/monitors/wallet-monitor.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, walletTrades, alerts } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import { WalletMonitor } from './wallet-monitor';
import { AlertBus } from '../api/alert-bus';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

function fakeHelius(webhookId = 'wh_1') {
  return { createWalletWebhook: vi.fn().mockResolvedValue(webhookId) } as any;
}

function swapTx(overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return {
    signature: 'sig1',
    timestamp: 1_735_000_000,
    type: 'SWAP',
    tokenTransfers: [],
    nativeTransfers: [],
    ...overrides,
  };
}

describe('WalletMonitor', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE alerts, wallet_trades, wallets RESTART IDENTITY CASCADE');
  });

  it('tracks a wallet: registers a Helius webhook and inserts a row', async () => {
    const helius = fakeHelius('wh_42');
    const monitor = new WalletMonitor(db, helius, new AlertBus());

    const wallet = await monitor.trackWallet('Addr1', 'My Wallet', true);

    expect(helius.createWalletWebhook).toHaveBeenCalledWith('Addr1');
    expect(wallet.address).toBe('Addr1');
    expect(wallet.heliusWebhookId).toBe('wh_42');
    expect(wallet.isMine).toBe(true);
  });

  it('handles an incoming buy transaction: records the trade and publishes an alert', async () => {
    const helius = fakeHelius();
    const alertBus = new AlertBus();
    const published: unknown[] = [];
    alertBus.on('alert', (a) => published.push(a));
    const monitor = new WalletMonitor(db, helius, alertBus);
    const wallet = await monitor.trackWallet('Addr1', 'My Wallet', true);

    await monitor.handleWebhookPayload([
      swapTx({
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
      }),
    ]);

    const trades = await db.select().from(walletTrades);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('buy');
    expect(trades[0].solAmount).toBe(2);

    const alertRows = await db.select().from(alerts);
    expect(alertRows).toHaveLength(1);
    expect(alertRows[0].type).toBe('wallet_buy');
    expect((alertRows[0].payload as any).axiomLink).toBe('https://axiom.trade/t/Mint1');

    expect(published).toHaveLength(1);
    expect((published[0] as any).type).toBe('wallet_buy');
  });

  it('is idempotent: the same signature delivered twice only records one trade', async () => {
    const monitor = new WalletMonitor(db, fakeHelius(), new AlertBus());
    await monitor.trackWallet('Addr1', 'My Wallet', true);
    const tx = swapTx({
      tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
      nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
    });

    await monitor.handleWebhookPayload([tx]);
    await monitor.handleWebhookPayload([tx]);

    const trades = await db.select().from(walletTrades);
    expect(trades).toHaveLength(1);
  });

  it('a transaction irrelevant to any tracked wallet produces no trade or alert', async () => {
    const monitor = new WalletMonitor(db, fakeHelius(), new AlertBus());
    await monitor.trackWallet('Addr1', 'My Wallet', true);

    await monitor.handleWebhookPayload([
      swapTx({
        tokenTransfers: [{ fromUserAccount: 'SomeoneElse', toUserAccount: 'AnotherWallet', mint: 'Mint1', tokenAmount: 10 }],
      }),
    ]);

    expect(await db.select().from(walletTrades)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: FAIL — `wallet-monitor.ts` does not exist.

- [ ] **Step 4: Implement**

`apps/engine/src/monitors/wallet-monitor.ts`:
```ts
import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, alerts } from '@cryptonix/db';
import { parseSwap, buildAxiomLink, type HeliusEnhancedTransaction } from '@cryptonix/core';
import type { HeliusClient } from '../helius/client';
import type { AlertBus } from '../api/alert-bus';

export class WalletMonitor {
  constructor(private db: Db, private helius: Pick<HeliusClient, 'createWalletWebhook'>, private alertBus: AlertBus) {}

  async trackWallet(address: string, label: string, isMine: boolean) {
    const webhookId = await this.helius.createWalletWebhook(address);
    const [wallet] = await this.db
      .insert(wallets)
      .values({ address, label, isMine, heliusWebhookId: webhookId })
      .returning();
    return wallet;
  }

  async handleWebhookPayload(transactions: HeliusEnhancedTransaction[]) {
    for (const tx of transactions) {
      await this.handleTransaction(tx);
    }
  }

  private async handleTransaction(tx: HeliusEnhancedTransaction) {
    const trackedWallets = await this.db.select().from(wallets);
    for (const wallet of trackedWallets) {
      try {
        await this.handleTransactionForWallet(tx, wallet);
      } catch (err) {
        console.error(`wallet monitor: failed processing tx ${tx.signature} for wallet ${wallet.id}`, err);
      }
    }
  }

  private async handleTransactionForWallet(tx: HeliusEnhancedTransaction, wallet: typeof wallets.$inferSelect) {
    const parsed = parseSwap(tx, wallet.address);
    if (!parsed) return;

    const [trade] = await this.db
      .insert(walletTrades)
      .values({
        walletId: wallet.id,
        signature: parsed.signature,
        mint: parsed.mint,
        side: parsed.side,
        solAmount: parsed.solAmount,
        tokenAmount: parsed.tokenAmount,
        ts: parsed.ts,
      })
      .onConflictDoNothing()
      .returning();
    if (!trade) return; // duplicate delivery of a signature we already recorded

    const payload = {
      walletId: wallet.id,
      walletLabel: wallet.label,
      mint: parsed.mint,
      side: parsed.side,
      solAmount: parsed.solAmount,
      tokenAmount: parsed.tokenAmount,
      axiomLink: buildAxiomLink(parsed.mint),
    };
    const [alert] = await this.db
      .insert(alerts)
      .values({ type: parsed.side === 'buy' ? 'wallet_buy' : 'wallet_sell', refId: trade.id, payload })
      .returning();

    this.alertBus.publish({ type: alert.type, refId: alert.refId, payload: alert.payload });
  }
}
```

- [ ] **Step 5: Run and confirm it passes**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: PASS, all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/engine
git commit -m "engine: add alert bus and wallet monitor"
```

---

### Task 8: `apps/engine` — PnL tracker

**Files:**
- Create: `apps/engine/src/monitors/pnl-tracker.ts`
- Test: `apps/engine/src/monitors/pnl-tracker.test.ts`

**Interfaces:**
- Consumes: `Db`, `wallets`, `walletTrades`, `pnlDaily` from `@cryptonix/db`; `parseSwap`, `applyFifo`, `Lot`, `HeliusEnhancedTransaction` from `@cryptonix/core`; `HeliusClient` from Task 6.
- Produces: `PnlTracker` class with `backfillWallet(walletId: number, address: string): Promise<void>` and `recomputePnl(walletId: number): Promise<void>`. The API server (Task 9) consumes `backfillWallet`.

- [ ] **Step 1: Write the failing tests**

`apps/engine/src/monitors/pnl-tracker.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, wallets, walletTrades, pnlDaily } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import { PnlTracker } from './pnl-tracker';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

function swapTx(sig: string, ts: number, overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return { signature: sig, timestamp: ts, type: 'SWAP', tokenTransfers: [], nativeTransfers: [], ...overrides };
}

describe('PnlTracker', () => {
  let walletId: number;

  beforeEach(async () => {
    await db.execute('TRUNCATE pnl_daily, wallet_trades, wallets RESTART IDENTITY CASCADE');
    const [wallet] = await db.insert(wallets).values({ address: 'Addr1', label: 'Test' }).returning();
    walletId = wallet.id;
  });

  it('backfills trade history from Helius and computes daily realized PnL', async () => {
    const helius = {
      getTransactionHistory: vi.fn().mockResolvedValueOnce([
        swapTx('buy1', 1_735_000_000, {
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
        }),
        swapTx('sell1', 1_735_003_600, {
          tokenTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', amount: 3_000_000_000 }],
        }),
      ]).mockResolvedValueOnce([]),
    } as any;
    const tracker = new PnlTracker(db, helius);

    await tracker.backfillWallet(walletId, 'Addr1');

    const trades = await db.select().from(walletTrades);
    expect(trades).toHaveLength(2);

    const pnlRows = await db.select().from(pnlDaily);
    expect(pnlRows).toHaveLength(1);
    expect(pnlRows[0].realizedPnlSol).toBeCloseTo(1); // bought for 2, sold for 3
    expect(pnlRows[0].tradeCount).toBe(2);
  });

  it('recomputePnl is idempotent when run twice on the same trades', async () => {
    await db.insert(walletTrades).values([
      { walletId, signature: 'buy1', mint: 'Mint1', side: 'buy', solAmount: 2, tokenAmount: 1000, ts: new Date('2026-08-30T10:00:00Z') },
      { walletId, signature: 'sell1', mint: 'Mint1', side: 'sell', solAmount: 3, tokenAmount: 1000, ts: new Date('2026-08-30T11:00:00Z') },
    ]);
    const tracker = new PnlTracker(db, {} as any);

    await tracker.recomputePnl(walletId);
    await tracker.recomputePnl(walletId);

    const pnlRows = await db.select().from(pnlDaily);
    expect(pnlRows).toHaveLength(1);
    expect(pnlRows[0].realizedPnlSol).toBeCloseTo(1);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: FAIL — `pnl-tracker.ts` does not exist.

- [ ] **Step 3: Implement**

`apps/engine/src/monitors/pnl-tracker.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { walletTrades, pnlDaily } from '@cryptonix/db';
import { parseSwap, applyFifo, type Lot, type HeliusEnhancedTransaction } from '@cryptonix/core';
import type { HeliusClient } from '../helius/client';

const MAX_BACKFILL_PAGES = 20;

export class PnlTracker {
  constructor(private db: Db, private helius: Pick<HeliusClient, 'getTransactionHistory'>) {}

  async backfillWallet(walletId: number, address: string) {
    const collected: HeliusEnhancedTransaction[] = [];
    let before: string | undefined;

    for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
      const batch = await this.helius.getTransactionHistory(address, before);
      if (batch.length === 0) break;
      collected.push(...batch);
      before = batch[batch.length - 1].signature;
      if (batch.length < 100) break;
    }

    collected.reverse(); // oldest first, so FIFO lots build up chronologically

    for (const tx of collected) {
      const parsed = parseSwap(tx, address);
      if (!parsed) continue;
      await this.db
        .insert(walletTrades)
        .values({
          walletId,
          signature: parsed.signature,
          mint: parsed.mint,
          side: parsed.side,
          solAmount: parsed.solAmount,
          tokenAmount: parsed.tokenAmount,
          ts: parsed.ts,
        })
        .onConflictDoNothing();
    }

    await this.recomputePnl(walletId);
  }

  async recomputePnl(walletId: number) {
    const trades = await this.db.select().from(walletTrades).where(eq(walletTrades.walletId, walletId)).orderBy(walletTrades.ts);

    const lotsByMint = new Map<string, Lot[]>();
    const dailyPnl = new Map<string, { realizedPnlSol: number; tradeCount: number }>();

    for (const trade of trades) {
      const day = trade.ts.toISOString().slice(0, 10);
      const dayEntry = dailyPnl.get(day) ?? { realizedPnlSol: 0, tradeCount: 0 };
      dayEntry.tradeCount += 1;

      const lots = lotsByMint.get(trade.mint) ?? [];
      if (trade.side === 'buy') {
        lots.push({ solCost: trade.solAmount, tokenAmount: trade.tokenAmount });
        lotsByMint.set(trade.mint, lots);
      } else {
        const { remainingLots, realizedPnlSol } = applyFifo(lots, trade.tokenAmount, trade.solAmount);
        lotsByMint.set(trade.mint, remainingLots);
        dayEntry.realizedPnlSol += realizedPnlSol;
      }

      dailyPnl.set(day, dayEntry);
    }

    for (const [date, { realizedPnlSol, tradeCount }] of dailyPnl) {
      await this.db
        .insert(pnlDaily)
        .values({ walletId, date, realizedPnlSol, tradeCount })
        .onConflictDoUpdate({
          target: [pnlDaily.walletId, pnlDaily.date],
          set: { realizedPnlSol, tradeCount },
        });
    }
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add apps/engine
git commit -m "engine: add PnL tracker with FIFO backfill"
```

---

### Task 9: `apps/engine` — REST API and WebSocket broadcast

**Files:**
- Create: `apps/engine/src/api/server.ts`
- Create: `apps/engine/src/api/ws.ts`
- Test: `apps/engine/src/api/server.test.ts`

**Interfaces:**
- Consumes: `Db`, `wallets`, `walletTrades`, `pnlDaily` from `@cryptonix/db`; `WalletMonitor` from Task 7; `PnlTracker` from Task 8; `AlertBus` from Task 7.
- Produces: `createServer(db: Db, walletMonitor: WalletMonitor, pnlTracker: PnlTracker, alertBus: AlertBus, solanaRpc: Pick<SolanaRpcClient, 'getBalanceSol'>): Express` (the `solanaRpc` param is added in Task 10) and `attachWebSocket(server: http.Server, alertBus: AlertBus): WebSocketServer`. Task 11 (`index.ts`) consumes both.

- [ ] **Step 1: Add test dependency**

```bash
pnpm --filter @cryptonix/engine add -D supertest @types/supertest
```

- [ ] **Step 2: Write the failing tests**

`apps/engine/src/api/server.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createDb } from '@cryptonix/db';
import { createServer } from './server';
import { WalletMonitor } from '../monitors/wallet-monitor';
import { PnlTracker } from '../monitors/pnl-tracker';
import { AlertBus } from './alert-bus';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cryptonix_test';
const db = createDb(TEST_DB_URL);

describe('engine API', () => {
  beforeEach(async () => {
    await db.execute('TRUNCATE alerts, pnl_daily, wallet_trades, wallets RESTART IDENTITY CASCADE');
  });

  function buildApp() {
    const helius = {
      createWalletWebhook: vi.fn().mockResolvedValue('wh_1'),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
    } as any;
    const alertBus = new AlertBus();
    const walletMonitor = new WalletMonitor(db, helius, alertBus);
    const pnlTracker = new PnlTracker(db, helius);
    return createServer(db, walletMonitor, pnlTracker, alertBus);
  }

  it('POST /wallets creates a wallet and GET /wallets lists it', async () => {
    const app = buildApp();

    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test', isMine: true });
    expect(createRes.status).toBe(201);
    expect(createRes.body.address).toBe('Addr1');

    const listRes = await request(app).get('/wallets');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
  });

  it('POST /wallets without an address returns 400', async () => {
    const app = buildApp();
    const res = await request(app).post('/wallets').send({ label: 'Test' });
    expect(res.status).toBe(400);
  });

  it('POST /webhooks/helius records a trade visible via GET /wallets/:id/trades', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    await request(app)
      .post('/webhooks/helius')
      .send([
        {
          signature: 'sig1',
          timestamp: 1_735_000_000,
          type: 'SWAP',
          tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'Addr1', mint: 'Mint1', tokenAmount: 1000 }],
          nativeTransfers: [{ fromUserAccount: 'Addr1', toUserAccount: 'Pool', amount: 2_000_000_000 }],
        },
      ]);

    const tradesRes = await request(app).get(`/wallets/${walletId}/trades`);
    expect(tradesRes.status).toBe(200);
    expect(tradesRes.body).toHaveLength(1);
    expect(tradesRes.body[0].side).toBe('buy');
  });

  it('GET /wallets/:id/pnl returns the daily PnL rows', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    const res = await request(app).get(`/wallets/${walletId}/pnl`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: FAIL — `server.ts` does not exist.

- [ ] **Step 4: Implement the server**

`apps/engine/src/api/server.ts`:
```ts
import express, { type Express } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '@cryptonix/db';
import { wallets, walletTrades, pnlDaily } from '@cryptonix/db';
import type { HeliusEnhancedTransaction } from '@cryptonix/core';
import type { WalletMonitor } from '../monitors/wallet-monitor';
import type { PnlTracker } from '../monitors/pnl-tracker';
import type { AlertBus } from './alert-bus';

export function createServer(db: Db, walletMonitor: WalletMonitor, pnlTracker: PnlTracker, _alertBus: AlertBus): Express {
  const app = express();
  app.use(express.json());

  app.get('/wallets', async (_req, res) => {
    res.json(await db.select().from(wallets));
  });

  app.post('/wallets', async (req, res) => {
    const { address, label, isMine } = req.body as { address?: string; label?: string; isMine?: boolean };
    if (!address || !label) {
      res.status(400).json({ error: 'address and label are required' });
      return;
    }
    const wallet = await walletMonitor.trackWallet(address, label, Boolean(isMine));
    res.status(201).json(wallet);

    pnlTracker.backfillWallet(wallet.id, wallet.address).catch((err) => {
      console.error(`pnl backfill failed for wallet ${wallet.id}`, err);
    });
  });

  app.get('/wallets/:id/trades', async (req, res) => {
    const walletId = Number(req.params.id);
    res.json(await db.select().from(walletTrades).where(eq(walletTrades.walletId, walletId)).orderBy(walletTrades.ts));
  });

  app.get('/wallets/:id/pnl', async (req, res) => {
    const walletId = Number(req.params.id);
    res.json(await db.select().from(pnlDaily).where(eq(pnlDaily.walletId, walletId)));
  });

  app.post('/webhooks/helius', async (req, res) => {
    const body = req.body as HeliusEnhancedTransaction | HeliusEnhancedTransaction[];
    await walletMonitor.handleWebhookPayload(Array.isArray(body) ? body : [body]);
    res.status(200).send();
  });

  return app;
}
```

- [ ] **Step 5: Implement WebSocket broadcast (no dedicated test — exercised end-to-end in Task 11's smoke test)**

`apps/engine/src/api/ws.ts`:
```ts
import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { AlertBus } from './alert-bus';

export function attachWebSocket(server: Server, alertBus: AlertBus): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  alertBus.on('alert', (alert) => {
    const message = JSON.stringify(alert);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  });

  return wss;
}
```

- [ ] **Step 6: Run and confirm the API tests pass**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: PASS, all 4 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/engine
git commit -m "engine: add REST API and WebSocket alert broadcast"
```

---

### Task 10: `apps/engine` — live SOL balance

**Files:**
- Create: `apps/engine/src/solana/balance.ts`
- Test: `apps/engine/src/solana/balance.test.ts`
- Modify: `apps/engine/src/api/server.ts` (add `GET /wallets/:id/balance`)
- Modify: `apps/engine/src/api/server.test.ts` (add a test for it)

**Interfaces:**
- Consumes: `wallets` from `@cryptonix/db`.
- Produces: `SolanaRpcClient` class with `getBalanceSol(address: string): Promise<number>`. Task 11's `index.ts` constructs and injects it into `createServer`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @cryptonix/engine add @solana/web3.js
```

- [ ] **Step 2: Write the failing test**

`apps/engine/src/solana/balance.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { Connection } from '@solana/web3.js';
import { SolanaRpcClient } from './balance';

describe('SolanaRpcClient', () => {
  it('converts a lamports balance to SOL', async () => {
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(2_500_000_000);
    const client = new SolanaRpcClient('https://example.com/rpc');

    const sol = await client.getBalanceSol('11111111111111111111111111111111');

    expect(sol).toBe(2.5);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
pnpm --filter @cryptonix/engine test
```
Expected: FAIL — `balance.ts` does not exist.

- [ ] **Step 4: Implement**

`apps/engine/src/solana/balance.ts`:
```ts
import { Connection, PublicKey } from '@solana/web3.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export class SolanaRpcClient {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async getBalanceSol(address: string): Promise<number> {
    const lamports = await this.connection.getBalance(new PublicKey(address));
    return lamports / LAMPORTS_PER_SOL;
  }
}
```

- [ ] **Step 5: Wire the balance route into the server**

Modify `apps/engine/src/api/server.ts` — add the import and change the function signature and body:

```ts
import type { SolanaRpcClient } from '../solana/balance';
```

Change the signature:
```ts
export function createServer(
  db: Db,
  walletMonitor: WalletMonitor,
  pnlTracker: PnlTracker,
  _alertBus: AlertBus,
  solanaRpc: Pick<SolanaRpcClient, 'getBalanceSol'>
): Express {
```

Add the route (anywhere among the other `/wallets/:id/...` routes):
```ts
  app.get('/wallets/:id/balance', async (req, res) => {
    const walletId = Number(req.params.id);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId));
    if (!wallet) {
      res.status(404).json({ error: 'wallet not found' });
      return;
    }
    const sol = await solanaRpc.getBalanceSol(wallet.address);
    res.json({ walletId, sol });
  });
```

- [ ] **Step 6: Update the server test's `buildApp` helper and add a test**

Modify `apps/engine/src/api/server.test.ts` — update `buildApp()`:
```ts
  function buildApp() {
    const helius = {
      createWalletWebhook: vi.fn().mockResolvedValue('wh_1'),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
    } as any;
    const alertBus = new AlertBus();
    const walletMonitor = new WalletMonitor(db, helius, alertBus);
    const pnlTracker = new PnlTracker(db, helius);
    const solanaRpc = { getBalanceSol: vi.fn().mockResolvedValue(4.2) };
    return createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc);
  }
```

Add a new test in the same `describe` block:
```ts
  it('GET /wallets/:id/balance returns the live SOL balance', async () => {
    const app = buildApp();
    const createRes = await request(app).post('/wallets').send({ address: 'Addr1', label: 'Test' });
    const walletId = createRes.body.id;

    const res = await request(app).get(`/wallets/${walletId}/balance`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ walletId, sol: 4.2 });
  });
```

- [ ] **Step 7: Run and confirm everything passes**

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/cryptonix_test pnpm --filter @cryptonix/engine test
```
Expected: PASS, including the new balance test.

- [ ] **Step 8: Commit**

```bash
git add apps/engine
git commit -m "engine: add live SOL balance endpoint"
```

---

### Task 11: `apps/engine` — entrypoint and end-to-end smoke test

**Files:**
- Create: `apps/engine/src/index.ts`
- Create: `apps/engine/scripts/smoke-test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6-10.
- Produces: the running engine process (`pnpm --filter @cryptonix/engine dev`), and a repeatable smoke-test script.

- [ ] **Step 1: Write the entrypoint**

`apps/engine/src/index.ts`:
```ts
import { createDb } from '@cryptonix/db';
import { env } from './env';
import { HeliusClient } from './helius/client';
import { SolanaRpcClient } from './solana/balance';
import { AlertBus } from './api/alert-bus';
import { WalletMonitor } from './monitors/wallet-monitor';
import { PnlTracker } from './monitors/pnl-tracker';
import { createServer } from './api/server';
import { attachWebSocket } from './api/ws';

async function main() {
  const db = createDb(env.databaseUrl);
  const helius = new HeliusClient({ apiKey: env.heliusApiKey, webhookBaseUrl: env.webhookBaseUrl });
  const solanaRpc = new SolanaRpcClient(`https://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`);
  const alertBus = new AlertBus();
  const walletMonitor = new WalletMonitor(db, helius, alertBus);
  const pnlTracker = new PnlTracker(db, helius);

  const app = createServer(db, walletMonitor, pnlTracker, alertBus, solanaRpc);
  const server = app.listen(env.port, () => {
    console.log(`cryptonix engine listening on :${env.port}`);
  });
  attachWebSocket(server, alertBus);
}

main().catch((err) => {
  console.error('engine failed to start', err);
  process.exit(1);
});
```

- [ ] **Step 2: Start the engine**

```bash
pnpm --filter @cryptonix/engine dev
```
Expected console output: `cryptonix engine listening on :8787`. Leave this running in its own terminal for the rest of this task.

- [ ] **Step 3: Write the smoke-test script**

This drives the running engine over HTTP and WebSocket exactly like a real client would — it's how you'll manually verify Cryptonix end-to-end from here on.

`apps/engine/scripts/smoke-test.ts`:
```ts
import WebSocket from 'ws';

const BASE = `http://localhost:${process.env.PORT ?? 8787}`;

async function main() {
  const ws = new WebSocket(`ws://localhost:${process.env.PORT ?? 8787}/ws`);
  const alertReceived = new Promise<any>((resolve) => {
    ws.on('message', (data) => resolve(JSON.parse(data.toString())));
  });
  await new Promise((resolve) => ws.on('open', resolve));

  console.log('1. Creating a wallet...');
  const createRes = await fetch(`${BASE}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: 'SmokeTestWallet111', label: 'Smoke Test Wallet', isMine: true }),
  });
  const wallet = await createRes.json();
  console.log('   Created:', wallet);

  console.log('2. Simulating an incoming Helius webhook (a buy)...');
  await fetch(`${BASE}/webhooks/helius`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      {
        signature: 'smoke-sig-1',
        timestamp: Math.floor(Date.now() / 1000),
        type: 'SWAP',
        tokenTransfers: [{ fromUserAccount: 'Pool', toUserAccount: 'SmokeTestWallet111', mint: 'SmokeMint1', tokenAmount: 1000 }],
        nativeTransfers: [{ fromUserAccount: 'SmokeTestWallet111', toUserAccount: 'Pool', amount: 2_000_000_000 }],
      },
    ]),
  });

  console.log('3. Waiting for the WebSocket alert...');
  const alert = await alertReceived;
  console.log('   Received alert:', alert);
  if (alert.payload.axiomLink !== 'https://axiom.trade/t/SmokeMint1') {
    throw new Error('Axiom link mismatch!');
  }

  console.log('4. Checking trade history via REST...');
  const tradesRes = await fetch(`${BASE}/wallets/${wallet.id}/trades`);
  const trades = await tradesRes.json();
  console.log('   Trades:', trades);
  if (trades.length !== 1) throw new Error('Expected exactly 1 trade');

  console.log('\nSmoke test passed.');
  ws.close();
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Run the smoke test against the running engine**

In a second terminal (leave `pnpm --filter @cryptonix/engine dev` running from Step 2):
```bash
pnpm --filter @cryptonix/engine exec tsx scripts/smoke-test.ts
```
Expected: prints each step, ending with `Smoke test passed.` This proves the full path — register a wallet (real Helius webhook call), receive a simulated buy, get an Axiom link, see it over the WebSocket, and read it back over REST — works end to end.

- [ ] **Step 5: Commit**

```bash
git add apps/engine
git commit -m "engine: add entrypoint and end-to-end smoke test"
```

---

## What you'll be able to see after this plan

Run `pnpm --filter @cryptonix/engine dev`, then either the smoke-test script or your own `curl` calls:
- `curl -X POST localhost:8787/wallets -H 'Content-Type: application/json' -d '{"address":"<a real Solana address>","label":"Me","isMine":true}'` — registers a real Helius webhook and starts a real historical backfill.
- `curl localhost:8787/wallets/<id>/trades` and `/pnl` — see real backfilled trade history and computed PnL once backfill finishes.
- Connect a WebSocket client to `ws://localhost:8787/ws` — see alerts the instant a tracked wallet trades (once you point `WEBHOOK_BASE_URL` at a public tunnel, e.g. `ngrok http 8787`, so Helius can actually reach your machine).

## Next plan

Once this is running and you've watched a real wallet flow through it, the next plan is **Discord bot v1** (spec §11, Phase 2): wire `apps/discord-bot` to this engine's WebSocket, post wallet-buy alerts as rich embeds, and add `/track wallet` and `/pnl` slash commands — the first piece you'll see fully "alive" outside a terminal.
