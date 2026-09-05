/**
 * @jest-environment node
 *
 * BACKLOG-2977 — the attachment MARKER row, against the REAL schema and a real
 * SQLite engine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE CANNOT USE A MOCK
 * ---------------------------------------------------------------------------
 * Three facts it asserts live in `electron/database/schema.sql`, not in any
 * TypeScript this repo controls, and a hand-written double would simply agree
 * with whatever the code did:
 *
 *   `:64`    CHECK (message_id IS NOT NULL OR email_id IS NOT NULL)
 *            — an attachment row linked ONLY by external_message_id is
 *              REJECTED. This is the constraint the item's own transport note
 *              got wrong.
 *   `:1313`  UNIQUE INDEX idx_messages_user_external_id ON
 *            messages(user_id, external_id) — the index that makes the
 *            message-level INSERT OR IGNORE dedup at all.
 *   `:1146`  every index on `attachments` is PLAIN. There is no unique index,
 *   `-:1154` which is why `insertAttachment` cannot dedup itself and the caller
 *            has to guard.
 *
 * ---------------------------------------------------------------------------
 * THE MUTATIONS THAT MAKE EACH TEST RED
 * ---------------------------------------------------------------------------
 *   (c1) drop the getExistingAttachmentRecords guard  -> a re-sync writes a
 *        SECOND attachments row for the same photo
 *   (c2) link by the pre-generated crypto.randomUUID() instead of the id from
 *        getMessageIdMap                              -> message_id does not
 *        match messages.id, and the CHECK-satisfying link points at nothing
 *   (c3) drop the sort in storeMessages               -> a re-sync whose parts
 *        arrive in the other order writes duplicates
 *   (f)  remove the per-attachment try/catch          -> the throw escapes
 *        storeMessages, the message count is lost with it
 *   (f2) swallow the failure without counting it      -> attachmentsFailed
 *        stays 0 while the row is genuinely missing
 *
 * ---------------------------------------------------------------------------
 * ENGINE
 * ---------------------------------------------------------------------------
 * `openTestDb` prefers the production driver and falls back to `node:sqlite`,
 * so CI exercises better-sqlite3 while the same assertions stay runnable on a
 * dev machine whose shared binary is an Electron build. Both run the real
 * schema text either way.
 */

import fs from "fs";
import path from "path";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

let mockDb: TestDb;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T>(fn: () => T): T => mockDb.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

const logError = jest.fn();
jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: logError };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => ({ auth: { getUser: jest.fn() } }) },
}));

/**
 * Delegates to the REAL sync db layer, so the production INSERT OR IGNORE and
 * the real CHECK constraint are the code under test. `insertAttachment` is
 * routed through a spy hook so one test can make it throw.
 */
let insertAttachmentHook: ((params: unknown) => void) | null = null;
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    batchInsertMessages: (rows: unknown, size: number) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/syncDbService").batchInsertMessages(rows, size),
    getMessageIdMap: (userId: string) =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/syncDbService").getMessageIdMap(userId),
    getExistingAttachmentRecords: () =>
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../db/syncDbService").getExistingAttachmentRecords(),
    insertAttachment: (params: unknown) => {
      if (insertAttachmentHook) return insertAttachmentHook(params);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("../db/syncDbService").insertAttachment(params);
    },
  },
}));

import localSyncService from "../localSyncService";
import type { SyncMessage } from "../../types/localSync";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

type StoreMessages = (
  userId: string,
  deviceId: string,
  messages: SyncMessage[]
) => { stored: number; attachmentsFailed: number; skippedMessages: number };

const storeMessages = (
  localSyncService as unknown as { storeMessages: StoreMessages }
).storeMessages.bind(localSyncService);

const USER = "user-2977-link";
// An invented, fixed device id so metadata is stable across the two sync
// passes this suite compares.
const DEVICE = "22222222-3333-4444-5555-666666666666"; // pii-allow-uuid: invented, not from any live row
/** Reserved-range number (+1 <area> 555-01xx). */
const BROKER_CONTACT = "+12065550101";
const PHOTO_TS = 1_757_000_000_000;

const CAPTIONLESS_PHOTO: SyncMessage = {
  sender: BROKER_CONTACT,
  body: null,
  timestamp: PHOTO_TS,
  direction: "inbound",
  smsId: "mms:41",
  attachmentContentTypes: ["image/jpeg"],
  bodyAbsence: "no_text_part",
};

interface AttachmentRow {
  id: string;
  message_id: string | null;
  external_message_id: string | null;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}

function attachments(): AttachmentRow[] {
  return mockDb
    .prepare("SELECT * FROM attachments ORDER BY filename")
    .all() as AttachmentRow[];
}

function messages(): { id: string; external_id: string; has_attachments: number }[] {
  return mockDb
    .prepare("SELECT id, external_id, has_attachments FROM messages")
    .all() as { id: string; external_id: string; has_attachments: number }[];
}

beforeEach(() => {
  jest.clearAllMocks();
  insertAttachmentHook = null;
  mockDb = openTestDb();
  mockDb.exec(SCHEMA);
  mockDb
    .prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google','o1')")
    .run(USER, "agent@example.test");
});

afterEach(() => mockDb.close());

describe("(c) the marker row links by BOTH columns and survives a re-sync", () => {
  it("writes one row carrying the real messages.id AND the external id", () => {
    const result = storeMessages(USER, DEVICE, [CAPTIONLESS_PHOTO]);

    expect(result.stored).toBe(1);
    expect(result.attachmentsFailed).toBe(0);

    const [message] = messages();
    const rows = attachments();
    expect(rows).toHaveLength(1);

    // schema.sql:64 rejects a row with neither message_id nor email_id, so the
    // "link by external_message_id" instruction cannot be followed literally.
    expect(rows[0].message_id).toBe(message.id);
    expect(rows[0].external_message_id).toBe(message.external_id);
    // No bytes were transferred — BACKLOG-3071 fills this on the same row.
    expect(rows[0].storage_path).toBeNull();
    expect(rows[0].file_size_bytes).toBeNull();
    expect(rows[0].mime_type).toBe("image/jpeg");
    expect(message.has_attachments).toBe(1);
  });

  it("adds nothing on a re-sync, and keeps the SAME attachment row id", () => {
    storeMessages(USER, DEVICE, [CAPTIONLESS_PHOTO]);
    const firstId = attachments()[0].id;

    const second = storeMessages(USER, DEVICE, [CAPTIONLESS_PHOTO]);

    // The message dedups on the unique index; the attachment must dedup on the
    // caller's guard, because `attachments` has no unique index at all.
    expect(second.stored).toBe(0);
    expect(messages()).toHaveLength(1);
    const rows = attachments();
    expect(rows).toHaveLength(1);
    // Identity, not just count: a delete-and-reinsert would pass a count check.
    expect(rows[0].id).toBe(firstId);
  });

  it("still writes one row per part when the phone lists the parts in the other order", () => {
    const twoParts: SyncMessage = {
      ...CAPTIONLESS_PHOTO,
      smsId: "mms:47",
      attachmentContentTypes: ["image/jpeg", "image/png"],
    };
    storeMessages(USER, DEVICE, [twoParts]);
    const firstIds = attachments().map((r) => r.id);
    expect(attachments().map((r) => r.filename)).toEqual([
      "mms-part-0.jpeg",
      "mms-part-1.png",
    ]);

    // The phone builds attachmentContentTypes unsorted, so the same message can
    // legitimately arrive with its parts the other way round.
    storeMessages(USER, DEVICE, [
      { ...twoParts, attachmentContentTypes: ["image/png", "image/jpeg"] },
    ]);

    const rows = attachments();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(firstIds);
  });

  it("links a message that was ALREADY stored, rather than orphaning the row", () => {
    // First pass stores the message but writes no marker (no content types).
    const { attachmentContentTypes: _drop, ...withoutMarker } = CAPTIONLESS_PHOTO;
    storeMessages(USER, DEVICE, [withoutMarker as SyncMessage]);
    const originalMessageId = messages()[0].id;
    expect(attachments()).toHaveLength(0);

    // Second pass carries the marker. The message is a DUPLICATE now, so
    // INSERT OR IGNORE keeps the original row and discards the fresh UUID.
    storeMessages(USER, DEVICE, [CAPTIONLESS_PHOTO]);

    const rows = attachments();
    expect(rows).toHaveLength(1);
    // Linking by the discarded UUID would point at a row that does not exist.
    expect(rows[0].message_id).toBe(originalMessageId);
    expect(messages()).toHaveLength(1);
  });
});

describe("(f) an attachment failure never costs the batch", () => {
  it("keeps the message, reports the true stored count, and does not throw", () => {
    insertAttachmentHook = () => {
      throw new Error("disk full");
    };

    // Before this item, storeMessages could not throw after the message insert.
    // An unguarded attachment write changes that, and the caller turns a throw
    // into a 200 — so the phone drops the batch and never retries it.
    let result: ReturnType<StoreMessages> | null = null;
    expect(() => {
      result = storeMessages(USER, DEVICE, [CAPTIONLESS_PHOTO]);
    }).not.toThrow();

    expect(result!.stored).toBe(1);
    expect(messages()).toHaveLength(1);
    expect(attachments()).toHaveLength(0);
    expect(logError).toHaveBeenCalled();
  });
});

describe("(f2) the failure is observable at the return boundary", () => {
  it("counts every marker row it could not write", () => {
    insertAttachmentHook = () => {
      throw new Error("disk full");
    };

    const result = storeMessages(USER, DEVICE, [
      {
        ...CAPTIONLESS_PHOTO,
        attachmentContentTypes: ["image/jpeg", "image/png"],
      },
    ]);

    // Without this count the failure is invisible everywhere: it no longer
    // throws, `success` is a hardcoded literal, and `messagesStored` is a
    // MESSAGE count. BACKLOG-3110 has to read this to know a retry is needed.
    expect(result.attachmentsFailed).toBe(2);
    expect(result.stored).toBe(1);
    // The message survives, deliberately: a transaction spanning both writes
    // would trade this mis-marked message for a LOST one.
    expect(messages()[0].has_attachments).toBe(1);
  });

  it("reports zero when every row is written", () => {
    const result = storeMessages(USER, DEVICE, [CAPTIONLESS_PHOTO]);
    expect(result.attachmentsFailed).toBe(0);
  });
});
