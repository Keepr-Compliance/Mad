/**
 * @jest-environment node
 *
 * Integration test for migration v66 (BACKLOG-2857 — derivation provenance).
 *
 * v66 adds:
 *   - `emails.derived_version INTEGER NOT NULL DEFAULT 0`;
 *   - `idx_emails_derived_version_stale`, the PARTIAL index serving the reprocess
 *     pass's `WHERE derived_version < CURRENT` scan.
 *
 * THE VACUITY TRAP THIS FILE EXISTS TO AVOID — read before editing the fixture.
 *
 * `derived_version` is now declared in `schema.sql`'s `CREATE TABLE emails` body
 * (the v46/v62 readability convention). So ANY fixture built by exec'ing
 * `schema.sql` already has the column, and an assertion of the form "after v66 the
 * column exists" passes WITHOUT v66 doing anything at all. That is precisely the
 * shape `databaseChainRehearsal` documents for v62's `bulk_mail_headers`, which
 * has to `ALTER TABLE emails DROP COLUMN` by hand to manufacture a pre-v62 shape.
 *
 * This file avoids it by hand-writing a PRE-v66 `emails` table that genuinely
 * lacks the column — following the v47..v65 convention — and by ASSERTING THE
 * ABSENCE before running the migration. If someone later rebuilds this fixture
 * from `schema.sql`, that pre-state assertion fails rather than going quietly
 * vacuous.
 *
 * Properties locked in here:
 *
 *  1. THE COLUMN DID NOT EXIST AND THEN DID — the pre-state is asserted, so the
 *     post-state means something.
 *  2. EVERY PRE-EXISTING ROW LANDS AT 0, NOT AT CURRENT. This is the single most
 *     important assertion in the file. A migration that back-filled these rows to
 *     CURRENT would declare every legacy email already repaired and permanently
 *     strand the truncated bodies the whole item exists to fix — while every other
 *     test here still passed.
 *  3. THE INDEX EXISTS, IS PARTIAL, AND ITS LITERAL MATCHES
 *     CURRENT_DERIVATION_VERSION. Drift between the two degrades the pass to a
 *     table scan silently, so it is asserted rather than trusted.
 *  4. THE INDEX IS ACTUALLY USED by the reprocess predicate — proved with
 *     EXPLAIN QUERY PLAN, not by reading the DDL back (which would prove only
 *     that the statement was written down).
 *  5. NOTHING ELSE ON `emails` MOVES — the pre-existing column set is asserted
 *     unchanged with the new column appended.
 *  6. RE-RUNNING IS SAFE (idempotent), including the index creation.
 *  7. IT NO-OPS WITHOUT `emails`, mirroring v48/v52..v65, so a minimal
 *     partial-schema fixture does not throw.
 *
 * Follows the v47..v65 convention: real better-sqlite3 driver, in-memory DB via
 * createMigrationHarness, seeded at 65 AND clipped to 66 so ONLY v66 runs.
 */

import type { Database as DatabaseType } from "better-sqlite3";

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

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import { CURRENT_DERIVATION_VERSION } from "../../utils/derivationVersion";

const USER_ID = "user-v66-test";
const INDEX_NAME = "idx_emails_derived_version_stale";

/**
 * Post-v65 / pre-v66 shape. HAND-WRITTEN, deliberately: it must NOT come from
 * schema.sql, which already declares `derived_version`. See the vacuity note.
 */
const PRE_V66_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT,
    body_plain TEXT,
    body_html TEXT,
    ingest_source TEXT NOT NULL DEFAULT 'legacy',
    validated_at TEXT,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_emails_user_id ON emails(user_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** The column set `emails` carries BEFORE v66, in order. */
const PRE_V66_EMAIL_COLUMNS = [
  "id",
  "user_id",
  "subject",
  "body_plain",
  "body_html",
  "ingest_source",
  "validated_at",
  "sent_at",
  "created_at",
  "updated_at",
];

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function schemaVersion(db: DatabaseType): number {
  return (
    db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
  ).version;
}

function indexSql(db: DatabaseType, name: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  return row?.sql;
}

describe("databaseService migration v66 (BACKLOG-2857 — derivation provenance)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V66_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    for (const id of ["e-legacy-1", "e-legacy-2", "e-legacy-3"]) {
      harness.db
        .prepare(
          "INSERT INTO emails (id, user_id, subject, body_plain, body_html) VALUES (?,?,?,?,?)",
        )
        .run(id, USER_ID, "hello", "truncated preview", "<p>full body</p>");
    }
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

  /** Seed at v65 AND clip the chain at v66 so ONLY v66 runs. */
  async function runV66(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 65)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 66);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("advances schema_version to 66", async () => {
    await runV66();
    expect(schemaVersion(harness.db)).toBe(66);
  });

  // ── PROPERTY 1 ───────────────────────────────────────────────────────────────
  it("adds derived_version to a table that genuinely lacked it", async () => {
    // THE PRE-STATE ASSERTION. If a future edit rebuilds this fixture from
    // schema.sql (which now declares the column), this line fails instead of the
    // whole suite going quietly vacuous.
    expect(columns(harness.db, "emails")).not.toContain("derived_version");

    await runV66();

    expect(columns(harness.db, "emails")).toContain("derived_version");
  });

  // ── PROPERTY 2 — the one that matters most ───────────────────────────────────
  it("leaves EVERY pre-existing row at 0, never at CURRENT", async () => {
    await runV66();

    const rows = harness.db
      .prepare("SELECT id, derived_version FROM emails ORDER BY id")
      .all() as Array<{ id: string; derived_version: number }>;

    // Asserted as an exact id -> version map, not as a count of zeroes.
    expect(Object.fromEntries(rows.map((r) => [r.id, r.derived_version]))).toEqual({
      "e-legacy-1": 0,
      "e-legacy-2": 0,
      "e-legacy-3": 0,
    });

    // Stated explicitly because it is the failure that would be invisible: a
    // backfill to CURRENT here marks every legacy email repaired and strands the
    // truncated bodies forever.
    expect(rows.every((r) => r.derived_version !== CURRENT_DERIVATION_VERSION)).toBe(true);
  });

  it("makes the column NOT NULL with a 0 default for rows inserted afterwards", async () => {
    await runV66();

    harness.db
      .prepare("INSERT INTO emails (id, user_id, subject) VALUES ('e-new', ?, 'x')")
      .run(USER_ID);

    const row = harness.db
      .prepare("SELECT derived_version FROM emails WHERE id = 'e-new'")
      .get() as { derived_version: number };
    expect(row.derived_version).toBe(0);

    expect(() =>
      harness.db
        .prepare("INSERT INTO emails (id, user_id, derived_version) VALUES ('e-null', ?, NULL)")
        .run(USER_ID),
    ).toThrow(/NOT NULL/i);
  });

  // ── PROPERTY 3 ───────────────────────────────────────────────────────────────
  it("creates a PARTIAL index whose literal matches CURRENT_DERIVATION_VERSION", async () => {
    expect(indexSql(harness.db, INDEX_NAME)).toBeUndefined();

    await runV66();

    const sql = indexSql(harness.db, INDEX_NAME);
    expect(sql).toBeDefined();
    expect(sql).toMatch(/WHERE\s+derived_version\s*<\s*(\d+)/i);

    // Drift between the index literal and the constant degrades the reprocess
    // scan to a table scan without changing any result, so nothing else would
    // catch it.
    const literal = Number(/WHERE\s+derived_version\s*<\s*(\d+)/i.exec(sql as string)?.[1]);
    expect(literal).toBe(CURRENT_DERIVATION_VERSION);
  });

  // ── PROPERTY 4 ───────────────────────────────────────────────────────────────
  it("the reprocess predicate actually uses the index", async () => {
    await runV66();

    const plan = harness.db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT id FROM emails WHERE derived_version < ${CURRENT_DERIVATION_VERSION}`,
      )
      .all() as Array<{ detail: string }>;

    // Proved by the planner, not by reading the DDL back.
    expect(plan.map((p) => p.detail).join(" ")).toContain(INDEX_NAME);
  });

  // ── PROPERTY 5 ───────────────────────────────────────────────────────────────
  it("appends the column and moves nothing else on emails", async () => {
    await runV66();

    expect(columns(harness.db, "emails")).toEqual([
      ...PRE_V66_EMAIL_COLUMNS,
      "derived_version",
    ]);
  });

  // ── PROPERTY 6 ───────────────────────────────────────────────────────────────
  it("is idempotent, including the index", async () => {
    await runV66();

    const firstSql = indexSql(harness.db, INDEX_NAME);
    const firstCols = columns(harness.db, "emails");

    // Re-running from 65 replays v66 against a database that already has both.
    await expect(runV66()).resolves.not.toThrow();

    expect(columns(harness.db, "emails")).toEqual(firstCols);
    expect(indexSql(harness.db, INDEX_NAME)).toBe(firstSql);
    expect(schemaVersion(harness.db)).toBe(66);
  });

  // ── PROPERTY 7 ───────────────────────────────────────────────────────────────
  it("no-ops when emails is absent", async () => {
    harness.db.exec("DROP TABLE emails");

    await expect(runV66()).resolves.not.toThrow();
    expect(schemaVersion(harness.db)).toBe(66);
    expect(indexSql(harness.db, INDEX_NAME)).toBeUndefined();
  });
});
