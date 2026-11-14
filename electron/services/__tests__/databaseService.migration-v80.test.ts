/**
 * @jest-environment node
 *
 * BACKLOG-4212 PR2 — migration v80 (Learn sender snapshot + sender overrides),
 * on the real driver. The pre-v80 table is the learn bulk-answer DDL
 * TRANSCRIBED from electron/database/schema.sql at int-portal/release-2.49
 * d0964133f (v79). Cached mail is written with the sync's own insert
 * (helpers/storedEmail-4175). Synthetic reserved domains only.
 *
 *   V80a  live answered rows get the normalised From address of their cached
 *         message; uncached, unanswered, soft-removed rows stay NULL; the lookup
 *         is per user and per provider
 *   V80b  the overrides table exists with one live row per (user, sender)
 *   V80c  re-runnable (run twice = same rows), and a no-op on a fresh install,
 *         whose columns match the upgraded ones
 *   V80d  v80 follows v79 and the chain has no gap
 *   V80e  the migration log carries counts only
 */
import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/tmp/unset-4212"),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: jest.fn(),
  },
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }) },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

import { hostLogger } from "../../capabilities/loggerProvider";
import { gmailFrom, insertStoredEmail, outlookFrom } from "./helpers/storedEmail-4175";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

/** git show d0964133f:electron/database/schema.sql (the learn bulk-answer table, pre-v80). */
const PRE_V80_DDL = `CREATE TABLE IF NOT EXISTS learn_bulk_answers (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('gmail', 'outlook')),
  external_id  TEXT NOT NULL,
  sampled_at   TEXT NOT NULL,
  answer       TEXT CHECK (answer IS NULL OR answer IN ('real_estate', 'newsletter_spam', 'skip')),
  answered_at  TEXT,
  rule_version INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learn_bulk_answers_user_msg_live
  ON learn_bulk_answers(user_id, source, external_id) WHERE deleted_at IS NULL;`;

type Migrate = (d: DatabaseType) => void;
type Chain = Array<{ version: number; migrate: Migrate }>;

function svcClass(): { MIGRATIONS: Chain; validateNoVersionGaps: (m: Chain) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  return svc.constructor;
}
function v80(): Migrate {
  const e = svcClass().MIGRATIONS.find((m) => m.version === 80);
  if (!e) throw new Error("v80 is not in DatabaseService.MIGRATIONS");
  return e.migrate;
}
const USER = "user-4212-v80";
const OTHER = "user-4212-v80-other";
const cols = (db: DatabaseType) =>
  (db.prepare(`PRAGMA table_info(learn_bulk_answers)`).all() as Array<{ name: string }>).map((c) => c.name);
const tableExists = (db: DatabaseType, name: string) =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

function sample(
  db: DatabaseType,
  id: string,
  user: string,
  source: "gmail" | "outlook",
  externalId: string,
  answer: string | null,
  deletedAt: string | null = null,
): void {
  db.prepare(
    `INSERT INTO learn_bulk_answers (id, user_id, source, external_id, sampled_at, answer, answered_at, rule_version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, '2026-11-01T00:00:00Z', ?, ?, 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', ?)`,
  ).run(id, user, source, externalId, answer, answer === null ? null : "2026-11-02T00:00:00Z", deletedAt);
}

function cached(db: DatabaseType, id: string, user: string, sender: string, source: "gmail" | "outlook" = "gmail"): void {
  insertStoredEmail(db, {
    id,
    userId: user,
    sender,
    subject: "Weekly digest",
    bodyPlain: "Weekly digest",
    sentAt: "2026-10-01T15:00:00.000Z",
    source,
  });
}

/** A v79 database: the current schema with the learn bulk-answer table as it was, and no overrides table. */
function preV80Db(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(SCHEMA);
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE learn_sender_overrides");
  db.exec("DROP TABLE learn_bulk_answers");
  db.exec(PRE_V80_DDL);
  db.pragma("foreign_keys = ON");
  const user = db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`);
  user.run(USER, "v80@example.test", "oa-v80");
  user.run(OTHER, "v80b@example.test", "oa-v80b");

  cached(db, "e-g", USER, gmailFrom("Digest", "News@Mail.Example"));
  cached(db, "e-o", USER, outlookFrom("Shop", "deals@shop.example"), "outlook");
  cached(db, "e-other", OTHER, gmailFrom("Theirs", "theirs@other.example"));
  // e-g: ext-e-g gmail; e-o: ext-e-o outlook; e-other: ext-e-other (OTHER's mailbox)
  sample(db, "b-gmail", USER, "gmail", "ext-e-g", "newsletter_spam");
  sample(db, "b-outlook", USER, "outlook", "ext-e-o", "real_estate");
  sample(db, "b-uncached", USER, "gmail", "ext-gone", "newsletter_spam");
  sample(db, "b-unanswered", USER, "gmail", "ext-e-g-2", null);
  sample(db, "b-deleted", USER, "gmail", "ext-e-g", "newsletter_spam", "2026-11-03T00:00:00Z");
  // Same provider id as OTHER's cached message, but this user's row: must not read OTHER's mail.
  sample(db, "b-cross-user", USER, "gmail", "ext-e-other", "skip");
  // Same provider id as this user's gmail message, other provider: must not match.
  sample(db, "b-cross-source", USER, "outlook", "ext-e-g", "skip");
  return db;
}

const keys = (db: DatabaseType) =>
  Object.fromEntries(
    (db.prepare(`SELECT id, sender_key FROM learn_bulk_answers ORDER BY id`).all() as Array<{ id: string; sender_key: string | null }>).map(
      (r) => [r.id, r.sender_key],
    ),
  );

const EXPECTED = {
  "b-cross-source": null,
  "b-cross-user": null,
  "b-deleted": null,
  "b-gmail": "news@mail.example",
  "b-outlook": "deals@shop.example",
  "b-unanswered": null,
  "b-uncached": null,
};

describe("v80 Learn sender snapshot + overrides", () => {
  it("V80a backfills live answered rows from their own cached message", () => {
    const db = preV80Db();
    expect(cols(db)).not.toContain("sender_key");
    expect(tableExists(db, "learn_sender_overrides")).toBe(false);
    db.transaction(() => v80()(db))();
    expect(cols(db)).toContain("sender_key");
    expect(keys(db)).toEqual(EXPECTED);
    db.close();
  });

  it("V80b the overrides table: one live row per (user, sender)", () => {
    const db = preV80Db();
    v80()(db);
    const ins = db.prepare(
      `INSERT INTO learn_sender_overrides (id, user_id, sender_key, created_at, updated_at, deleted_at) VALUES (?, ?, 'news@mail.example', 'x', 'x', ?)`,
    );
    ins.run("o-1", USER, "2026-11-04T00:00:00Z");
    ins.run("o-2", USER, null);
    expect(() => ins.run("o-3", USER, null)).toThrow(/UNIQUE/);
    expect(() => ins.run("o-4", OTHER, null)).not.toThrow();
    db.close();
  });

  it("V80c re-runnable; a no-op on a fresh install, whose columns match the upgraded ones", () => {
    const db = preV80Db();
    v80()(db);
    db.prepare(`INSERT INTO learn_sender_overrides (id, user_id, sender_key, created_at, updated_at) VALUES ('o-1', ?, 'a@b.example', 'x', 'x')`).run(USER);
    expect(() => v80()(db)).not.toThrow();
    expect(keys(db)).toEqual(EXPECTED);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM learn_sender_overrides`).get() as { n: number }).n).toBe(1);

    const fresh = new RealDatabase(":memory:") as DatabaseType;
    fresh.exec(SCHEMA);
    expect(() => v80()(fresh)).not.toThrow();
    expect([...cols(fresh)].sort()).toEqual([...cols(db)].sort());
    const ovCols = (d: DatabaseType) =>
      (d.prepare(`PRAGMA table_info(learn_sender_overrides)`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>).map(
        (c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`,
      );
    expect(ovCols(fresh)).toEqual(ovCols(db));
    const idx = (d: DatabaseType) =>
      d.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_learn_sender_overrides_user_sender_live'`).get() as { sql: string } | undefined;
    expect(idx(db)?.sql.replace(/\s+/g, " ")).toBe(idx(fresh)?.sql.replace(/\s+/g, " "));
    db.close();
    fresh.close();
  });

  it("V80d v80 follows v79 and the chain has no gap", () => {
    const cls = svcClass();
    const versions = cls.MIGRATIONS.map((m) => m.version);
    expect(versions.indexOf(80)).toBe(versions.indexOf(79) + 1);
    expect(() => cls.validateNoVersionGaps(cls.MIGRATIONS)).not.toThrow();
  });

  it("V80e the log carries counts only", () => {
    const spy = jest.spyOn(hostLogger, "info").mockImplementation(() => undefined);
    const db = preV80Db();
    v80()(db);
    const lines = spy.mock.calls.map((c) => JSON.stringify(c));
    expect(lines.some((l) => l.includes("[v80]"))).toBe(true);
    expect(lines.join("\n")).not.toContain("@");
    expect(lines.join("\n")).toContain("2 of 5");
    spy.mockRestore();
    db.close();
  });
});
