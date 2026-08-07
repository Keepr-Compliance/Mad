/**
 * @jest-environment node
 *
 * Integration test for migration v62 (BACKLOG-2513 — bulk-mail header
 * retention).
 *
 * v62 adds `emails.bulk_mail_headers`, where both fetch services park the
 * headers that identify automated mail: List-Unsubscribe,
 * List-Unsubscribe-Post, Precedence, Auto-Submitted and Authentication-Results.
 * They arrive from both providers on every message and were discarded at parse
 * time — only Message-ID was ever read.
 *
 * These are the negative-filter stage of the auto-detection design
 * (BACKLOG-2500 §4.2), the stage that exists because auto-detect manufactured
 * transactions from commercial newsletters and bank mail and had to be switched
 * off (BACKLOG-2499).
 *
 * Properties this file locks in:
 *
 *  1. THE COLUMN EXISTS AND HOLDS JSON. Asserted by writing and reading a value
 *     back through `json_extract`, not by reading the DDL text — which would
 *     prove only that the statement was written down.
 *  2. NOTHING ELSE ON THE TABLE MOVES. The pre-existing column set is asserted
 *     unchanged with the new column appended, so an ADD COLUMN cannot quietly
 *     disturb a table the sync writer binds 26 parameters into.
 *  3. NO INDEX IS CREATED. Snapshotted before and after and asserted equal.
 *     Nothing queries this column, and an index shipped without its query is
 *     dead weight on a hot table (the v56 ruling). A standalone CREATE INDEX in
 *     schema.sql would additionally throw "no such column" on every real
 *     upgrade — BACKLOG-2298/2300.
 *  4. RE-RUNNING IS SAFE. The guarded ADD COLUMN is idempotent.
 *  5. IT NO-OPS WITHOUT `emails`, mirroring v48/v52..v58, so a minimal
 *     partial-schema fixture does not throw.
 *  6. NO BACKFILL RUNS. There is nothing on disk to backfill FROM — the headers
 *     were never stored, which is the whole reason this item is urgent — so a
 *     migration that populated anything would be inventing data. Every
 *     pre-existing row is asserted NULL after the upgrade rather than assumed.
 *
 * The REAL prior-version-file upgrade proof lives in
 * databaseService.onDiskUpgrade.test.ts ("v62 adds emails.bulk_mail_headers on
 * the real file"). This suite runs in-memory and cannot make that claim: the
 * BACKLOG-2298/2300 failure class only appears when schema.sql is exec'd against
 * a real old database before the chain.
 *
 * Follows the v47..v58 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at 61 AND clipped to 62 so ONLY v62 runs.
 */

import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v58.test.ts
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

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

const USER_ID = "user-v62-test";

/**
 * Post-v61 / pre-v62 shape: `emails` carrying the columns BACKLOG-2512 writes
 * and NOT `bulk_mail_headers`. Two indexes so the index-delta assertion is a
 * real comparison rather than empty-set == empty-set.
 */
const PRE_V62_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    external_id TEXT,
    source TEXT,
    account_id TEXT,
    direction TEXT,
    subject TEXT,
    body_plain TEXT,
    body_html TEXT,
    sender TEXT,
    recipients TEXT,
    cc TEXT,
    bcc TEXT,
    thread_id TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    sent_at DATETIME,
    received_at DATETIME,
    has_attachments INTEGER DEFAULT 0,
    attachment_count INTEGER DEFAULT 0,
    message_id_header TEXT,
    content_hash TEXT,
    labels TEXT,
    classification TEXT,
    validated_at TEXT,
    ingest_source TEXT NOT NULL DEFAULT 'legacy',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_emails_user_id ON emails(user_id);
  CREATE INDEX idx_emails_thread_id ON emails(thread_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** The column set `emails` carries BEFORE v62, in order. */
const PRE_V62_COLUMNS = [
  "id",
  "user_id",
  "external_id",
  "source",
  "account_id",
  "direction",
  "subject",
  "body_plain",
  "body_html",
  "sender",
  "recipients",
  "cc",
  "bcc",
  "thread_id",
  "in_reply_to",
  "references_header",
  "sent_at",
  "received_at",
  "has_attachments",
  "attachment_count",
  "message_id_header",
  "content_hash",
  "labels",
  "classification",
  "validated_at",
  "ingest_source",
  "created_at",
  "updated_at",
];

const EMAIL_IDS = ["e-v62-alpha", "e-v62-beta"];

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

function indexNames(db: DatabaseType): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("databaseService migration v62 (BACKLOG-2513 — bulk_mail_headers)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V62_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    for (const id of EMAIL_IDS) {
      harness.db
        .prepare(
          "INSERT INTO emails (id, user_id, external_id, source, subject) VALUES (?, ?, ?, 'gmail', ?)",
        )
        .run(id, USER_ID, `ext-${id}`, `Subject ${id}`);
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

  /**
   * Seed at v61 AND clip the chain at v62 so ONLY v62 runs. Clipping rather
   * than relying on 61 being head-minus-one keeps every assertion here a
   * statement about v62 when v63 lands.
   */
  async function runV62(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 61)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 62);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("advances schema_version to 62", async () => {
    await runV62();
    expect(schemaVersion(harness.db)).toBe(62);
  });

  it("appends bulk_mail_headers and disturbs no existing column", async () => {
    expect(columns(harness.db, "emails")).toEqual(PRE_V62_COLUMNS);

    await runV62();

    // The sync writer binds 26 positional parameters into this table. An ADD
    // COLUMN that reordered or dropped anything would be silent until a real
    // sync wrote the wrong value into the wrong column.
    expect(columns(harness.db, "emails")).toEqual([
      ...PRE_V62_COLUMNS,
      "bulk_mail_headers",
    ]);
  });

  it("actually stores and reads back JSON — not merely a declared column", async () => {
    await runV62();

    harness.db
      .prepare("UPDATE emails SET bulk_mail_headers = ? WHERE id = ?")
      .run(
        JSON.stringify({
          list_unsubscribe: "<mailto:unsub@example.com>",
          precedence: "bulk",
          authentication_results: ["mx.example.com; dkim=pass"],
        }),
        EMAIL_IDS[0],
      );

    // Read it back the way the future BACKLOG-2500 scorer would, so the column
    // is proven usable for the `json_extract` path its comment promises.
    const got = harness.db
      .prepare(
        `SELECT json_extract(bulk_mail_headers, '$.precedence') AS p,
                json_extract(bulk_mail_headers, '$.authentication_results[0]') AS a
           FROM emails WHERE id = ?`,
      )
      .get(EMAIL_IDS[0]) as { p: string; a: string };

    expect(got.p).toBe("bulk");
    // The multi-hop array survives as an array, not as a flattened string.
    expect(got.a).toBe("mx.example.com; dkim=pass");
  });

  it("creates NO index — the index-name set is identical before and after", async () => {
    const before = indexNames(harness.db);
    expect(before.length).toBeGreaterThan(0);

    await runV62();

    expect(indexNames(harness.db)).toEqual(before);
  });

  it("runs NO backfill — every pre-existing row keeps bulk_mail_headers NULL", async () => {
    await runV62();

    // Nothing on disk could supply these values: they were never stored, which
    // is precisely why this item is urgent. A migration that populated anything
    // would be inventing data.
    const rows = harness.db
      .prepare("SELECT id, bulk_mail_headers FROM emails ORDER BY id")
      .all() as Array<{ id: string; bulk_mail_headers: string | null }>;

    // Exact id set, not a count — a count cannot tell a dropped row from a row
    // swapped for a different one.
    expect(rows.map((r) => r.id)).toEqual([...EMAIL_IDS].sort());
    expect(rows.map((r) => r.bulk_mail_headers)).toEqual(EMAIL_IDS.map(() => null));
  });

  it("is idempotent — re-running does not throw 'duplicate column name'", async () => {
    await runV62();
    const after = columns(harness.db, "emails");

    // The runner is not the only thing that can invoke a migration.
    await expect(runV62()).resolves.not.toThrow();
    expect(columns(harness.db, "emails")).toEqual(after);
  });

  it("no-ops without the emails table (minimal partial-schema fixture)", async () => {
    harness.db.exec("DROP TABLE emails");

    // Mirrors v48/v52..v58: a throw inside a migration is escalated by the
    // runner to a restore-from-backup dialog, which would be a catastrophic
    // response to an absent table.
    await expect(runV62()).resolves.not.toThrow();
    expect(schemaVersion(harness.db)).toBe(62);
  });
});
