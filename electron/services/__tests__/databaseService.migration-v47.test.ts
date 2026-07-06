/**
 * @jest-environment node
 *
 * Integration test for migration v47 (BACKLOG-1861 — legacy email dedup).
 *
 * Verifies:
 *   1. schema_version advances to the latest migration.
 *   2. Standard collapse: legacy (NULL msg-id) + new (non-NULL), same content
 *      → legacy deleted, communications link moved to new.
 *   3. Dedup link: both rows linked to the same transaction → only one link
 *      survives (legacy's dupe is deleted, new keeps its own).
 *   4. Removal state: legacy row has ignored_communications entry → moved to new.
 *   5. Near-miss: different sender → NOT collapsed (both rows survive).
 *   6. Near-miss: sent_at > 2s apart → NOT collapsed.
 *   7. Ambiguous pair (one legacy matches two new rows) → skipped.
 *   8. email_participants moved from legacy to new when new has none.
 *   9. email_participants NOT double-moved when new already has its own.
 *  10. Retained legacy stray link (append-only founder policy): a legacy row
 *      linked to a "wrong" transaction is collapsed but its link is KEPT on
 *      the survivor — mirrors the founder's fixture shape.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v46.test.ts
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

// ---------------------------------------------------------------------------
// FIXTURE
// ---------------------------------------------------------------------------

const USER_ID = "user-v47-test";

/**
 * Pre-v47 schema: the full post-v46 shape including all tables the migration
 * touches. schema_version starts at 46 so only v47 runs.
 */
const PRE_V47_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    external_id TEXT,
    account_id TEXT,
    source TEXT CHECK (source IN ('gmail', 'outlook')),
    message_id_header TEXT,
    subject TEXT,
    sender TEXT,
    sent_at DATETIME,
    ingest_source TEXT NOT NULL DEFAULT 'legacy',
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE communications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    transaction_id TEXT,
    email_id TEXT,
    link_source TEXT,
    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    CHECK (email_id IS NOT NULL)
  );
  CREATE UNIQUE INDEX idx_comm_email_txn ON communications(email_id, transaction_id)
    WHERE email_id IS NOT NULL AND transaction_id IS NOT NULL;

  CREATE TABLE ignored_communications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    email_id TEXT,
    email_subject TEXT,
    email_sender TEXT,
    email_sent_at TEXT,
    reason TEXT,
    ignored_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE TABLE email_participants (
    email_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'bcc')),
    position INTEGER NOT NULL,
    participant_hash TEXT NOT NULL,
    email_address TEXT NOT NULL,
    display_name TEXT,
    PRIMARY KEY (email_id, role, position),
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  );

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT,
    message_id TEXT,
    filename TEXT NOT NULL,
    file_size_bytes INTEGER,
    mime_type TEXT,
    storage_path TEXT,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    CHECK (message_id IS NOT NULL OR email_id IS NOT NULL)
  );
  CREATE INDEX idx_attachments_email_id ON attachments(email_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function seedFixture(harness: MigrationHarness): void {
  harness.db.exec(PRE_V47_FIXTURE);
  harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  harness.db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run("txn-1", USER_ID);
  harness.db.prepare("INSERT INTO transactions (id, user_id) VALUES (?, ?)").run("txn-stray", USER_ID);
  harness.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 46)").run();
}

function insertEmail(
  db: DatabaseType,
  row: {
    id: string;
    external_id?: string | null;
    source?: string;
    message_id_header?: string | null;
    subject?: string | null;
    sender?: string | null;
    sent_at?: string | null;
    ingest_source?: string;
  },
): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, message_id_header, subject, sender, sent_at, ingest_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    USER_ID,
    row.external_id ?? null,
    row.source ?? "outlook",
    row.message_id_header ?? null,
    row.subject ?? null,
    row.sender ?? null,
    row.sent_at ?? null,
    row.ingest_source ?? "legacy",
  );
}

function link(db: DatabaseType, id: string, emailId: string, txnId: string): void {
  db.prepare(
    "INSERT INTO communications (id, user_id, email_id, transaction_id) VALUES (?, ?, ?, ?)",
  ).run(id, USER_ID, emailId, txnId);
}

function emailExists(db: DatabaseType, id: string): boolean {
  return !!db.prepare("SELECT id FROM emails WHERE id = ?").get(id);
}

function commsForEmail(db: DatabaseType, emailId: string): string[] {
  return (
    db.prepare("SELECT id FROM communications WHERE email_id = ?").all(emailId) as { id: string }[]
  ).map((r) => r.id);
}

function latestVersion(harness: MigrationHarness): number {
  const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
  return migrations[migrations.length - 1].version;
}

function insertAttachment(
  db: DatabaseType,
  row: { id: string; emailId: string; filename: string; fileSizeBytes?: number | null },
): void {
  db.prepare(
    "INSERT INTO attachments (id, email_id, filename, file_size_bytes) VALUES (?, ?, ?, ?)",
  ).run(row.id, row.emailId, row.filename, row.fileSizeBytes ?? null);
}

function attachmentsForEmail(db: DatabaseType, emailId: string): string[] {
  return (
    db.prepare("SELECT id FROM attachments WHERE email_id = ?").all(emailId) as { id: string }[]
  ).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v47 (BACKLOG-1861 — legacy email dedup)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.pragma("foreign_keys = ON");
    seedFixture(harness);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("advances schema_version to the latest migration", async () => {
    await harness.service._runVersionedMigrations();
    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(latestVersion(harness));
    expect(row.version).toBe(47);
  });

  it("collapses a legacy+new pair: legacy deleted, comms link moved to new", async () => {
    insertEmail(harness.db, { id: "leg-1", external_id: "OLD-1", subject: "Offer Accepted", sender: "agent@re.com", sent_at: "2024-03-01T09:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-1", external_id: "NEW-1", subject: "Offer Accepted", sender: "agent@re.com", sent_at: "2024-03-01T09:00:00Z", message_id_header: "<abc123@mail.outlook.com>", ingest_source: "filter" });
    link(harness.db, "comm-leg-1", "leg-1", "txn-1");

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-1")).toBe(false);
    expect(emailExists(harness.db, "new-1")).toBe(true);
    expect(commsForEmail(harness.db, "new-1")).toEqual(["comm-leg-1"]);
    expect(commsForEmail(harness.db, "leg-1")).toHaveLength(0);
  });

  it("dedup link: both linked to same transaction → survivor keeps one link, dupe discarded", async () => {
    insertEmail(harness.db, { id: "leg-2", external_id: "OLD-2", subject: "Closing Disclosure", sender: "escrow@co.com", sent_at: "2024-04-10T14:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-2", external_id: "NEW-2", subject: "Closing Disclosure", sender: "escrow@co.com", sent_at: "2024-04-10T14:00:00Z", message_id_header: "<close@mail.com>", ingest_source: "filter" });
    link(harness.db, "comm-leg-2", "leg-2", "txn-1");
    link(harness.db, "comm-new-2", "new-2", "txn-1");

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-2")).toBe(false);
    const links = commsForEmail(harness.db, "new-2");
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("comm-new-2"); // legacy's dupe comm-leg-2 was deleted
  });

  it("preserves ignored_communications (removal state) on survivor", async () => {
    insertEmail(harness.db, { id: "leg-3", external_id: "OLD-3", subject: "Inspection Report", sender: "inspector@hm.com", sent_at: "2024-05-01T08:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-3", external_id: "NEW-3", subject: "Inspection Report", sender: "inspector@hm.com", sent_at: "2024-05-01T08:00:00Z", message_id_header: "<insp@mail.com>", ingest_source: "filter" });
    harness.db
      .prepare(
        "INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, email_subject) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ign-leg-3", USER_ID, "txn-1", "leg-3", "Inspection Report");

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-3")).toBe(false);
    const ign = harness.db
      .prepare("SELECT email_id FROM ignored_communications WHERE id = 'ign-leg-3'")
      .get() as { email_id: string } | undefined;
    expect(ign?.email_id).toBe("new-3");
  });

  it("near-miss: different sender → NOT collapsed", async () => {
    insertEmail(harness.db, { id: "leg-4", external_id: "OLD-4", subject: "Contract", sender: "alice@re.com", sent_at: "2024-06-01T10:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-4", external_id: "NEW-4", subject: "Contract", sender: "bob@re.com", sent_at: "2024-06-01T10:00:00Z", message_id_header: "<contract@mail.com>", ingest_source: "filter" });

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-4")).toBe(true);
    expect(emailExists(harness.db, "new-4")).toBe(true);
  });

  it("near-miss: sent_at > 2s apart → NOT collapsed", async () => {
    insertEmail(harness.db, { id: "leg-5", external_id: "OLD-5", subject: "Amendment", sender: "agent@re.com", sent_at: "2024-07-01T12:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-5", external_id: "NEW-5", subject: "Amendment", sender: "agent@re.com", sent_at: "2024-07-01T12:00:05Z", message_id_header: "<amend@mail.com>", ingest_source: "filter" });

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-5")).toBe(true);
    expect(emailExists(harness.db, "new-5")).toBe(true);
  });

  it("ambiguous pair (one legacy matches two new rows) → skipped, all survive", async () => {
    // Same subject + sender + sent_at but two different new rows with different
    // message_id_headers — legacy can't be unambiguously paired.
    insertEmail(harness.db, { id: "leg-6", external_id: "OLD-6", subject: "Notice", sender: "agent@re.com", sent_at: "2024-08-01T09:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-6a", external_id: "NEW-6A", subject: "Notice", sender: "agent@re.com", sent_at: "2024-08-01T09:00:00Z", message_id_header: "<notice-a@mail.com>", ingest_source: "filter" });
    insertEmail(harness.db, { id: "new-6b", external_id: "NEW-6B", subject: "Notice", sender: "agent@re.com", sent_at: "2024-08-01T09:00:01Z", message_id_header: "<notice-b@mail.com>", ingest_source: "filter" });

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-6")).toBe(true);
    expect(emailExists(harness.db, "new-6a")).toBe(true);
    expect(emailExists(harness.db, "new-6b")).toBe(true);
  });

  it("email_participants moved from legacy to new when new has none", async () => {
    insertEmail(harness.db, { id: "leg-7", external_id: "OLD-7", subject: "Purchase Agreement", sender: "seller@re.com", sent_at: "2024-09-01T11:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-7", external_id: "NEW-7", subject: "Purchase Agreement", sender: "seller@re.com", sent_at: "2024-09-01T11:00:00Z", message_id_header: "<pa@mail.com>", ingest_source: "filter" });
    // Legacy has a participant; new has none.
    harness.db
      .prepare(
        "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, ?, ?, ?, ?)",
      )
      .run("leg-7", "from", 0, "hash-leg-7", "seller@re.com");

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-7")).toBe(false);
    const parts = harness.db
      .prepare("SELECT email_id FROM email_participants WHERE email_id = ?")
      .all("new-7") as { email_id: string }[];
    expect(parts).toHaveLength(1);
  });

  it("email_participants NOT double-moved when new already has its own", async () => {
    insertEmail(harness.db, { id: "leg-8", external_id: "OLD-8", subject: "Deed", sender: "title@co.com", sent_at: "2024-10-01T15:00:00Z", message_id_header: null });
    insertEmail(harness.db, { id: "new-8", external_id: "NEW-8", subject: "Deed", sender: "title@co.com", sent_at: "2024-10-01T15:00:00Z", message_id_header: "<deed@mail.com>", ingest_source: "filter" });
    harness.db
      .prepare(
        "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, ?, ?, ?, ?)",
      )
      .run("leg-8", "from", 0, "hash-leg-8", "title@co.com");
    harness.db
      .prepare(
        "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, ?, ?, ?, ?)",
      )
      .run("new-8", "from", 0, "hash-new-8", "title@co.com");

    await harness.service._runVersionedMigrations();

    expect(emailExists(harness.db, "leg-8")).toBe(false);
    // new-8 should still have exactly one participant (its own, not duplicate).
    const parts = harness.db
      .prepare("SELECT participant_hash FROM email_participants WHERE email_id = ?")
      .all("new-8") as { participant_hash: string }[];
    expect(parts).toHaveLength(1);
    expect(parts[0].participant_hash).toBe("hash-new-8");
  });

  it("re-parents attachment from legacy to survivor; duplicate on survivor is discarded", async () => {
    // Legacy row has a downloaded attachment; new (survivor) row has no attachment.
    // After v47 the attachment row must survive, parented to the survivor.
    // Also verifies that if survivor ALREADY has an equivalent attachment, the
    // legacy duplicate is discarded (not moved) — no double-attachment.
    insertEmail(harness.db, {
      id: "leg-att",
      external_id: "OLD-ATT",
      subject: "Disclosure Package",
      sender: "agent@re.com",
      sent_at: "2024-11-01T10:00:00Z",
      message_id_header: null,
    });
    insertEmail(harness.db, {
      id: "new-att",
      external_id: "NEW-ATT",
      subject: "Disclosure Package",
      sender: "agent@re.com",
      sent_at: "2024-11-01T10:00:00Z",
      message_id_header: "<disclosure@mail.re.com>",
      ingest_source: "filter",
    });
    // Unique attachment on legacy only — should be moved to survivor.
    insertAttachment(harness.db, {
      id: "att-unique",
      emailId: "leg-att",
      filename: "disclosure.pdf",
      fileSizeBytes: 102400,
    });
    // Duplicate attachment: same filename+size already on survivor — legacy copy
    // should be discarded, not moved.
    insertAttachment(harness.db, {
      id: "att-leg-dupe",
      emailId: "leg-att",
      filename: "cover-letter.pdf",
      fileSizeBytes: 4096,
    });
    insertAttachment(harness.db, {
      id: "att-new-dupe",
      emailId: "new-att",
      filename: "cover-letter.pdf",
      fileSizeBytes: 4096,
    });

    await harness.service._runVersionedMigrations();

    // Legacy row deleted.
    expect(emailExists(harness.db, "leg-att")).toBe(false);
    expect(emailExists(harness.db, "new-att")).toBe(true);

    const atts = attachmentsForEmail(harness.db, "new-att");
    // Survivor should have: att-unique (moved) + att-new-dupe (its own).
    // att-leg-dupe should have been discarded.
    expect(atts).toHaveLength(2);
    expect(atts).toContain("att-unique");
    expect(atts).toContain("att-new-dupe");
    expect(atts).not.toContain("att-leg-dupe");

    // att-leg-dupe must be gone (not left orphaned).
    const orphan = harness.db
      .prepare("SELECT id FROM attachments WHERE id = 'att-leg-dupe'")
      .get();
    expect(orphan).toBeUndefined();
  });

  it("retained legacy stray link (append-only policy): stray link preserved on survivor", async () => {
    // Mirrors the founder's fixture: a legacy row is linked to txn-stray (a
    // wrong-property transaction auto-linked by 2.19). After collapse the new
    // row (survivor) inherits the stray link — it is NOT removed (append-only).
    insertEmail(harness.db, {
      id: "leg-stray",
      external_id: "OLD-STRAY",
      subject: "RECORDED/CLOSED - Torres - 3267 Sunset Blvd | HT-9912",
      sender: "escrow@titleco.com",
      sent_at: "2024-02-14T16:00:00Z",
      message_id_header: null,
    });
    insertEmail(harness.db, {
      id: "new-stray",
      external_id: "NEW-STRAY",
      subject: "RECORDED/CLOSED - Torres - 3267 Sunset Blvd | HT-9912",
      sender: "escrow@titleco.com",
      sent_at: "2024-02-14T16:00:00Z",
      message_id_header: "<torres@mail.escrow.com>",
      ingest_source: "filter",
    });
    // Legacy is linked to the "wrong" transaction (stray auto-link from 2.19).
    link(harness.db, "comm-stray-leg", "leg-stray", "txn-stray");
    // New row is NOT linked to txn-stray.

    await harness.service._runVersionedMigrations();

    // Legacy row deleted; new row survived.
    expect(emailExists(harness.db, "leg-stray")).toBe(false);
    expect(emailExists(harness.db, "new-stray")).toBe(true);
    // Stray link now points to the survivor — retained per founder policy.
    const links = commsForEmail(harness.db, "new-stray");
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("comm-stray-leg");
  });
});
