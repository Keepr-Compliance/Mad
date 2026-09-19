/**
 * Pins for `db/attachmentAuditStatsSql` — BACKLOG-2989 chunk 3.
 *
 * The four counter functions are RECOMPOSED, not moved byte-identically: each
 * ends with an audit-window filter the handler used to assemble inline, so
 * there is no content hash to fall back on. Two controls stand in for it —
 * this suite, and a resolved-text equivalence sweep across all four window
 * shapes reported in the PR body.
 *
 * The schema is `electron/database/schema.sql`, executed whole with
 * `foreign_keys = ON`. Nothing here is transcribed or invented.
 *
 * ## What the fixture is built to catch
 *
 * A text reaches a transaction by TWO routes — a direct `communications.
 * message_id` link, or a thread-level link that covers every message in the
 * thread. So the fixture contains a message that is reachable by BOTH, which
 * is the case `COUNT(DISTINCT a.id)` exists for: a plain `COUNT(*)` would
 * count its attachment twice.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL,
  prepareEmailAttachmentCount,
  prepareEmailAttachmentSize,
  prepareTextAttachmentCount,
  prepareTextAttachmentSize,
  type AttachmentStatsQueryable,
} from "../attachmentAuditStatsSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-stats";
const TX = "tx-2989-stats";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;
let q: AttachmentStatsQueryable;

const NO_WINDOW = { hasStart: false, hasEnd: false };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-stats-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  q = db as unknown as AttachmentStatsQueryable;

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(USER, "stats@example.test", "oauth-stats");
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`,
  ).run(TX, USER, "1 Test Way");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const addMessage = (id: string, sentAt: string, threadId: string | null): void => {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, sent_at, thread_id, body_text)
     VALUES (?, ?, 'imessage', ?, ?, ?)`,
  ).run(id, USER, sentAt, threadId, `body ${id}`);
};

const addTextAttachment = (id: string, messageId: string, bytes: number): void => {
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, file_size_bytes, storage_path)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, messageId, `${id}.pdf`, bytes, `/tmp/${id}.pdf`);
};

const linkMessage = (commId: string, messageId: string): void => {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, message_id, link_source)
     VALUES (?, ?, ?, ?, 'auto')`,
  ).run(commId, USER, TX, messageId);
};

const linkThread = (commId: string, threadId: string): void => {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source)
     VALUES (?, ?, ?, ?, 'auto')`,
  ).run(commId, USER, TX, threadId);
};

const textCount = (w = NO_WINDOW, params: unknown[] = [TX]): number =>
  (prepareTextAttachmentCount(q, w).get(...params) as { count: number }).count;

const textSize = (w = NO_WINDOW, params: unknown[] = [TX]): number =>
  (prepareTextAttachmentSize(q, w).get(...params) as { total_size: number }).total_size;

describe("prepareTextAttachmentCount", () => {
  it("counts an attachment once even when the message is linked directly AND by thread", () => {
    // This is what COUNT(DISTINCT a.id) is for. Both communications rows match
    // the join, so a plain COUNT(*) reports 2 for one file.
    addMessage("m1", "2026-06-01T10:00:00Z", "thread-1");
    addTextAttachment("a1", "m1", 100);
    linkMessage("c-direct", "m1");
    linkThread("c-thread", "thread-1");

    expect(textCount()).toBe(1);
  });

  it("excludes an attachment whose file was never downloaded", () => {
    addMessage("m1", "2026-06-01T10:00:00Z", null);
    linkMessage("c1", "m1");
    addTextAttachment("a-have", "m1", 100);
    db.prepare(
      `INSERT INTO attachments (id, message_id, filename, file_size_bytes, storage_path)
       VALUES ('a-missing', 'm1', 'x.pdf', 999, NULL)`,
    ).run();

    // storage_path IS NOT NULL: a row with no file cannot be shown or
    // exported, so counting it would overstate what the audit holds.
    expect(textCount()).toBe(1);
  });

  it("counts nothing for a different transaction", () => {
    addMessage("m1", "2026-06-01T10:00:00Z", null);
    addTextAttachment("a1", "m1", 100);
    linkMessage("c1", "m1");

    expect(textCount(NO_WINDOW, ["tx-someone-else"])).toBe(0);
  });
});

describe("the audit window", () => {
  beforeEach(() => {
    addMessage("m-old", "2025-01-01T00:00:00Z", null);
    addMessage("m-mid", "2026-06-01T00:00:00Z", null);
    addMessage("m-new", "2026-12-01T00:00:00Z", null);
    addTextAttachment("a-old", "m-old", 10);
    addTextAttachment("a-mid", "m-mid", 20);
    addTextAttachment("a-new", "m-new", 40);
    linkMessage("c-old", "m-old");
    linkMessage("c-mid", "m-mid");
    linkMessage("c-new", "m-new");
  });

  it("counts everything when neither bound is set", () => {
    expect(textCount()).toBe(3);
    expect(textSize()).toBe(70);
  });

  it("applies a lower bound only", () => {
    const w = { hasStart: true, hasEnd: false };
    expect(textCount(w, [TX, "2026-01-01T00:00:00Z"])).toBe(2);
    expect(textSize(w, [TX, "2026-01-01T00:00:00Z"])).toBe(60);
  });

  it("applies an upper bound only", () => {
    const w = { hasStart: false, hasEnd: true };
    expect(textCount(w, [TX, "2026-07-01T00:00:00Z"])).toBe(2);
    expect(textSize(w, [TX, "2026-07-01T00:00:00Z"])).toBe(30);
  });

  it("applies both bounds, and binds them in the order the caller pushes them", () => {
    // The caller appends start then end to its params array. If the two
    // clauses were emitted in the other order the bounds would swap and this
    // would return 0 rows, not merely a different count.
    const w = { hasStart: true, hasEnd: true };
    const params = [TX, "2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z"];
    expect(textCount(w, params)).toBe(1);
    expect(textSize(w, params)).toBe(20);
  });
});

describe("prepareTextAttachmentSize / prepareEmailAttachmentSize", () => {
  it("returns 0 rather than NULL when nothing matches", () => {
    // COALESCE(SUM(...), 0). The caller ADDS the two totals, so a NULL here
    // would make the sum NULL in SQL and NaN after the cast.
    expect(textSize()).toBe(0);
    const emailTotal = (
      prepareEmailAttachmentSize(q, NO_WINDOW).get(TX) as { total_size: number }
    ).total_size;
    expect(emailTotal).toBe(0);
  });
});

describe("prepareEmailAttachmentCount", () => {
  it("counts email attachments linked to the transaction, and no text ones", () => {
    db.prepare(
      `INSERT INTO emails (id, user_id, sent_at, subject) VALUES ('e1', ?, '2026-06-01T00:00:00Z', 's')`,
    ).run(USER);
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, file_size_bytes, storage_path)
       VALUES ('ae1', 'e1', 'e.pdf', 500, '/tmp/e.pdf')`,
    ).run();
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source)
       VALUES ('ce1', ?, ?, 'e1', 'auto')`,
    ).run(USER, TX);

    // A text attachment that must NOT show up in the email counter.
    addMessage("m1", "2026-06-01T10:00:00Z", null);
    addTextAttachment("a1", "m1", 100);
    linkMessage("c1", "m1");

    const n = (prepareEmailAttachmentCount(q, NO_WINDOW).get(TX) as { count: number }).count;
    expect(n).toBe(1);
    expect(textCount()).toBe(1);
  });
});

describe("EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL", () => {
  const addEmail = (
    id: string,
    opts: { hasAttachments?: number; externalId?: string | null; source?: string | null } = {},
  ): void => {
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, has_attachments, subject)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      USER,
      opts.externalId === undefined ? `ext-${id}` : opts.externalId,
      opts.source === undefined ? "gmail" : opts.source,
      opts.hasAttachments === undefined ? 1 : opts.hasAttachments,
      `subject ${id}`,
    );
  };

  it("selects exactly the emails that need a fetch, one case per predicate", () => {
    addEmail("e-wanted");
    addEmail("e-no-flag", { hasAttachments: 0 });
    addEmail("e-null-external", { externalId: null });
    addEmail("e-null-source", { source: null });
    addEmail("e-already");
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename) VALUES ('a-x', 'e-already', 'x.pdf')`,
    ).run();

    const ids = (
      db.prepare(EMAILS_MISSING_ATTACHMENTS_FOR_USER_SQL).all(USER) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(ids.sort()).toEqual(["e-wanted"]);
  });
});
