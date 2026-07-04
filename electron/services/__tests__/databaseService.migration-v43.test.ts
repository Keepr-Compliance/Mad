/**
 * @jest-environment node
 *
 * Integration test for migration v43 (BACKLOG-1768 — DB hardening S1).
 *
 * Verifies the communications + ignored_communications constraint migration:
 *   1. The table recreate preserves all valid rows and columns.
 *   2. The new CHECK rejects both-set (message AND email) and neither-set rows,
 *      and still ALLOWS thread-only rows (the live SMS thread-link path).
 *   3. Existing both-set garbage rows are dropped by the recreate.
 *   4. thread_id is backfilled for email rows before the recreate.
 *   5. The BEFORE INSERT trigger rejects an email link with no thread_id when the
 *      linked email HAS a thread_id, but allows it when the email has none (or '').
 *   6. FK cascades work: deleting an email or a transaction removes its
 *      communications rows (transaction_id is now CASCADE, was SET NULL).
 *   7. The tightened unique index rejects a duplicate (email_id, transaction_id) link.
 *   8. ignored_communications gains a real email_id FK; dangling refs are nulled and
 *      deleting an email cascades to its ignored_communications rows.
 *   9. The migration is idempotent (safe to re-run on the already-hardened shape).
 *  10. Fresh-install parity: a DB built from schema.sql matches the migrated shape.
 *
 * Uses the real better-sqlite3-multiple-ciphers driver via the shared migration
 * test harness (see migrationTestHarness.ts).
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same shape as databaseService.migration-v41.test.ts
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
  },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: mockFns,
    logService: mockFns,
  };
});

jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));

jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// Real driver, bypassing the Jest auto-mock (same technique as the harness).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const USER_ID = "user-v43-test";

/** The highest migration version = what schema_version should read post-run. */
function latestVersion(harness: MigrationHarness): number {
  const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
  return migrations[migrations.length - 1].version;
}

/** Insert an email row into the shared-fixture `emails` table. */
function insertEmail(harness: MigrationHarness, id: string, threadId: string | null): void {
  harness.db
    .prepare("INSERT INTO emails (id, user_id, thread_id) VALUES (?, ?, ?)")
    .run(id, USER_ID, threadId);
}

/** Insert a communications row using the pre-v43 (loose) column set. */
function insertComm(
  harness: MigrationHarness,
  row: {
    id: string;
    transaction_id?: string | null;
    message_id?: string | null;
    email_id?: string | null;
    thread_id?: string | null;
  },
): void {
  harness.db
    .prepare(
      `INSERT INTO communications (id, user_id, transaction_id, message_id, email_id, thread_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      USER_ID,
      row.transaction_id ?? null,
      row.message_id ?? null,
      row.email_id ?? null,
      row.thread_id ?? null,
    );
}

/**
 * Seed a realistic pre-v43 fixture at schema_version 42, then run the runner so
 * ONLY migration v43 executes. Parent rows are inserted first so the pre-v43
 * (foreign_keys=ON) inserts satisfy the existing FKs.
 */
function seedPreV43(harness: MigrationHarness): void {
  harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);

  // Emails: one with a thread, one without, one with '' (NULLIF edge case).
  insertEmail(harness, "e-thread", "T1");
  insertEmail(harness, "e-nothread", null);
  insertEmail(harness, "e-empty", "");

  // Message + transactions (FK targets).
  harness.db
    .prepare("INSERT INTO messages (id, user_id, thread_id) VALUES (?, ?, ?)")
    .run("m1", USER_ID, "MT1");
  harness.db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run("tx1", USER_ID);
  harness.db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run("tx2", USER_ID);
  harness.db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run("tx3", USER_ID);

  // Communications (pre-v43 rows):
  insertComm(harness, { id: "c-msg", message_id: "m1", transaction_id: "tx1" });
  insertComm(harness, { id: "c-email", email_id: "e-thread", thread_id: "T1", transaction_id: "tx1" });
  insertComm(harness, { id: "c-thread", thread_id: "MT1", transaction_id: "tx1" });
  insertComm(harness, { id: "c-email-legacy", email_id: "e-nothread", transaction_id: "tx2" });
  // Needs backfill: email has thread_id but the row does not yet.
  insertComm(harness, { id: "c-email-needsbackfill", email_id: "e-thread", transaction_id: "tx2" });
  // Garbage: BOTH message_id and email_id set (old CHECK allowed it) — must be dropped.
  insertComm(harness, { id: "c-both", message_id: "m1", email_id: "e-nothread", transaction_id: "tx2" });

  // ignored_communications (pre-v43, no email_id FK yet):
  harness.db
    .prepare(
      `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, email_subject)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("ig-valid", USER_ID, "tx1", "e-thread", "Valid");
  harness.db
    .prepare(
      `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, email_subject)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("ig-dangling", USER_ID, "tx1", "missing-email", "Dangling");
  harness.db
    .prepare(
      `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, email_subject)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run("ig-noemail", USER_ID, "tx1", null, "NoEmail");
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v43 (BACKLOG-1768)", () => {
  let harness: MigrationHarness;

  beforeEach(async () => {
    harness = createMigrationHarness({ seedV29Schema: true });
    harness.seedSchemaVersion(42);
    seedPreV43(harness);
    await harness.service._runVersionedMigrations();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("advances schema_version to the latest migration", () => {
    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(latestVersion(harness));
  });

  it("preserves all columns after the recreate", () => {
    const cols = (
      harness.db.prepare("PRAGMA table_info(communications)").all() as Array<{ name: string }>
    )
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "created_at",
        "email_id",
        "id",
        "link_confidence",
        "link_source",
        "linked_at",
        "message_id",
        "thread_id",
        "transaction_id",
        "user_id",
      ].sort(),
    );
  });

  it("preserves valid rows and drops both-set garbage rows", () => {
    const ids = (
      harness.db.prepare("SELECT id FROM communications ORDER BY id").all() as Array<{ id: string }>
    ).map((r) => r.id);
    // c-both dropped; the 5 valid rows survive.
    expect(ids).toEqual(["c-email", "c-email-legacy", "c-email-needsbackfill", "c-msg", "c-thread"]);
    expect(ids).not.toContain("c-both");
  });

  it("backfills thread_id for email rows before the recreate", () => {
    const row = harness.db
      .prepare("SELECT thread_id FROM communications WHERE id = ?")
      .get("c-email-needsbackfill") as { thread_id: string | null };
    expect(row.thread_id).toBe("T1");
  });

  it("CHECK rejects a both-set row (message AND email)", () => {
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, message_id, email_id) VALUES (?, ?, ?, ?)"
        )
        .run("bad-both", USER_ID, "m1", "e-nothread"),
    ).toThrow(/CHECK constraint/i);
  });

  it("CHECK rejects a neither-set row (links to nothing)", () => {
    expect(() =>
      harness.db
        .prepare("INSERT INTO communications (id, user_id) VALUES (?, ?)")
        .run("bad-none", USER_ID),
    ).toThrow(/CHECK constraint/i);
  });

  it("CHECK allows a thread-only row (SMS thread batch link)", () => {
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, thread_id, transaction_id) VALUES (?, ?, ?, ?)"
        )
        .run("ok-thread", USER_ID, "MT-new", "tx2"),
    ).not.toThrow();
  });

  it("trigger rejects an email link with no thread_id when the email HAS a thread_id", () => {
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, email_id, thread_id, transaction_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run("bad-nothread", USER_ID, "e-thread", null, "tx2"),
    ).toThrow(/thread_id required/i);
  });

  it("trigger ALLOWS an email link with no thread_id when the email has none", () => {
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, email_id, thread_id, transaction_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run("ok-legacy", USER_ID, "e-nothread", null, "tx1"),
    ).not.toThrow();
  });

  it("trigger treats an email thread_id of '' as no-thread (NULLIF guard)", () => {
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, email_id, thread_id, transaction_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run("ok-empty", USER_ID, "e-empty", null, "tx1"),
    ).not.toThrow();
  });

  it("trigger allows an email link that carries the thread_id", () => {
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, email_id, thread_id, transaction_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run("ok-withthread", USER_ID, "e-thread", "T1", "tx3"),
    ).not.toThrow();
  });

  it("cascade: deleting an email removes its communications rows", () => {
    const before = (
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE email_id = ?")
        .get("e-thread") as { n: number }
    ).n;
    expect(before).toBeGreaterThan(0);

    harness.db.prepare("DELETE FROM emails WHERE id = ?").run("e-thread");

    const after = (
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE email_id = ?")
        .get("e-thread") as { n: number }
    ).n;
    expect(after).toBe(0);
  });

  it("cascade: deleting a transaction removes its communications rows (CASCADE, was SET NULL)", () => {
    const before = (
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?")
        .get("tx1") as { n: number }
    ).n;
    expect(before).toBeGreaterThan(0);

    harness.db.prepare("DELETE FROM transactions WHERE id = ?").run("tx1");

    const rows = harness.db
      .prepare("SELECT id FROM communications WHERE transaction_id = ?")
      .all("tx1");
    expect(rows).toHaveLength(0);
    // Confirm CASCADE (rows deleted) rather than SET NULL (rows orphaned).
    const orphaned = (
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id IS NULL")
        .get() as { n: number }
    ).n;
    expect(orphaned).toBe(0);
  });

  it("unique index rejects a duplicate (email_id, transaction_id) link", () => {
    // c-email already occupies (e-thread, tx1); a second link must fail.
    expect(() =>
      harness.db
        .prepare(
          "INSERT INTO communications (id, user_id, email_id, thread_id, transaction_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run("dup-email", USER_ID, "e-thread", "T1", "tx1"),
    ).toThrow(/UNIQUE constraint/i);
  });

  it("nulls dangling ignored_communications.email_id and preserves the row", () => {
    const row = harness.db
      .prepare("SELECT email_id, email_subject FROM ignored_communications WHERE id = ?")
      .get("ig-dangling") as { email_id: string | null; email_subject: string };
    expect(row.email_id).toBeNull();
    expect(row.email_subject).toBe("Dangling"); // display cache preserved
  });

  it("cascade: deleting an email removes its ignored_communications rows", () => {
    expect(
      harness.db.prepare("SELECT id FROM ignored_communications WHERE id = ?").get("ig-valid"),
    ).toBeTruthy();

    harness.db.prepare("DELETE FROM emails WHERE id = ?").run("e-thread");

    expect(
      harness.db.prepare("SELECT id FROM ignored_communications WHERE id = ?").get("ig-valid"),
    ).toBeUndefined();
  });

  it("is idempotent — re-running v43 on the hardened shape preserves rows and does not error", async () => {
    const before = (
      harness.db.prepare("SELECT COUNT(*) AS n FROM communications").get() as { n: number }
    ).n;

    // Force v43 to run again.
    harness.db.prepare("UPDATE schema_version SET version = 42 WHERE id = 1").run();
    await expect(harness.service._runVersionedMigrations()).resolves.not.toThrow();

    const after = (
      harness.db.prepare("SELECT COUNT(*) AS n FROM communications").get() as { n: number }
    ).n;
    expect(after).toBe(before);
    // Trigger still present exactly once.
    const triggers = harness.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='communications_email_thread_required'",
      )
      .all();
    expect(triggers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fresh-install parity (BACKLOG-1770 pre-flight): a DB built from schema.sql
// must match the shape produced by the migration chain.
// ---------------------------------------------------------------------------

describe("migration v43 — fresh-install schema.sql parity (BACKLOG-1768 / 1770)", () => {
  /** Collapse whitespace + strip SQL line comments for structural comparison. */
  function normalizeSql(sql: string | null): string {
    if (!sql) return "";
    return sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, "")) // strip line comments
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\s*\(\s*/g, "(")
      .replace(/\s*\)\s*/g, ")")
      .replace(/\s*,\s*/g, ",")
      .trim()
      .toUpperCase();
  }

  function objectSql(db: DatabaseType, name: string): string | null {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  }

  let freshDb: DatabaseType;
  let migratedHarness: MigrationHarness;

  beforeEach(async () => {
    // (a) Fresh DB built directly from schema.sql.
    const schemaPath = path.join(__dirname, "..", "..", "database", "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    freshDb = new RealDatabase(":memory:") as DatabaseType;
    freshDb.pragma("foreign_keys = ON");
    freshDb.exec(schemaSql);

    // (b) Migrated DB via the runner (pre-v43 fixture -> v43).
    migratedHarness = createMigrationHarness({ seedV29Schema: true });
    migratedHarness.seedSchemaVersion(42);
    migratedHarness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    await migratedHarness.service._runVersionedMigrations();
  });

  afterEach(async () => {
    try {
      freshDb.close();
    } catch {
      /* already closed */
    }
    await migratedHarness.cleanup();
  });

  it("schema.sql builds without error and defines the hardened objects", () => {
    expect(objectSql(freshDb, "communications")).toBeTruthy();
    expect(objectSql(freshDb, "ignored_communications")).toBeTruthy();
    expect(objectSql(freshDb, "communications_email_thread_required")).toBeTruthy();
  });

  it("communications shape matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "communications"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "communications")),
    );
  });

  it("ignored_communications shape matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "ignored_communications"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "ignored_communications")),
    );
  });

  it("email-thread trigger matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "communications_email_thread_required"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "communications_email_thread_required")),
    );
  });

  it("tightened unique index matches between schema.sql and the migration", () => {
    expect(normalizeSql(objectSql(freshDb, "idx_comm_email_txn"))).toBe(
      normalizeSql(objectSql(migratedHarness.db, "idx_comm_email_txn")),
    );
    // And the predicate genuinely requires transaction_id.
    expect(normalizeSql(objectSql(freshDb, "idx_comm_email_txn"))).toContain(
      "TRANSACTION_ID IS NOT NULL",
    );
  });
});
