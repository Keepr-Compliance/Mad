/**
 * @jest-environment node
 *
 * BACKLOG-3731 — the submit, the pre-flight and the Attachments tab use the
 * same text-attachment lookup the Messages view uses.
 *
 * The shape under test: a text attachment row whose `message_id` names a
 * message that no longer exists, while its `external_message_id` is the deal
 * text's Apple id. The Messages view shows that image (TASK-1110 fallback);
 * before this change the submit never saw it and the pre-flight flagged the
 * text as "photo isn't on this computer".
 *
 * Fixture provenance:
 *  - `attachments` columns, the CHECK and the FKs are transcribed from
 *    `electron/database/schema.sql` (attachments table).
 *  - The attachment row is written in the import's insert shape
 *    (`macOSMessagesImportService.ts` storeAttachments: id, message_id,
 *    external_message_id = chat.db message guid, filename, mime_type,
 *    file_size_bytes, storage_path).
 *  - The dangling `message_id` is inserted with `foreign_keys = OFF`, the way a
 *    migration that rebuilds tables leaves it; FKs are back ON afterwards, as at
 *    runtime (`databaseService.ts`).
 *
 * REAL in-memory better-sqlite3 via a mocked `ensureDb` (the pattern of
 * `submissionDbService.closingDay-2781.test.ts`). Run with `npm test`.
 */

import path from "path";

const mockEnsureDb = jest.fn();
jest.mock("../core/dbConnection", () => ({
  ensureDb: () => mockEnsureDb(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { selectTextAttachmentsForMessages, TEXT_ATTACHMENT_LOOKUP_CHUNK } from "../textAttachmentLookupSql";
import { getTransactionAttachments, getTransactionMessages } from "../submissionDbService";
import { getTransactionAllAttachments } from "../attachmentDbService";
import { runSubmissionPreflight, setPreflightStatForTests } from "../../submissionPreflight";
import { targetsInTransactionSql } from "../checklistSql";
import { ALL_TEXT_IDS } from "../../__tests__/helpers/selectedTextIds";

const DEAL_GUID = "p:0/AAAA-DEAL-GUID";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      -- BACKLOG-3733: NOT NULL in schema.sql; the submit's thread arm joins on it.
      user_id TEXT NOT NULL DEFAULT 'fixture-user',
      thread_id TEXT,
      external_id TEXT,
      sent_at DATETIME,
      direction TEXT,
      participants_flat TEXT,
      has_attachments INTEGER DEFAULT 0
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      sent_at DATETIME,
      direction TEXT,
      subject TEXT,
      sender TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      email_id TEXT,
      external_message_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT,
      file_size_bytes INTEGER,
      storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
      CHECK (message_id IS NOT NULL OR email_id IS NOT NULL)
    );
    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      -- BACKLOG-3733: NOT NULL in schema.sql; the submit's thread arm joins on it.
      user_id TEXT NOT NULL DEFAULT 'fixture-user',
      transaction_id TEXT,
      message_id TEXT,
      email_id TEXT,
      thread_id TEXT
    );
    -- BACKLOG-3764: the readers send a checklist group's evidence the agent
    -- chose to include regardless of the dates. The columns that query reads,
    -- as in schema.sql.
    CREATE TABLE transaction_checklists (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL);
    CREATE TABLE transaction_checklist_items (id TEXT PRIMARY KEY, checklist_id TEXT NOT NULL);
    CREATE TABLE transaction_checklist_links (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, include_outside_dates INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE transaction_checklist_link_members (
      id TEXT PRIMARY KEY, link_id TEXT NOT NULL, attachment_id TEXT, email_id TEXT
    );
  `);
}

const insertAttachment = (db: DatabaseType, row: [string, string, string | null, string, string, number, string]) =>
  db
    .prepare(
      `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...row);

function seed(db: DatabaseType): void {
  db.pragma("foreign_keys = ON");
  const msg = db.prepare(
    `INSERT INTO messages (id, thread_id, external_id, sent_at, direction, participants_flat, has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const comm = db.prepare(
    `INSERT INTO communications (id, transaction_id, message_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
  );
  // The deal text whose photo's row has a stale message_id.
  msg.run("m-deal", "th-1", DEAL_GUID, "2026-09-24T15:00:00.000Z", "inbound", "+15555550100", 1);
  // A text with a normal, direct row.
  msg.run("m-direct", "th-1", "p:0/BBBB-DIRECT-GUID", "2026-09-24T16:00:00.000Z", "inbound", "+15555550100", 1);
  comm.run("c-1", "T1", null, null, "th-1");

  insertAttachment(db, ["a-direct", "m-direct", "p:0/BBBB-DIRECT-GUID", "IMG_0002.HEIC", "image/heic", 2048, "/data/b.heic"]);

  // The stale row: FKs off, as a table rebuild leaves it.
  db.pragma("foreign_keys = OFF");
  insertAttachment(db, ["a-stale", "gone-id", DEAL_GUID, "IMG_0001.HEIC", "image/heic", 4096, "/data/a.heic"]);
  db.pragma("foreign_keys = ON");
}

const staleRowNow = (db: DatabaseType) =>
  db.prepare(`SELECT * FROM attachments WHERE id = 'a-stale'`).get();

describe("BACKLOG-3731 — one text-attachment lookup (real sqlite)", () => {
  let db: DatabaseType;
  let staleBefore: unknown;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as DatabaseType;
    createSchema(db);
    seed(db);
    staleBefore = staleRowNow(db);
    mockEnsureDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    setPreflightStatForTests(null);
    jest.clearAllMocks();
  });

  it("fixture: a NULL message_id text row is impossible (the CHECK), so a NULL-only fallback can never fire", () => {
    expect(() =>
      db
        .prepare(`INSERT INTO attachments (id, message_id, email_id, external_message_id, filename) VALUES ('x', NULL, NULL, ?, 'x.heic')`)
        .run(DEAL_GUID),
    ).toThrow(/CHECK constraint/);
  });

  it("C-apple-id: the submit's lookup returns the stale row, resolved to the deal text, and writes nothing", () => {
    const rows = getTransactionAttachments("T1", null, null, ALL_TEXT_IDS);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get("a-stale")?.resolved_message_id).toBe("m-deal");
    expect(byId.get("a-direct")?.resolved_message_id).toBe("m-direct");
    expect(rows.map((r) => r.id).sort()).toEqual(["a-direct", "a-stale"]);

    // Read-only: the row is byte-identical afterwards.
    expect(staleRowNow(db)).toEqual(staleBefore);
    expect((staleRowNow(db) as { message_id: string }).message_id).toBe("gone-id");
  });

  it("C-apple-id: the pre-flight sends it and does not flag the deal text", async () => {
    setPreflightStatForTests(async () => ({ size: 4096 }));
    const messages = getTransactionMessages("T1", null, null, ALL_TEXT_IDS);
    const attachments = getTransactionAttachments("T1", null, null, ALL_TEXT_IDS);

    const result = await runSubmissionPreflight({
      messages,
      emails: [],
      attachments,
      undownloadedEmailAttachments: [],
      textLabel: () => "+15555550100",
    });

    expect(result.notIncluded).toEqual([]);
    expect(result.sendable.map((a) => a.id).sort()).toEqual(["a-direct", "a-stale"]);
    expect(staleRowNow(db)).toEqual(staleBefore);
  });

  it("C-apple-id: the Attachments tab shows it under the deal text, and writes nothing", () => {
    const rows = getTransactionAllAttachments("T1");
    const stale = rows.find((r) => r.id === "a-stale");
    expect(stale).toMatchObject({ source: "text", message_id: "m-deal", source_date: "2026-09-24T15:00:00.000Z" });
    expect(rows.filter((r) => r.source === "text").map((r) => r.id).sort()).toEqual(["a-direct", "a-stale"]);
    expect(staleRowNow(db)).toEqual(staleBefore);
  });

  it("twin: a text with a direct row is never double-counted, and the fallback is skipped for it", () => {
    // A second row carrying m-direct's Apple id but owned elsewhere: the view
    // rule only falls back for texts with ZERO direct rows, so it is not added.
    db.pragma("foreign_keys = OFF");
    insertAttachment(db, ["a-extra", "gone-2", "p:0/BBBB-DIRECT-GUID", "IMG_0003.HEIC", "image/heic", 1, "/data/c.heic"]);
    db.pragma("foreign_keys = ON");

    const resolved = selectTextAttachmentsForMessages<{ id: string; message_id: string | null }>(db, [
      "m-direct",
      "m-direct",
      "m-deal",
    ]);
    const ids = resolved.map((r) => r.row.id);
    expect(ids.filter((id) => id === "a-direct")).toHaveLength(1);
    expect(ids).not.toContain("a-extra");
    expect(new Set(ids)).toEqual(new Set(["a-direct", "a-stale"]));
  });

  it("chunks: more message ids than one IN list holds still resolve", () => {
    const ids = Array.from({ length: TEXT_ATTACHMENT_LOOKUP_CHUNK * 2 + 1 }, (_, i) => `filler-${i}`);
    ids.push("m-deal");
    const resolved = selectTextAttachmentsForMessages<{ id: string; message_id: string | null }>(db, ids);
    expect(resolved.map((r) => [r.row.id, r.resolved_message_id])).toEqual([["a-stale", "m-deal"]]);
  });

  // An email attachment carrying the deal text's Apple id. No writer emits
  // that collision; the guard makes the rule explicit.
  const insertEmailRowWithDealGuid = () => {
    db.prepare(`INSERT INTO emails (id, sent_at, direction, subject, sender) VALUES ('e-1', '2026-09-24T15:00:00.000Z', 'inbound', 's', 'x@example.com')`).run();
    db.prepare(
      `INSERT INTO attachments (id, message_id, email_id, external_message_id, filename) VALUES ('a-email', NULL, 'e-1', ?, 'doc.pdf')`,
    ).run(DEAL_GUID);
  };

  it("email guard: an email attachment is never matched by a text's Apple id", () => {
    insertEmailRowWithDealGuid();
    const resolved = selectTextAttachmentsForMessages<{ id: string; message_id: string | null }>(db, ["m-deal"]);
    expect(resolved.map((r) => [r.row.id, r.resolved_message_id])).toEqual([["a-stale", "m-deal"]]);
  });

  describe("checklist link check accepts what the tab lists (targetsInTransactionSql)", () => {
    const accepted = (ids: string[], txn = "T1"): string[] =>
      (
        db.prepare(targetsInTransactionSql("attachment", ids.length)).all(...ids, txn, txn) as { id: string }[]
      )
        .map((r) => r.id)
        .sort();

    it("a stale-id photo listed in the tab can be linked", () => {
      const tabTextIds = getTransactionAllAttachments("T1")
        .filter((r) => r.source === "text")
        .map((r) => r.id)
        .sort();
      expect(tabTextIds).toEqual(["a-direct", "a-stale"]);
      expect(accepted(tabTextIds)).toEqual(tabTextIds);
    });

    it("a stale-id photo is refused for a transaction its text is not linked to", () => {
      expect(accepted(["a-stale", "a-direct"], "T-other")).toEqual([]);
    });

    it("zero-direct rule: an Apple-id row for a text that has its own row is refused (as the tab omits it)", () => {
      db.pragma("foreign_keys = OFF");
      insertAttachment(db, ["a-extra", "gone-2", "p:0/BBBB-DIRECT-GUID", "IMG_0003.HEIC", "image/heic", 1, "/data/c.heic"]);
      db.pragma("foreign_keys = ON");
      expect(getTransactionAllAttachments("T1").map((r) => r.id)).not.toContain("a-extra");
      expect(accepted(["a-extra"])).toEqual([]);
    });

    it("email guard: an email attachment carrying a text's Apple id is refused when its email is not linked", () => {
      insertEmailRowWithDealGuid();
      expect(accepted(["a-email"])).toEqual([]);
    });
  });

  it("empty input returns nothing", () => {
    expect(selectTextAttachmentsForMessages(db, [])).toEqual([]);
  });
});
