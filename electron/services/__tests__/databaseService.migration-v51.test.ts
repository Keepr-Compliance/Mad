/**
 * @jest-environment node
 *
 * Integration test for migration v51 (BACKLOG-2013 — export-freeze marker).
 *
 * v51 adds `transactions.first_exported_at` (the freeze boundary) and
 * best-effort backfills it for transactions that were ALREADY exported before
 * this migration (so pre-existing exported records are also protected).
 *
 * Follows the migration-v47..v49 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at schema_version=50 so ONLY v51 runs.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v49.test.ts
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER_ID = "user-v51-test";

/**
 * Minimal transactions table carrying the export-tracking columns v51's backfill
 * reads, plus schema_version. Deliberately does NOT declare first_exported_at —
 * v51 is what adds it. Seeded at v50 so only v51 runs.
 */
const PRE_V51_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    property_address TEXT NOT NULL,
    export_status TEXT DEFAULT 'not_exported',
    export_count INTEGER DEFAULT 0,
    last_exported_at DATETIME,
    last_exported_on DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

let txnCounter = 0;
function insertTxn(
  db: DatabaseType,
  opts: {
    exportStatus?: string;
    exportCount?: number;
    lastExportedAt?: string | null;
    lastExportedOn?: string | null;
    updatedAt?: string;
  },
): string {
  txnCounter += 1;
  const id = `txn-${txnCounter}`;
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, property_address, export_status, export_count, last_exported_at, last_exported_on, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    USER_ID,
    `${txnCounter} Main St`,
    opts.exportStatus ?? "not_exported",
    opts.exportCount ?? 0,
    opts.lastExportedAt ?? null,
    opts.lastExportedOn ?? null,
    opts.updatedAt ?? "2026-01-01T00:00:00.000Z",
  );
  return id;
}

function firstExportedAtOf(db: DatabaseType, id: string): string | null {
  const row = db
    .prepare("SELECT first_exported_at FROM transactions WHERE id = ?")
    .get(id) as { first_exported_at: string | null } | undefined;
  return row?.first_exported_at ?? null;
}

function columnExists(db: DatabaseType, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

describe("databaseService migration v51 (BACKLOG-2013 — export freeze marker)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V51_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  async function runV51(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 50)").run();
    await harness.service._runVersionedMigrations();
  }

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("adds the first_exported_at column and advances to v51", async () => {
    expect(columnExists(harness.db, "transactions", "first_exported_at")).toBe(false);

    await runV51();

    expect(columnExists(harness.db, "transactions", "first_exported_at")).toBe(true);
    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(51);
  });

  it("leaves a never-exported transaction NULL (still editable)", async () => {
    const id = insertTxn(harness.db, { exportStatus: "not_exported", exportCount: 0 });
    await runV51();
    expect(firstExportedAtOf(harness.db, id)).toBeNull();
  });

  it("backfills first_exported_at from last_exported_at when already exported", async () => {
    const id = insertTxn(harness.db, {
      exportStatus: "exported",
      exportCount: 1,
      lastExportedAt: "2025-05-05T12:00:00.000Z",
    });
    await runV51();
    expect(firstExportedAtOf(harness.db, id)).toBe("2025-05-05T12:00:00.000Z");
  });

  it("falls back to last_exported_on, then updated_at, for exported rows without last_exported_at", async () => {
    const onOnly = insertTxn(harness.db, {
      exportStatus: "exported",
      lastExportedOn: "2025-06-06T09:00:00.000Z",
    });
    const flagOnly = insertTxn(harness.db, {
      exportStatus: "exported",
      updatedAt: "2025-07-07T08:00:00.000Z",
    });

    await runV51();

    expect(firstExportedAtOf(harness.db, onOnly)).toBe("2025-06-06T09:00:00.000Z");
    // No export timestamps at all → fall back to updated_at so the row is still frozen.
    expect(firstExportedAtOf(harness.db, flagOnly)).toBe("2025-07-07T08:00:00.000Z");
  });

  it("treats a positive export_count as exported even when status is not 'exported'", async () => {
    const id = insertTxn(harness.db, {
      exportStatus: "re_export_needed",
      exportCount: 3,
      lastExportedAt: "2025-08-08T07:00:00.000Z",
    });
    await runV51();
    expect(firstExportedAtOf(harness.db, id)).toBe("2025-08-08T07:00:00.000Z");
  });

  it("is idempotent: a second run does not overwrite an existing first_exported_at", async () => {
    const id = insertTxn(harness.db, {
      exportStatus: "exported",
      lastExportedAt: "2025-05-05T12:00:00.000Z",
    });
    await runV51();
    const after1 = firstExportedAtOf(harness.db, id);

    // Re-invoke the migrate() body directly (past the runner's version gate).
    const migrations = harness.service.constructor.MIGRATIONS as Array<{
      version: number;
      migrate: (d: DatabaseType) => void;
    }>;
    const v51 = migrations.find((m) => m.version === 51);
    expect(v51).toBeDefined();
    expect(() => v51!.migrate(harness.db)).not.toThrow();

    expect(firstExportedAtOf(harness.db, id)).toBe(after1);
  });

  it("skips cleanly (no throw) when the transactions table is absent", async () => {
    await harness.cleanup();
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 50)").run();
    await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();
  });
});
