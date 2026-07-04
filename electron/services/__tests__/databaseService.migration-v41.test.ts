/**
 * @jest-environment node
 *
 * Integration test for migration v41 (BACKLOG-1722).
 *
 * Verifies:
 *   1. The migration runner adds the `email_participants` junction table
 *      with the 3 expected indexes, plus the
 *      `email_participants_backfill_errors` table.
 *   2. The chunked backfill parses denormalized `sender`/`recipients`/`cc`/`bcc`
 *      from existing `emails` rows and inserts one row per address.
 *   3. The backfill is idempotent: running v41 twice yields no duplicate rows
 *      (PRIMARY KEY (email_id, role, position) + INSERT OR IGNORE).
 *   4. The backfill records parse failures into the errors table (<0.1% G6).
 *   5. Performance: 100 synthetic rows backfill in <500 ms.
 *   6. `lisa@x.com` and `alisa@x.com` are stored as DISTINCT rows (G2
 *      near-collision safety).
 *
 * Uses the real better-sqlite3-multiple-ciphers driver via the shared
 * migration test harness (see migrationTestHarness.ts).
 */

import path from "path";
import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// MOCKS — same shape as databaseService.migration-v40.test.ts
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
import { computeParticipantHash } from "../../utils/emailAddress";

// Sanity check that we are using the real driver
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
);

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const USER_ID = "user-v41-test";

/**
 * Seed an `emails` table when not already present in the v29 fixture subset.
 *
 * The shared harness (migrationTestHarness.ts) now includes a minimal `emails`
 * table so that migrations v41 and v42 (which both reference it) succeed when
 * the runner starts from v39. When that shared fixture is used the table
 * already exists, so this function uses CREATE TABLE IF NOT EXISTS to be
 * idempotent. The shared fixture includes all columns that this test's
 * `insertSeedEmail` and the v41 backfill SELECT need.
 */
function seedEmailsTable(harness: MigrationHarness): void {
  harness.db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );
  `);
}

interface SeedEmail {
  id: string;
  sender?: string | null;
  recipients?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string;
}

function insertSeedEmail(harness: MigrationHarness, e: SeedEmail): void {
  harness.db
    .prepare(
      `INSERT INTO emails (id, user_id, sender, recipients, cc, bcc, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id,
      USER_ID,
      e.sender ?? null,
      e.recipients ?? null,
      e.cc ?? null,
      e.bcc ?? null,
      e.subject ?? null
    );
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v41 (BACKLOG-1722)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: true });
    harness.seedSchemaVersion(40);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    seedEmailsTable(harness);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("sanity: real driver is wired", () => {
    expect(Array.isArray(harness.db.pragma("user_version"))).toBe(true);
  });

  it("creates email_participants table with PK (email_id, role, position)", async () => {
    await harness.service._runVersionedMigrations();

    const tableInfo = harness.db
      .prepare("PRAGMA table_info(email_participants)")
      .all() as Array<{ name: string; pk: number }>;

    const names = tableInfo.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "display_name",
        "email_address",
        "email_id",
        "participant_hash",
        "position",
        "resolved_contact_id",
        "role",
      ].sort()
    );

    // PK columns have pk>0 in PRAGMA table_info
    const pkCols = tableInfo.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(["email_id", "position", "role"].sort());
  });

  it("creates the 3 expected indexes on email_participants", async () => {
    await harness.service._runVersionedMigrations();

    const idxs = harness.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='email_participants' AND name LIKE 'idx_email_participants_%'"
      )
      .all() as Array<{ name: string }>;

    const names = idxs.map((i) => i.name).sort();
    expect(names).toEqual([
      "idx_email_participants_address_role",
      "idx_email_participants_email_address",
      "idx_email_participants_email_id",
    ]);
  });

  it("creates the backfill errors table", async () => {
    await harness.service._runVersionedMigrations();
    const cols = harness.db
      .prepare("PRAGMA table_info(email_participants_backfill_errors)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["created_at", "email_id", "id", "raw_value", "reason", "role"].sort()
    );
  });

  it("backfills one row per address from a simple message", async () => {
    insertSeedEmail(harness, {
      id: "e1",
      sender: "Alice <alice@x.com>",
      recipients: "bob@y.com, carol@z.com",
      cc: '"Last, First" <dan@x.com>',
      bcc: null,
    });

    await harness.service._runVersionedMigrations();

    const rows = harness.db
      .prepare(
        "SELECT email_id, role, position, email_address, display_name FROM email_participants WHERE email_id = ? ORDER BY role, position"
      )
      .all("e1") as Array<{
        email_id: string;
        role: string;
        position: number;
        email_address: string;
        display_name: string | null;
      }>;

    expect(rows).toEqual([
      { email_id: "e1", role: "cc", position: 0, email_address: "dan@x.com", display_name: "Last, First" },
      { email_id: "e1", role: "from", position: 0, email_address: "alice@x.com", display_name: "Alice" },
      { email_id: "e1", role: "to", position: 0, email_address: "bob@y.com", display_name: null },
      { email_id: "e1", role: "to", position: 1, email_address: "carol@z.com", display_name: null },
    ]);
  });

  it("treats lisa@x.com and alisa@x.com as DISTINCT (G2)", async () => {
    insertSeedEmail(harness, {
      id: "e1",
      sender: "lisa@x.com",
      recipients: "alisa@x.com",
    });

    await harness.service._runVersionedMigrations();

    const rows = harness.db
      .prepare("SELECT email_address, role FROM email_participants WHERE email_id = ? ORDER BY email_address")
      .all("e1") as Array<{ email_address: string; role: string }>;

    expect(rows).toEqual([
      { email_address: "alisa@x.com", role: "to" },
      { email_address: "lisa@x.com", role: "from" },
    ]);
  });

  it("records parse failures into the errors table", async () => {
    insertSeedEmail(harness, {
      id: "e1",
      sender: "not-an-email", // missing '@'
      recipients: "good@x.com, also-bad",
    });

    await harness.service._runVersionedMigrations();

    const errs = harness.db
      .prepare(
        "SELECT email_id, role, raw_value, reason FROM email_participants_backfill_errors WHERE email_id = ? ORDER BY raw_value"
      )
      .all("e1") as Array<{ email_id: string; role: string; raw_value: string; reason: string }>;

    expect(errs.length).toBe(2);
    expect(errs.find((e) => e.raw_value === "not-an-email")?.role).toBe("from");
    expect(errs.find((e) => e.raw_value === "also-bad")?.role).toBe("to");

    // good@x.com should still be inserted into participants
    const okRows = harness.db
      .prepare("SELECT email_address FROM email_participants WHERE email_id = ?")
      .all("e1") as Array<{ email_address: string }>;
    expect(okRows).toEqual([{ email_address: "good@x.com" }]);
  });

  it("is idempotent: second run inserts no duplicate participant rows", async () => {
    insertSeedEmail(harness, {
      id: "e1",
      sender: "alice@x.com",
      recipients: "bob@y.com, carol@z.com",
    });

    await harness.service._runVersionedMigrations();

    const countBefore = (
      harness.db.prepare("SELECT COUNT(*) as c FROM email_participants").get() as { c: number }
    ).c;
    expect(countBefore).toBe(3);

    // Re-run the migration list by manually re-invoking the v41 migrate fn.
    // The runner won't re-run a completed migration, so we exercise the
    // INSERT OR IGNORE path directly to confirm PK semantics.
    const v41 = (
      harness.service.constructor.MIGRATIONS as Array<{
        version: number;
        migrate: (d: unknown) => void;
      }>
    ).find((m) => m.version === 41)!;
    v41.migrate(harness.db);

    const countAfter = (
      harness.db.prepare("SELECT COUNT(*) as c FROM email_participants").get() as { c: number }
    ).c;
    expect(countAfter).toBe(3);
  });

  it("backfills 100 synthetic rows in <500ms (G6 perf budget proxy)", async () => {
    const insert = harness.db.prepare(
      `INSERT INTO emails (id, user_id, sender, recipients, cc, bcc)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 100; i++) {
      insert.run(
        `email-${i}`,
        USER_ID,
        `sender${i}@x.com`,
        `to1-${i}@y.com, to2-${i}@y.com`,
        `cc-${i}@z.com`,
        null
      );
    }

    const start = Date.now();
    await harness.service._runVersionedMigrations();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);

    const count = (
      harness.db.prepare("SELECT COUNT(*) as c FROM email_participants").get() as { c: number }
    ).c;
    // 100 senders + 200 to + 100 cc = 400
    expect(count).toBe(400);
  });

  it("backfills participant_hash NOT NULL on every row + correct value (BACKLOG-1722 bonus design)", async () => {
    insertSeedEmail(harness, {
      id: "e-hash",
      sender: "Alice <alice@x.com>",
      recipients: "bob@y.com, carol@z.com",
      cc: '"Last, First" <dan@x.com>',
      bcc: null,
    });

    await harness.service._runVersionedMigrations();

    // 1) Every backfilled row has a non-null participant_hash.
    const nullCount = (
      harness.db
        .prepare("SELECT COUNT(*) as c FROM email_participants WHERE participant_hash IS NULL")
        .get() as { c: number }
    ).c;
    expect(nullCount).toBe(0);

    const totalCount = (
      harness.db.prepare("SELECT COUNT(*) as c FROM email_participants").get() as { c: number }
    ).c;
    expect(totalCount).toBe(4); // 1 from + 2 to + 1 cc

    // 2) For at least one row, the hash matches computeParticipantHash(...).
    const aliceRow = harness.db
      .prepare(
        "SELECT email_id, role, position, email_address, participant_hash FROM email_participants WHERE email_id = ? AND role = 'from' AND position = 0"
      )
      .get("e-hash") as {
        email_id: string;
        role: "from" | "to" | "cc" | "bcc";
        position: number;
        email_address: string;
        participant_hash: string;
      };
    expect(aliceRow.participant_hash).toBe(
      computeParticipantHash("e-hash", "from", 0, "alice@x.com")
    );
  });

  it("adds nullable `classification` column to emails (BACKLOG-1722 bonus design)", async () => {
    await harness.service._runVersionedMigrations();

    const cols = harness.db
      .prepare("PRAGMA table_info(emails)")
      .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const classCol = cols.find((c) => c.name === "classification");
    expect(classCol).toBeDefined();
    expect(classCol!.notnull).toBe(0); // nullable
    expect(classCol!.dflt_value).toBeNull(); // no default
  });

  it("advances schema_version to the latest migration", async () => {
    // Use the MIGRATIONS list to derive the expected version so the assertion
    // remains valid when future migrations are added (same pattern as the v40
    // suite). The v41 suite starts from v40, so the runner applies v41 and any
    // subsequent migrations that have since landed (currently v42).
    await harness.service._runVersionedMigrations();
    const migrations = harness.service.constructor.MIGRATIONS as Array<{
      version: number;
    }>;
    const latest = migrations[migrations.length - 1].version;
    const v = (
      harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(v).toBe(latest);
  });

  it("keyset backfill produces same participant set as sequential scan (I2)", async () => {
    // 600 rows — two full chunks + one partial — forces multiple keyset iterations.
    const insert = harness.db.prepare(
      `INSERT INTO emails (id, user_id, sender, recipients)
       VALUES (?, ?, ?, ?)`
    );
    for (let i = 0; i < 600; i++) {
      // Pad to ensure consistent TEXT sort order: email-000 … email-599
      const idStr = String(i).padStart(3, "0");
      insert.run(`email-${idStr}`, USER_ID, `s${idStr}@x.com`, `r${idStr}@y.com`);
    }

    await harness.service._runVersionedMigrations();

    // 600 senders + 600 recipients = 1200 rows
    const count = (
      harness.db.prepare("SELECT COUNT(*) as c FROM email_participants").get() as { c: number }
    ).c;
    expect(count).toBe(1200);

    // Verify no email is missing: every email-NNN appears in participants
    const emailIds = (
      harness.db
        .prepare("SELECT DISTINCT email_id FROM email_participants ORDER BY email_id")
        .all() as Array<{ email_id: string }>
    ).map((r) => r.email_id);
    expect(emailIds).toHaveLength(600);
    expect(emailIds[0]).toBe("email-000");
    expect(emailIds[599]).toBe("email-599");
  });

  it("error-table INSERT OR IGNORE: duplicate errors on manual re-run do not add rows (M1)", async () => {
    insertSeedEmail(harness, {
      id: "e-err",
      sender: "bad-address", // missing '@' → error row
      recipients: "good@x.com",
    });

    await harness.service._runVersionedMigrations();

    const errCountBefore = (
      harness.db
        .prepare("SELECT COUNT(*) as c FROM email_participants_backfill_errors")
        .get() as { c: number }
    ).c;
    expect(errCountBefore).toBe(1);

    // Manually re-invoke v41 to exercise INSERT OR IGNORE + UNIQUE(email_id, role, raw_value)
    const v41 = (
      harness.service.constructor.MIGRATIONS as Array<{
        version: number;
        migrate: (d: unknown) => void;
      }>
    ).find((m) => m.version === 41)!;
    v41.migrate(harness.db);

    const errCountAfter = (
      harness.db
        .prepare("SELECT COUNT(*) as c FROM email_participants_backfill_errors")
        .get() as { c: number }
    ).c;
    expect(errCountAfter).toBe(1); // no duplicate error rows
  });
});
