/**
 * Pins for the statements BACKLOG-2989 chunk 3 moved as plain constants —
 * `localUserSql`, `messageImportStatsSql`, `folderExportAttachmentSql` and
 * `emailAttachmentBackfillSql`.
 *
 * All eight are verified BYTE-IDENTICAL to their pre-move text by the SQL
 * boundary gate's own content hashes, so the risk this suite covers is not
 * "did the text change" — it is "does the text still MEAN what the callers
 * assume". Four of the six source files had no test at all.
 *
 * Schema: `electron/database/schema.sql` executed whole, `foreign_keys = ON`.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { LOCAL_USER_BY_ID_SQL, LOCAL_USER_ID_SQL } from "../localUserSql";
import { MESSAGE_IMPORT_SUMMARY_SQL } from "../messageImportStatsSql";
import {
  ATTACHMENT_COUNT_FOR_EMAIL_SQL,
  EMAIL_FETCH_IDENTITY_SQL,
} from "../folderExportAttachmentSql";
import {
  COUNT_EMAILS_MISSING_ATTACHMENTS_SQL,
  SELECT_EMAILS_MISSING_ATTACHMENTS_SQL,
} from "../emailAttachmentBackfillSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-c3";
const OTHER = "user-2989-c3-other";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addUser = (id: string, email: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, email, `oauth-${id}`);
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-c3-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("localUserSql", () => {
  it("LOCAL_USER_ID_SQL returns nothing before onboarding has written a user", () => {
    // Every caller branches on this. Returning a row here would mean the app
    // proceeded with a user id that does not exist.
    expect(db.prepare(LOCAL_USER_ID_SQL).get()).toBeUndefined();
  });

  it("LOCAL_USER_ID_SQL returns the local user's id", () => {
    addUser(USER, "a@example.test");
    expect(db.prepare(LOCAL_USER_ID_SQL).get()).toEqual({ id: USER });
  });

  it("LOCAL_USER_BY_ID_SQL confirms an id that exists and rejects one that does not", () => {
    addUser(USER, "a@example.test");
    addUser(OTHER, "b@example.test");

    expect(db.prepare(LOCAL_USER_BY_ID_SQL).get(OTHER)).toEqual({ id: OTHER });
    expect(db.prepare(LOCAL_USER_BY_ID_SQL).get("nobody")).toBeUndefined();
  });
});

describe("MESSAGE_IMPORT_SUMMARY_SQL", () => {
  const addMessage = (id: string, channel: string, createdAt: string): void => {
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, body_text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, USER, channel, `body ${id}`, createdAt);
  };

  beforeEach(() => {
    addUser(USER, "a@example.test");
    addUser(OTHER, "b@example.test");
  });

  it("counts sms and imessage, and excludes other channels", () => {
    addMessage("m1", "sms", "2026-01-01T00:00:00Z");
    addMessage("m2", "imessage", "2026-03-01T00:00:00Z");
    addMessage("m3", "email", "2026-06-01T00:00:00Z");

    // `messages` holds email rows too. Counting them would report a text
    // import as more complete than it is.
    expect(db.prepare(MESSAGE_IMPORT_SUMMARY_SQL).get(USER)).toEqual({
      count: 2,
      last_import_at: "2026-03-01T00:00:00Z",
    });
  });

  it("is scoped to the requesting user", () => {
    addMessage("m1", "sms", "2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, body_text, created_at)
       VALUES ('m-theirs', ?, 'sms', 'x', '2026-09-09T00:00:00Z')`,
    ).run(OTHER);

    expect(db.prepare(MESSAGE_IMPORT_SUMMARY_SQL).get(USER)).toEqual({
      count: 1,
      last_import_at: "2026-01-01T00:00:00Z",
    });
  });

  it("returns a row with 0 and null when nothing has been imported", () => {
    // An aggregate over zero rows still yields one row; the handler reads
    // `result?.count ?? 0` and would otherwise never see the count.
    expect(db.prepare(MESSAGE_IMPORT_SUMMARY_SQL).get(USER)).toEqual({
      count: 0,
      last_import_at: null,
    });
  });
});

describe("folderExportAttachmentSql", () => {
  beforeEach(() => {
    addUser(USER, "a@example.test");
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, subject)
       VALUES ('e1', ?, 'ext-1', 'outlook', 's')`,
    ).run(USER);
  });

  it("ATTACHMENT_COUNT_FOR_EMAIL_SQL counts only that email's attachments", () => {
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source) VALUES ('e2', ?, 'ext-2', 'gmail')`,
    ).run(USER);
    const ins = db.prepare(
      `INSERT INTO attachments (id, email_id, filename) VALUES (?, ?, ?)`,
    );
    ins.run("a1", "e1", "1.pdf");
    ins.run("a2", "e1", "2.pdf");
    ins.run("a3", "e2", "3.pdf");

    expect(db.prepare(ATTACHMENT_COUNT_FOR_EMAIL_SQL).get("e1")).toEqual({ cnt: 2 });
    expect(db.prepare(ATTACHMENT_COUNT_FOR_EMAIL_SQL).get("e2")).toEqual({ cnt: 1 });
  });

  it("EMAIL_FETCH_IDENTITY_SQL returns the four fields a re-fetch needs", () => {
    // All four travel as a set: external_id + source identify the message to
    // the provider, user_id selects the credentials.
    expect(db.prepare(EMAIL_FETCH_IDENTITY_SQL).get("e1")).toEqual({
      id: "e1",
      external_id: "ext-1",
      source: "outlook",
      user_id: USER,
    });
  });

  it("EMAIL_FETCH_IDENTITY_SQL returns nothing for an unknown id", () => {
    expect(db.prepare(EMAIL_FETCH_IDENTITY_SQL).get("no-such-email")).toBeUndefined();
  });
});

describe("emailAttachmentBackfillSql", () => {
  const addEmail = (
    id: string,
    receivedAt: string,
    opts: { hasAttachments?: number; externalId?: string | null; source?: string | null } = {},
  ): void => {
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, has_attachments, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      USER,
      opts.externalId === undefined ? `ext-${id}` : opts.externalId,
      opts.source === undefined ? "gmail" : opts.source,
      opts.hasAttachments === undefined ? 1 : opts.hasAttachments,
      receivedAt,
    );
  };

  beforeEach(() => {
    addUser(USER, "a@example.test");
    addUser(OTHER, "b@example.test");
  });

  it("counts and selects the same set — the two statements share one WHERE", () => {
    addEmail("e-a", "2026-01-01T00:00:00Z");
    addEmail("e-b", "2026-02-01T00:00:00Z");
    addEmail("e-skip", "2026-03-01T00:00:00Z", { hasAttachments: 0 });

    const n = (
      db.prepare(COUNT_EMAILS_MISSING_ATTACHMENTS_SQL).get(USER) as { n: number }
    ).n;
    const ids = (
      db.prepare(SELECT_EMAILS_MISSING_ATTACHMENTS_SQL).all(USER, 100) as Array<{ id: string }>
    ).map((r) => r.id);

    // If the fragment ever drifted between the two, the count would stop
    // describing the page — which is what the shared constant prevents.
    expect(n).toBe(2);
    expect(ids.sort()).toEqual(["e-a", "e-b"]);
  });

  it("excludes every row the WHERE clause is there to exclude", () => {
    addEmail("e-wanted", "2026-01-01T00:00:00Z");
    addEmail("e-no-flag", "2026-01-02T00:00:00Z", { hasAttachments: 0 });
    addEmail("e-null-external", "2026-01-03T00:00:00Z", { externalId: null });
    addEmail("e-null-source", "2026-01-04T00:00:00Z", { source: null });
    addEmail("e-already", "2026-01-05T00:00:00Z");
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename) VALUES ('a-x', 'e-already', 'x.pdf')`,
    ).run();
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, has_attachments, received_at)
       VALUES ('e-theirs', ?, 'ext-t', 'gmail', 1, '2026-01-06T00:00:00Z')`,
    ).run(OTHER);

    const ids = (
      db.prepare(SELECT_EMAILS_MISSING_ATTACHMENTS_SQL).all(USER, 100) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["e-wanted"]);
  });

  it("returns the newest first and honours the page size", () => {
    addEmail("e-old", "2026-01-01T00:00:00Z");
    addEmail("e-mid", "2026-06-01T00:00:00Z");
    addEmail("e-new", "2026-12-01T00:00:00Z");

    // Newest first: a bounded run drains the mail a user is most likely to be
    // looking for while the backfill is still catching up.
    const ids = (
      db.prepare(SELECT_EMAILS_MISSING_ATTACHMENTS_SQL).all(USER, 2) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["e-new", "e-mid"]);
  });
});
