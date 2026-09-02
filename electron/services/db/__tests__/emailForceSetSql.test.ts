/**
 * Pins for `db/emailForceSetSql` — BACKLOG-2989 commit A2.
 *
 * The predicate stopped travelling as text, so these assert what it MEANS
 * rather than what it says. Schema: `electron/database/schema.sql`, whole.
 *
 * The NULL-safety case is the one to read first. It is not defensive coding —
 * it is the difference between a re-cache that rebuilds the corpus and one that
 * silently stages a duplicate of every row it should have left alone.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  assertRebuildableProviders,
  deleteLiveForceSet,
  emailForceReadView,
  type EmailForceSet,
} from "../emailForceSetSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-force";
const OTHER = "user-2989-force-other";
const SINCE = "2026-01-01T00:00:00Z";

const SET: EmailForceSet = {
  userId: USER,
  providers: ["gmail", "outlook"],
  cacheSinceIso: SINCE,
};

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addUser = (id: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, `${id}@example.test`, `oauth-${id}`);
};

const addEmail = (
  id: string,
  opts: {
    userId?: string;
    source?: string | null;
    externalId?: string | null;
    sentAt?: string | null;
  } = {},
): void => {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, sent_at, subject)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId ?? USER,
    opts.externalId === undefined ? `ext-${id}` : opts.externalId,
    opts.source === undefined ? "gmail" : opts.source,
    opts.sentAt === undefined ? "2026-06-01T00:00:00Z" : opts.sentAt,
    `subject ${id}`,
  );
};

const liveIds = (): string[] =>
  (db.prepare("SELECT id FROM emails ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-force-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  addUser(USER);
  addUser(OTHER);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("assertRebuildableProviders", () => {
  it("refuses an unknown source rather than guessing", () => {
    expect(() =>
      assertRebuildableProviders(["gmail", "imap" as never]),
    ).toThrow(/unknown source "imap"/);
  });

  it("refuses an empty set — a predicate matching nothing is not a safe force set", () => {
    expect(() => assertRebuildableProviders([])).toThrow(/no rebuildable provider/);
  });

  it("guards the DELETE too, not just the constructor", () => {
    // The guard travels with the construction it protects, so a set that got
    // past the constructor by any route still cannot reach the SQL.
    expect(() =>
      deleteLiveForceSet(db as never, { ...SET, providers: ["pop3" as never] }),
    ).toThrow(/unknown source/);
  });
});

describe("deleteLiveForceSet — the ROW READ BACK, one case per predicate arm", () => {
  it("deletes exactly the force set and leaves every survivor in place", () => {
    addEmail("in-gmail");
    addEmail("in-outlook", { source: "outlook" });

    addEmail("keep-other-user", { userId: OTHER });
    addEmail("keep-null-external", { externalId: null });
    addEmail("keep-too-old", { sentAt: "2025-06-01T00:00:00Z" });

    const deleted = deleteLiveForceSet(db as never, SET);

    expect(deleted).toBe(2);
    // Identity, not a count: three different bugs give a survivor count of 3.
    expect(liveIds()).toEqual(["keep-null-external", "keep-other-user", "keep-too-old"]);
  });

  it("leaves a row whose source is not in the rebuilt provider list", () => {
    // Allow-list, not deny-list: a user who disconnected Outlook and clicks
    // Re-cache must not lose their Outlook mail.
    addEmail("gmail-row");
    addEmail("outlook-row", { source: "outlook" });

    deleteLiveForceSet(db as never, { ...SET, providers: ["gmail"] });

    expect(liveIds()).toEqual(["outlook-row"]);
  });

  it("leaves rows with a NULL source or NULL sent_at — the unrecognised row survives", () => {
    addEmail("null-source", { source: null });
    addEmail("null-sent", { sentAt: null });
    addEmail("deleted-me");

    expect(deleteLiveForceSet(db as never, SET)).toBe(1);
    expect(liveIds()).toEqual(["null-sent", "null-source"]);
  });
});

describe("emailForceReadView — live survivors UNION what this run staged", () => {
  const STAGING = "staging_emailrecache_deadbeefcafe_emails";

  beforeEach(() => {
    db.exec(`CREATE TABLE "${STAGING}" (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, source TEXT, sent_at TEXT)`);
  });

  it("returns survivors plus staged rows, and NOT the live rows being replaced", () => {
    addEmail("live-in-force-set");
    addEmail("live-survivor", { sentAt: "2025-01-01T00:00:00Z" });
    db.prepare(`INSERT INTO "${STAGING}" (id, user_id, source, sent_at) VALUES ('staged-1', ?, 'gmail', '2026-06-02T00:00:00Z')`).run(USER);

    const view = emailForceReadView(SET, STAGING, "id");
    const rows = (
      db.prepare(`SELECT id FROM ${view.sql} ORDER BY id`).all(...view.params) as Array<{
        id: string;
      }>
    ).map((r) => r.id);

    expect(rows).toEqual(["live-survivor", "staged-1"]);
  });

  it("NULL-SAFE: a row with a NULL source counts as a survivor, not as nothing", () => {
    /**
     * This is the case `COALESCE(..., 0) = 0` exists for, and the reason it is
     * spelled out by hand rather than written `NOT (...)`.
     *
     * `source` is nullable past its CHECK and `sent_at` is nullable outright, so
     * the force predicate can evaluate to NULL. Under a plain `NOT (...)` that
     * row is NULL — so it SURVIVES the DELETE (correct; a DELETE removes a row
     * only when its WHERE is TRUE) and then DROPS OUT of this survivor read
     * (wrong). A row that survives but is invisible to the rebuild's dedup gets
     * staged a second time, and the swap inserts a duplicate of a row the user
     * still had.
     */
    addEmail("null-source-survivor", { source: null });

    const view = emailForceReadView(SET, STAGING, "id");
    const rows = (
      db.prepare(`SELECT id FROM ${view.sql}`).all(...view.params) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(rows).toEqual(["null-source-survivor"]);
    // And the DELETE agrees it survived — the two must not disagree.
    expect(deleteLiveForceSet(db as never, SET)).toBe(0);
  });

  it("binds the same parameters the predicate needs, in order", () => {
    expect(emailForceReadView(SET, STAGING, "id").params).toEqual([USER, SINCE]);
  });
});
