/**
 * @jest-environment node
 *
 * Integration test for migration v64 (BACKLOG-2791 — the persistent Needs-Review
 * queue + the delta watermark).
 *
 * v64 adds:
 *   - `pending_review_communications`, holding communications the sync FOUND for
 *     a deal but that are NOT linked until the user approves them;
 *   - two PARTIAL unique indexes that are the DB backstop for the sync's dedup
 *     predicate;
 *   - `transactions.last_pending_scan_at`, the ingestion watermark that keeps a
 *     scan running on EVERY transaction open from re-examining records that
 *     already lost (the BACKLOG-2620 non-convergence shape).
 *
 * Properties locked in here:
 *
 *  1. THE TABLE EXISTS AND ACCEPTS BOTH ROW SHAPES — proved by inserting an
 *     email row and a thread row and reading them back, not by reading DDL text
 *     (which would prove only that the statement was written down).
 *  2. THE XOR CHECK REJECTS BOTH DEGENERATE SHAPES — both-set and neither-set
 *     are asserted to throw. A CHECK nobody has seen reject anything is not a
 *     constraint, it is a comment.
 *  3. THE UNIQUE INDEXES ACTUALLY CONSTRAIN. A second row for the same
 *     (transaction, email) throws; the same for (transaction, thread); and a
 *     DIFFERENT transaction is still allowed, so the index is shown to be scoped
 *     rather than global. MEASURED by mutation: drop both indexes and a repeated
 *     sync leaves 4 rows where 2 belong.
 *
 *     NOTE, because the first draft of this file claimed otherwise and the
 *     mutation refused to go red: writing them PARTIAL is a size/intent choice,
 *     NOT a correctness one. SQLite treats every NULL as distinct, so a
 *     non-partial UNIQUE enforces exactly the same thing. The uniqueness is
 *     load-bearing; the WHERE clause is not.
 *  4. THE WATERMARK COLUMN EXISTS AND IS NULL ON EVERY PRE-EXISTING ROW — a
 *     migration that back-dated it would silently suppress the first scan on
 *     every existing deal.
 *  5. NOTHING ELSE ON `transactions` MOVES — the pre-existing column set is
 *     asserted unchanged with the new column appended.
 *  6. RE-RUNNING IS SAFE (idempotent), including the index creation.
 *  7. IT NO-OPS WITHOUT `transactions`, mirroring v48/v52..v63, so a minimal
 *     partial-schema fixture does not throw.
 *
 * Follows the v47..v63 convention: real better-sqlite3 driver, in-memory DB via
 * createMigrationHarness, seeded at 63 AND clipped to 64 so ONLY v64 runs.
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

const USER_ID = "user-v64-test";
const TXN_A = "txn-v64-a";
const TXN_B = "txn-v64-b";
const EMAIL_ID = "email-v64-alpha";

/** Post-v63 / pre-v64 shape. */
const PRE_V64_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT,
    sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    property_address TEXT,
    status TEXT,
    started_at DATETIME,
    closed_at DATETIME,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_transactions_user_id ON transactions(user_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** The column set `transactions` carries BEFORE v64, in order. */
const PRE_V64_TXN_COLUMNS = [
  "id",
  "user_id",
  "property_address",
  "status",
  "started_at",
  "closed_at",
  "metadata",
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

function insertPending(
  db: DatabaseType,
  id: string,
  txnId: string,
  emailId: string | null,
  threadId: string | null,
): void {
  db.prepare(
    `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id, thread_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, USER_ID, txnId, emailId, threadId);
}

describe("databaseService migration v64 (BACKLOG-2791 — pending review queue)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V64_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    for (const t of [TXN_A, TXN_B]) {
      harness.db
        .prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)")
        .run(t, USER_ID, "1 Test St");
    }
    harness.db
      .prepare("INSERT INTO emails (id, user_id, subject) VALUES (?, ?, ?)")
      .run(EMAIL_ID, USER_ID, "hello");
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

  /** Seed at v63 AND clip the chain at v64 so ONLY v64 runs. */
  async function runV64(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 63)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 64);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("advances schema_version to 64", async () => {
    await runV64();
    expect(schemaVersion(harness.db)).toBe(64);
  });

  it("creates pending_review_communications and accepts BOTH row shapes", async () => {
    await runV64();

    insertPending(harness.db, "p-email", TXN_A, EMAIL_ID, null);
    insertPending(harness.db, "p-thread", TXN_A, null, "thread-1");

    const rows = harness.db
      .prepare(
        "SELECT id, email_id, thread_id FROM pending_review_communications WHERE transaction_id = ? ORDER BY id",
      )
      .all() as Array<{ id: string; email_id: string | null; thread_id: string | null }>;

    expect(rows).toEqual([
      { id: "p-email", email_id: EMAIL_ID, thread_id: null },
      { id: "p-thread", email_id: null, thread_id: "thread-1" },
    ]);
  });

  it("the XOR CHECK rejects both-set and neither-set", async () => {
    await runV64();

    expect(() => insertPending(harness.db, "p-both", TXN_A, EMAIL_ID, "thread-1")).toThrow(
      /CHECK constraint failed/i,
    );
    expect(() => insertPending(harness.db, "p-neither", TXN_A, null, null)).toThrow(
      /CHECK constraint failed/i,
    );
  });

  it("the unique index blocks a duplicate (transaction, email) but not the same email on another deal", async () => {
    await runV64();

    insertPending(harness.db, "p-1", TXN_A, EMAIL_ID, null);

    // Same deal, same email → the dedup backstop fires.
    expect(() => insertPending(harness.db, "p-2", TXN_A, EMAIL_ID, null)).toThrow(
      /UNIQUE constraint failed/i,
    );

    // A DIFFERENT deal may legitimately queue the same email — proves the index
    // is scoped to the transaction rather than global.
    expect(() => insertPending(harness.db, "p-3", TXN_B, EMAIL_ID, null)).not.toThrow();
  });

  it("the unique index blocks a duplicate (transaction, thread) and scopes to the deal", async () => {
    await runV64();

    insertPending(harness.db, "t-1", TXN_A, null, "thread-x");
    expect(() => insertPending(harness.db, "t-2", TXN_A, null, "thread-x")).toThrow(
      /UNIQUE constraint failed/i,
    );
    expect(() => insertPending(harness.db, "t-3", TXN_B, null, "thread-x")).not.toThrow();
  });

  it("many text rows coexist despite email_id being NULL on all of them", async () => {
    await runV64();
    // Pins that the email index does not collapse the text rows (all of which
    // carry email_id NULL). This case passes under BOTH the partial and the
    // non-partial index — SQLite's distinct-NULL rule — so it is a regression
    // guard, not a discriminator between the two forms.
    for (let i = 0; i < 5; i++) {
      expect(() => insertPending(harness.db, `n-${i}`, TXN_A, null, `thread-${i}`)).not.toThrow();
    }
    const n = harness.db
      .prepare("SELECT COUNT(*) AS n FROM pending_review_communications")
      .get() as { n: number };
    expect(n.n).toBe(5);
  });

  it("adds transactions.last_pending_scan_at, NULL on every pre-existing row, with nothing else moved", async () => {
    await runV64();

    expect(columns(harness.db, "transactions")).toEqual([
      ...PRE_V64_TXN_COLUMNS,
      "last_pending_scan_at",
    ]);

    // A back-dated watermark would silently suppress the first scan on every
    // existing deal, so NULL is asserted rather than assumed.
    const rows = harness.db
      .prepare("SELECT id, last_pending_scan_at FROM transactions ORDER BY id")
      .all() as Array<{ id: string; last_pending_scan_at: string | null }>;
    expect(rows).toEqual([
      { id: TXN_A, last_pending_scan_at: null },
      { id: TXN_B, last_pending_scan_at: null },
    ]);
  });

  it("is idempotent — re-running changes nothing and does not throw", async () => {
    await runV64();
    insertPending(harness.db, "p-keep", TXN_A, EMAIL_ID, null);

    const before = columns(harness.db, "transactions");
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 63)").run();
    await expect(runV64()).resolves.not.toThrow();

    expect(columns(harness.db, "transactions")).toEqual(before);
    const kept = harness.db
      .prepare("SELECT COUNT(*) AS n FROM pending_review_communications")
      .get() as { n: number };
    expect(kept.n).toBe(1);
  });

  it("no-ops when `transactions` is absent (minimal partial-schema fixture)", async () => {
    harness.db.exec("DROP TABLE transactions;");
    await expect(runV64()).resolves.not.toThrow();
    expect(schemaVersion(harness.db)).toBe(64);
  });
});
