/**
 * Pins for `db/messageImportSql` — BACKLOG-2990 chunk 3a.
 *
 * Eleven statements moved byte-identically (verified by content hash against the
 * gate baseline, so they need no behavioural pin here beyond a smoke read).
 *
 * THREE ARE DELIBERATELY CHANGED, and they are what this file exists for. Their
 * `IN (...)` width used to be built at the call site — `ids.map(() => "?")` —
 * one expression away from the spread that bound the values. The width now comes
 * from the same array that is bound, inside `db/`.
 *
 * Byte-identity is unavailable for those three, so the control is a BOUNDARY
 * SWEEP over the list width: 0, 1, 2, N. A single-width test cannot separate
 * "derives the width correctly" from "happens to work for one id", which is the
 * whole failure mode — the old form breaks with `SQLITE_RANGE` only when the two
 * expressions disagree, and they only disagree at some widths.
 *
 * Rows are asserted by EXACT ID SET, never by count: a count passes while
 * returning different rows.
 */

import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  ALL_MESSAGE_EXTERNAL_IDS_SQL,
  ATTACHMENT_COUNT_SQL,
  ATTACHMENT_STORED_KEYS_SQL,
  ATTACHMENTS_BY_MESSAGE_ID_SQL,
  MESSAGE_EXISTS_SQL,
  selectAttachmentsByExternalMessageIds,
  selectAttachmentsByMessageIds,
  selectMessageExternalIds,
} from "../messageImportSql";

type Db = InstanceType<typeof RealDatabase>;

/**
 * The columns these statements touch. Transcribed from the live schema rather
 * than invented: `messages` and `attachments` carry many more columns, and the
 * statements under test name every column they read, so a narrower table would
 * still exercise them faithfully.
 */
function openTestDb(): Db {
  const db = new RealDatabase(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      external_id TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      external_message_id TEXT,
      filename TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER,
      storage_path TEXT
    );
  `);
  return db;
}

/** Five messages, each with one attachment, plus one attachment with no external id. */
function seed(db: Db): void {
  const msg = db.prepare(`INSERT INTO messages (id, user_id, external_id) VALUES (?, ?, ?)`);
  const att = db.prepare(
    `INSERT INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 5; i++) {
    msg.run(`m${i}`, "USER", `guid-${i}`);
    att.run(`a${i}`, `m${i}`, `guid-${i}`, `f${i}.png`, "image/png", 100 * i, `/store/h${i}.png`);
  }
  // A row with no external id — every "IS NOT NULL" filter must exclude it.
  att.run("a-orphan", "m1", null, "orphan.png", "image/png", 1, "/store/orphan.png");
  msg.run("m-noext", "USER", null);
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id).sort();

describe("messageImportSql — batched reads derive their IN width from what they bind", () => {
  let db: Db;
  beforeEach(() => {
    db = openTestDb();
    seed(db);
  });
  afterEach(() => db.close());

  describe("selectAttachmentsByMessageIds — boundary sweep 0/1/2/N", () => {
    it("width 0 matches nothing, rather than throwing or matching everything", () => {
      const rows = selectAttachmentsByMessageIds<{ id: string }>(db, []);
      expect(ids(rows)).toEqual([]);
    });

    it("width 1 returns exactly that message's attachments", () => {
      const rows = selectAttachmentsByMessageIds<{ id: string }>(db, ["m3"]);
      expect(ids(rows)).toEqual(["a3"]);
    });

    it("width 2 returns both, and nothing between them", () => {
      const rows = selectAttachmentsByMessageIds<{ id: string }>(db, ["m2", "m4"]);
      expect(ids(rows)).toEqual(["a2", "a4"]);
    });

    it("width N binds every id — the case a width/bind mismatch fails on", () => {
      const rows = selectAttachmentsByMessageIds<{ id: string }>(db, [
        "m1",
        "m2",
        "m3",
        "m4",
        "m5",
      ]);
      // a-orphan also has message_id m1, so m1 contributes two rows.
      expect(ids(rows)).toEqual(["a-orphan", "a1", "a2", "a3", "a4", "a5"].sort());
    });

    it("an unknown id matches nothing without disturbing the known ones", () => {
      const rows = selectAttachmentsByMessageIds<{ id: string }>(db, ["m1", "nope"]);
      expect(ids(rows)).toEqual(["a-orphan", "a1"].sort());
    });
  });

  describe("selectMessageExternalIds — boundary sweep, and the NOT NULL filter", () => {
    it("width 0 matches nothing", () => {
      expect(selectMessageExternalIds<{ id: string }>(db, [])).toEqual([]);
    });

    it("width 1", () => {
      const rows = selectMessageExternalIds<{ id: string; external_id: string }>(db, ["m2"]);
      expect(rows).toEqual([{ id: "m2", external_id: "guid-2" }]);
    });

    it("width 2", () => {
      const rows = selectMessageExternalIds<{ id: string }>(db, ["m1", "m5"]);
      expect(ids(rows)).toEqual(["m1", "m5"]);
    });

    it("width N", () => {
      const rows = selectMessageExternalIds<{ id: string }>(db, ["m1", "m2", "m3", "m4", "m5"]);
      expect(ids(rows)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    });

    it("EXCLUDES a message whose external_id is NULL even when asked for by id", () => {
      const rows = selectMessageExternalIds<{ id: string }>(db, ["m1", "m-noext"]);
      expect(ids(rows)).toEqual(["m1"]);
    });
  });

  describe("selectAttachmentsByExternalMessageIds — the TASK-1110 fallback, batched", () => {
    it("width 0 matches nothing", () => {
      expect(selectAttachmentsByExternalMessageIds<{ id: string }>(db, [])).toEqual([]);
    });

    it("width 1 resolves by external id, not internal id", () => {
      const rows = selectAttachmentsByExternalMessageIds<{ id: string }>(db, ["guid-4"]);
      expect(ids(rows)).toEqual(["a4"]);
    });

    it("width 2", () => {
      const rows = selectAttachmentsByExternalMessageIds<{ id: string }>(db, ["guid-1", "guid-3"]);
      expect(ids(rows)).toEqual(["a1", "a3"]);
    });

    it("width N returns every match and no orphan", () => {
      const rows = selectAttachmentsByExternalMessageIds<{ id: string }>(db, [
        "guid-1",
        "guid-2",
        "guid-3",
        "guid-4",
        "guid-5",
      ]);
      expect(ids(rows)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    });
  });

  describe("the moved constants still answer what they answered before", () => {
    it("ATTACHMENTS_BY_MESSAGE_ID_SQL reads one message's attachments", () => {
      const rows = db.prepare(ATTACHMENTS_BY_MESSAGE_ID_SQL).all("m1") as { id: string }[];
      expect(ids(rows)).toEqual(["a-orphan", "a1"].sort());
    });

    it("ATTACHMENT_STORED_KEYS_SQL excludes the row with no external id", () => {
      const rows = db.prepare(ATTACHMENT_STORED_KEYS_SQL).all() as {
        external_message_id: string;
      }[];
      expect(rows.map((r) => r.external_message_id).sort()).toEqual([
        "guid-1",
        "guid-2",
        "guid-3",
        "guid-4",
        "guid-5",
      ]);
    });

    it("ALL_MESSAGE_EXTERNAL_IDS_SQL excludes the message with no external id", () => {
      const rows = db.prepare(ALL_MESSAGE_EXTERNAL_IDS_SQL).all() as { id: string }[];
      expect(ids(rows)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    });

    it("MESSAGE_EXISTS_SQL is a probe, present and absent", () => {
      expect(db.prepare(MESSAGE_EXISTS_SQL).get("m1")).toBeTruthy();
      expect(db.prepare(MESSAGE_EXISTS_SQL).get("nope")).toBeUndefined();
    });

    it("ATTACHMENT_COUNT_SQL counts every attachment including the orphan", () => {
      expect(db.prepare(ATTACHMENT_COUNT_SQL).get()).toEqual({ count: 6 });
    });
  });
});
