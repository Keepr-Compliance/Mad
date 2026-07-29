/**
 * @jest-environment node
 *
 * Integration test for migration v55 (BACKLOG-2319 — Needs-review match_reason).
 *
 * v55 adds a nullable `match_reason` column to BOTH `communications` and
 * `ignored_communications` so the Emails tab can split ambiguous contact-only
 * links ("Needs review") from confidently linked ones. It adds NO index — see
 * the BACKLOG-2298 incident: a schema.sql top-level `CREATE INDEX ... ON
 * table(new_col)` runs BEFORE the versioned migrations on a real old→new upgrade
 * and fails with "no such column". This test is the required REAL upgrade-path
 * test: it starts from a prior-version (v54) on-disk DB with pre-existing rows
 * and drives the actual migration runner.
 *
 * Follows the migration-v47..v54 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at schema_version=54 so ONLY v55 runs.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v54.test.ts
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

const USER_ID = "user-v55-test";

/**
 * Post-v54 / pre-v55 shape: communications + ignored_communications WITHOUT the
 * match_reason column (v55 is what adds it). Minimal columns — enough to insert
 * a realistic row and prove it survives the ALTER. Seeded at v54 so only v55 runs.
 */
const PRE_V55_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE communications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    transaction_id TEXT,
    message_id TEXT,
    email_id TEXT,
    thread_id TEXT,
    link_source TEXT,
    link_confidence REAL,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE ignored_communications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    email_id TEXT,
    thread_id TEXT,
    reason TEXT,
    ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function columnExists(db: DatabaseType, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function schemaVersion(db: DatabaseType): number {
  return (
    db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
  ).version;
}

describe("databaseService migration v55 (BACKLOG-2319 — match_reason)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V55_FIXTURE);
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

  /** Seed at v54 (so ONLY v55 runs) then drive the real migration runner. */
  async function runV55(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 54)").run();
    await harness.service._runVersionedMigrations();
  }

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("adds match_reason to communications AND ignored_communications, advancing to v55", async () => {
    expect(columnExists(harness.db, "communications", "match_reason")).toBe(false);
    expect(columnExists(harness.db, "ignored_communications", "match_reason")).toBe(false);

    await runV55();

    expect(columnExists(harness.db, "communications", "match_reason")).toBe(true);
    expect(columnExists(harness.db, "ignored_communications", "match_reason")).toBe(true);
    expect(schemaVersion(harness.db)).toBe(55);
  });

  it("appends match_reason as the LAST column (order invariant vs schema.sql — BACKLOG-2298)", async () => {
    // ALTER TABLE ADD COLUMN appends at the end. schema.sql MUST declare
    // match_reason last (before the FK/CHECK block) so a fresh install and an
    // upgraded install produce the same column order — the exact fresh-vs-migrated
    // parity the migration-v43 guard enforces.
    await runV55();
    const lastCol = (table: string): string => {
      const cols = harness.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols[cols.length - 1].name;
    };
    expect(lastCol("communications")).toBe("match_reason");
    expect(lastCol("ignored_communications")).toBe("match_reason");
  });

  it("leaves a pre-existing link row intact with match_reason NULL (safe default on upgrade)", async () => {
    // A link created before v55 — the real old→new upgrade case (BACKLOG-2298).
    harness.db
      .prepare(
        `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source, link_confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("comm-legacy", USER_ID, "txn-1", "email-1", "thread-1", "auto", 0.85);
    harness.db
      .prepare(
        `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, thread_id, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("ig-legacy", USER_ID, "txn-1", "email-2", "thread-2", "Manually unlinked by user");

    await runV55();

    const comm = harness.db
      .prepare("SELECT id, email_id, match_reason FROM communications WHERE id = ?")
      .get("comm-legacy") as { id: string; email_id: string; match_reason: string | null };
    expect(comm.id).toBe("comm-legacy");
    expect(comm.email_id).toBe("email-1");
    // NULL = legacy → the renderer treats it as address_found (Linked); nothing
    // an already-linked user sees reclassifies on upgrade.
    expect(comm.match_reason).toBeNull();

    const ig = harness.db
      .prepare("SELECT id, match_reason FROM ignored_communications WHERE id = ?")
      .get("ig-legacy") as { id: string; match_reason: string | null };
    expect(ig.id).toBe("ig-legacy");
    expect(ig.match_reason).toBeNull();
  });

  it("accepts and round-trips the four match_reason values after upgrade", async () => {
    await runV55();

    const values = ["address_found", "address_missing", "manual", "user_confirmed"];
    for (const [i, mr] of values.entries()) {
      harness.db
        .prepare(
          `INSERT INTO communications (id, user_id, transaction_id, email_id, match_reason)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(`comm-${i}`, USER_ID, "txn-1", `email-${i}`, mr);
    }

    const rows = harness.db
      .prepare("SELECT email_id, match_reason FROM communications ORDER BY email_id")
      .all() as Array<{ email_id: string; match_reason: string }>;
    // Assert identity: each email carries exactly the reason it was written with.
    const byEmail = new Map(rows.map((r) => [r.email_id, r.match_reason]));
    expect(byEmail.get("email-0")).toBe("address_found");
    expect(byEmail.get("email-1")).toBe("address_missing");
    expect(byEmail.get("email-2")).toBe("manual");
    expect(byEmail.get("email-3")).toBe("user_confirmed");
  });

  it("is idempotent: a second run does not throw and keeps the column + version", async () => {
    await runV55();
    // Re-run the whole runner: version is already 55, so v55 is not re-selected,
    // and even a direct re-invoke of the guarded ADD COLUMN must not throw.
    await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();
    expect(columnExists(harness.db, "communications", "match_reason")).toBe(true);
    expect(schemaVersion(harness.db)).toBe(55);

    const migrations = harness.service.constructor.MIGRATIONS as Array<{
      version: number;
      migrate: (d: DatabaseType) => void;
    }>;
    const v55 = migrations.find((m) => m.version === 55);
    expect(v55).toBeDefined();
    // Direct re-invoke on a DB that already has the column (mirrors a fresh
    // schema.sql install) — the existence guard makes it a clean no-op.
    expect(() => v55!.migrate(harness.db)).not.toThrow();
  });

  it("skips gracefully when a target table is absent (partial-schema DB)", async () => {
    harness.db.exec("DROP TABLE ignored_communications");
    await expect(runV55()).resolves.toBeUndefined();
    // communications still gains the column; the missing table is skipped, not fatal.
    expect(columnExists(harness.db, "communications", "match_reason")).toBe(true);
    expect(schemaVersion(harness.db)).toBe(55);
  });
});
