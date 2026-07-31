/**
 * @jest-environment node
 *
 * REAL upgrade-path regression test — BACKLOG-2364 (tombstone columns, v56).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (the gap CI keeps missing — BACKLOG-2298, BACKLOG-2300)
 * ---------------------------------------------------------------------------
 * databaseService.runMigrations() runs in TWO steps, in this order:
 *
 *     currentDb.exec(schemaSql);            // 1. the CURRENT schema.sql
 *     await this._runVersionedMigrations()  // 2. the versioned migration chain
 *
 * On a FRESH install step 1 builds every table with every column, so a
 * standalone `CREATE INDEX ... ON t(new_col)` in schema.sql resolves. On a REAL
 * upgrade the table already exists, `CREATE TABLE IF NOT EXISTS` is a no-op, and
 * the new column only arrives in step 2 — so that same index throws
 * "no such column" in step 1, BEFORE the migration that would add it. The whole
 * upgrade then fails and auto-restores. This has shipped twice.
 *
 * No other test covers this ordering: the per-migration tests drive only step 2
 * against a hand-built fixture, and schema-parity seeds BOTH of its paths from
 * the current schema.sql (so the columns always already exist). This file seeds a
 * DB at the prior version (v55) and drives the REAL runMigrations() entry point.
 *
 * NOTE ON "on disk": createMigrationHarness uses `new Database(":memory:")` and
 * sets service.dbPath = null (migrationTestHarness.ts), matching the v31 and v51
 * precedents. The ORDERING semantics — the failure class that matters — are fully
 * exercised; the on-disk backup / auto-restore branch of runMigrations() is not,
 * and never has been by any test in this class.
 *
 * v56 (BACKLOG-2364) adds removed_at / removed_reason to contacts and
 * transaction_contacts and creates NO index, specifically so this trap cannot be
 * sprung. This file is the guard that keeps it that way.
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
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

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// The exact file runMigrations() reads on a real upgrade
// (databaseService.ts: path.join(__dirname, "../database/schema.sql")).
const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

const TOMBSTONE_IDENT = /removed_at|removed_reason/;

/**
 * Build a realistic pre-v56 on-disk schema from the CURRENT schema.sql by
 * removing anything that references the tombstone columns.
 *
 * DO NOT DELETE THIS AS "DEAD CODE" WHEN IT STRIPS NOTHING. Today schema.sql
 * declares neither column (v56 adds them on both install paths), so both filters
 * are no-ops — that is the healthy state, not evidence the function is useless.
 * It is a LIVE GUARD: if someone later hand-folds these columns, or a standalone
 * tombstone index, into schema.sql, this strips them from the FIXTURE while
 * runMigrations() still execs the REAL schema.sql — which is exactly what makes
 * the regression fail loudly here instead of shipping.
 *
 * Comments are stripped FIRST, before the statement split. Without that, a `--`
 * comment merely MENTIONING removed_at that happens to sit in the same
 * `;`-delimited chunk as a real, unrelated CREATE INDEX would silently delete
 * that legitimate index from the fixture — and the test would still pass,
 * because runMigrations() re-execs the real schema.sql and recreates it. That is
 * the same silent-weakening class this file exists to prevent.
 * (Caveat: the `--` strip would also cut inside a string literal containing
 * `--`; schema.sql contains no such literal today.)
 */
function buildPreV56SchemaSql(): string {
  const raw = fs
    .readFileSync(SCHEMA_SQL_PATH, "utf8")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

  // (1) STATEMENT level: drop any whole statement that both creates an index and
  //     mentions a tombstone column. Catches a reintroduction formatted across
  //     multiple lines, which a line filter would only partially strip — leaving
  //     a same-named NON-partial index that would make the real schema.sql's
  //     `CREATE INDEX IF NOT EXISTS` a no-op and the test pass while prod breaks.
  const kept = raw
    .split(";")
    .filter((s) => !(/create\s+index/i.test(s) && TOMBSTONE_IDENT.test(s)));

  // (2) LINE level: drop tombstone COLUMN declarations inside CREATE TABLE
  //     (a statement-level drop there would delete the whole table).
  return kept
    .join(";")
    .split("\n")
    .filter((line) => !TOMBSTONE_IDENT.test(line))
    .join("\n");
}

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function latestMigrationVersion(service: {
  constructor: { MIGRATIONS: Array<{ version: number }> };
}): number {
  const migrations = service.constructor.MIGRATIONS;
  return migrations[migrations.length - 1].version;
}

describe("databaseService runMigrations() — real v55 upgrade over current schema.sql (BACKLOG-2364)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    // Simulate the on-disk state of a user who last ran v55: the full pre-v56
    // schema, with contacts / transaction_contacts lacking the tombstone columns.
    harness.db.exec(buildPreV56SchemaSql());
    harness.db.prepare("UPDATE schema_version SET version = 55 WHERE id = 1").run();
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

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("precondition A: the seeded v55 DB has NEITHER tombstone column on EITHER table", () => {
    for (const table of ["contacts", "transaction_contacts"]) {
      const cols = columns(harness.db, table);
      expect(cols).not.toContain("removed_at");
      expect(cols).not.toContain("removed_reason");
    }
  });

  it("precondition B: the seeded v55 DB contains NO index referencing a tombstone column", () => {
    // Name-independent, so a same-named NON-partial index cannot slip through a
    // line-oriented strip. Stays correct after BACKLOG-2366 lands its index:
    // that index will live in a migration, so the PRE-migration fixture has none.
    const leaked = harness.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL " +
          "AND (sql LIKE '%removed_at%' OR sql LIKE '%removed_reason%')",
      )
      .all();
    expect(leaked).toEqual([]);
  });

  it("static guard: schema.sql declares NO index over a tombstone column (formatting-independent)", () => {
    // The permanent guard, asserted over the REAL file rather than the fixture,
    // so it is immune to how the regression happens to be formatted. A tombstone
    // index MUST be created inside a migration (after the ADD COLUMN), never as a
    // standalone statement in schema.sql, which is exec'd before the chain.
    const offenders = fs
      .readFileSync(SCHEMA_SQL_PATH, "utf8")
      .split("\n")
      .map((l) => l.replace(/--.*$/, "")) // strip line comments (see caveat above)
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => /create\s+index/i.test(s) && TOMBSTONE_IDENT.test(s));
    expect(offenders).toEqual([]);
  });

  it("runMigrations() execs the CURRENT schema.sql then the chain WITHOUT throwing", async () => {
    // The load-bearing assertion: this rejects the moment a standalone tombstone
    // index appears in schema.sql, because the pre-existing v55 tables have not
    // yet gained the column at exec(schema.sql) time.
    await expect(harness.service.runMigrations()).resolves.toBeUndefined();
  });

  it("after the upgrade: both columns exist on BOTH tables and schema_version is at head", async () => {
    await harness.service.runMigrations();

    for (const table of ["contacts", "transaction_contacts"]) {
      const cols = columns(harness.db, table);
      expect(cols).toContain("removed_at");
      expect(cols).toContain("removed_reason");
    }

    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    // Computed, not hard-coded, so this stays green at v57+.
    expect(row.version).toBe(latestMigrationVersion(harness.service));
  });

  it("after the upgrade: rows written BEFORE it survive as active, and a tombstone write round-trips", async () => {
    // Rows created on the v55 DB — the real old→new upgrade case.
    harness.db
      .prepare(
        `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
         VALUES ('user-1', 'user-1@example.com', 'google', 'oauth-1')`,
      )
      .run();
    harness.db
      .prepare(
        `INSERT INTO transactions (id, user_id, property_address)
         VALUES ('txn-1', 'user-1', '123 Main St')`,
      )
      .run();
    for (const [id, name] of [
      ["c-legacy-1", "Legacy One"],
      ["c-legacy-2", "Legacy Two"],
    ]) {
      harness.db
        .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, 'user-1', ?)")
        .run(id, name);
    }
    harness.db
      .prepare(
        `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role)
         VALUES ('tc-legacy-1', 'txn-1', 'c-legacy-1', 'buyer')`,
      )
      .run();

    await harness.service.runMigrations();

    // Every pre-existing row is still ACTIVE (removed_at NULL) — asserted by
    // exact id set, not by count.
    const activeContacts = (
      harness.db
        .prepare("SELECT id FROM contacts WHERE removed_at IS NULL ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(activeContacts).toEqual(["c-legacy-1", "c-legacy-2"]);

    const activeRoles = (
      harness.db
        .prepare("SELECT id FROM transaction_contacts WHERE removed_at IS NULL ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(activeRoles).toEqual(["tc-legacy-1"]);

    // A post-upgrade tombstone write on each table round-trips.
    harness.db
      .prepare("UPDATE contacts SET removed_at = datetime('now'), removed_reason = ? WHERE id = ?")
      .run("merged_into:c-legacy-1", "c-legacy-2");
    harness.db
      .prepare(
        "UPDATE transaction_contacts SET removed_at = datetime('now'), removed_reason = ? WHERE id = ?",
      )
      .run("wrong_deal", "tc-legacy-1");

    const contact = harness.db
      .prepare("SELECT removed_at, removed_reason FROM contacts WHERE id = 'c-legacy-2'")
      .get() as { removed_at: string | null; removed_reason: string | null };
    expect(contact.removed_at).not.toBeNull();
    expect(contact.removed_reason).toBe("merged_into:c-legacy-1");

    const role = harness.db
      .prepare(
        "SELECT removed_at, removed_reason FROM transaction_contacts WHERE id = 'tc-legacy-1'",
      )
      .get() as { removed_at: string | null; removed_reason: string | null };
    expect(role.removed_at).not.toBeNull();
    expect(role.removed_reason).toBe("wrong_deal");

    // ...and the remaining active set is exactly what is left.
    const stillActive = (
      harness.db
        .prepare("SELECT id FROM contacts WHERE removed_at IS NULL ORDER BY id")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(stillActive).toEqual(["c-legacy-1"]);
  });
});
