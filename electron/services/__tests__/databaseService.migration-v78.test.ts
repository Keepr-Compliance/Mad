/**
 * @jest-environment node
 *
 * BACKLOG-3968 PR-4a — migration v78 (checklist links to texts), against the
 * REAL driver (SR plan review c4cae33e R9: required by absolute path, and the
 * SQLite version asserted, because jest.config.js maps the bare module name to
 * a mock that enforces no CHECK, UNIQUE or FK).
 *
 * v78 rebuilds `transaction_checklist_links` (kind CHECK gains 'text') and
 * `transaction_checklist_link_members` (gains `message_id` -> messages(id),
 * a third arm in the exactly-one-member CHECK, UNIQUE (link_id, message_id)),
 * recreates their indexes and the empty-group trigger, and adds the partial
 * index on message_id on every database.
 *
 * THE OLD-SHAPE FIXTURE. The current schema.sql is exec'd, then the two link
 * tables are dropped (foreign_keys OFF) and recreated from the DDL below —
 * pasted verbatim from `electron/database/schema.sql` at `50def3cce` (the
 * int/desktop-redesign head this PR branches from, schema v77). The parent
 * tables are unchanged by v78, so this is the database a v77 profile holds.
 *
 * Run under Electron's node locally (the shared native module is Electron-ABI):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/databaseService.migration-v78.test.ts --bail=0
 *
 * EVERY FIXTURE ROW IS SYNTHETIC. This repo is public.
 */

import fs from "fs";
import os from "os";
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

let userDataDir = "/tmp/unset-3968";
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
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
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
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

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

/** The two link tables, their indexes and the trigger, verbatim from schema.sql at 50def3cce. */
const V77_LINK_TABLES_DDL_50DEF3CCE = `CREATE TABLE IF NOT EXISTS transaction_checklist_links (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('attachment', 'email')),
  label      TEXT NOT NULL CHECK (length(trim(label)) >= 1),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- BACKLOG-3764 (migration v75 adds it to existing databases): 1 when the
  -- agent chose to send this group although its evidence is dated outside the
  -- deal's audit dates. No index/trigger/view may name it here (see v75).
  include_outside_dates INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, kind),
  FOREIGN KEY (item_id) REFERENCES transaction_checklist_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checklist_links_item
  ON transaction_checklist_links(item_id);

CREATE TABLE IF NOT EXISTS transaction_checklist_link_members (
  id            TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  attachment_id TEXT,
  email_id      TEXT,
  CHECK ((kind = 'attachment' AND attachment_id IS NOT NULL AND email_id IS NULL)
      OR (kind = 'email' AND email_id IS NOT NULL AND attachment_id IS NULL)),
  UNIQUE (link_id, attachment_id),
  UNIQUE (link_id, email_id),
  FOREIGN KEY (link_id, kind) REFERENCES transaction_checklist_links(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checklist_members_attachment
  ON transaction_checklist_link_members(attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_members_email
  ON transaction_checklist_link_members(email_id) WHERE email_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_checklist_link_members_drop_empty_link
AFTER DELETE ON transaction_checklist_link_members
WHEN NOT EXISTS (SELECT 1 FROM transaction_checklist_link_members m WHERE m.link_id = OLD.link_id)
BEGIN
  DELETE FROM transaction_checklist_links WHERE id = OLD.link_id;
END;`;

const USER = "user-3968-v78";

type Migrate = (d: DatabaseType) => void;
type Chain = Array<{ version: number; migrate: Migrate }>;

function chain(): Chain {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  return (svc.constructor as { MIGRATIONS: Chain }).MIGRATIONS;
}

function v78(): Migrate {
  const entry = chain().find((m) => m.version === 78);
  if (!entry) throw new Error("v78 is not in DatabaseService.MIGRATIONS");
  return entry.migrate;
}

function freshDb(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(SCHEMA);
  db.pragma("foreign_keys = ON");
  return db;
}

/** A database whose two link tables have the v77 shape. */
function v77Db(): DatabaseType {
  const db = freshDb();
  db.pragma("foreign_keys = OFF");
  db.exec("DROP TABLE transaction_checklist_link_members");
  db.exec("DROP TABLE transaction_checklist_links");
  db.exec(V77_LINK_TABLES_DDL_50DEF3CCE);
  db.pragma("foreign_keys = ON");
  return db;
}

/** Run v78 exactly as the runner does: foreign_keys OFF, one transaction. */
function runV78(db: DatabaseType, migrate: Migrate = v78()): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const run = (db: DatabaseType, q: string, ...p: unknown[]) => db.prepare(q).run(...(p as never[]));
const all = (db: DatabaseType, q: string) => db.prepare(q).all();

/**
 * One deal, one checklist item, and three groups: an email link, an
 * attachment link and a flagged (include_outside_dates = 1) email link with
 * two members. One text message on the deal, for the text arm.
 */
function seed(db: DatabaseType): void {
  run(db, `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'synthetic@example.test', 'google', 'oid-3968')`, USER);
  run(db, `INSERT INTO transactions (id, user_id, property_address) VALUES ('tx1', ?, '1 Test Road')`, USER);
  for (const [id, at] of [["e1", "2026-03-01T10:00:00Z"], ["e2", "2026-03-02T10:00:00Z"], ["e3", "2026-03-03T10:00:00Z"]]) {
    run(
      db,
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at)
       VALUES (?, ?, ?, 'outlook', 'acct', 'Offer', 's@example.test', 'me@example.test', ?)`,
      id, USER, `ext-${id}`, at,
    );
  }
  run(db, `INSERT INTO attachments (id, email_id, filename) VALUES ('a1', 'e1', 'offer.pdf')`);
  run(db, `INSERT INTO messages (id, user_id, channel, external_id, body_text, sent_at, thread_id)
           VALUES ('msg1', ?, 'imessage', 'guid-1', 'Signed', '2026-03-04T10:00:00Z', 'th-1')`, USER);
  run(db, `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', 'tx1', 'tpl-a', 'Listing')`);
  run(db, `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES ('i1', 'c1', 'Offer received', 1)`);
  run(db, `INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order, created_at)
           VALUES ('l-email', 'i1', 'email', 'Offer', 0, '2026-09-01 10:00:00')`);
  run(db, `INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order, created_at)
           VALUES ('l-att', 'i1', 'attachment', 'offer.pdf', 1, '2026-09-01 10:01:00')`);
  run(db, `INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order, created_at, include_outside_dates)
           VALUES ('l-flag', 'i1', 'email', 'Old thread', 2, '2026-09-01 10:02:00', 1)`);
  run(db, `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('m1', 'l-email', 'email', 'e1')`);
  run(db, `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('m2', 'l-att', 'attachment', 'a1')`);
  run(db, `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('m3', 'l-flag', 'email', 'e2')`);
  run(db, `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('m4', 'l-flag', 'email', 'e3')`);
}

const LINKS_SQL =
  "SELECT id, item_id, kind, label, sort_order, created_at, include_outside_dates FROM transaction_checklist_links ORDER BY id";
const MEMBERS_SQL =
  "SELECT id, link_id, kind, attachment_id, email_id FROM transaction_checklist_link_members ORDER BY id";

/**
 * The stored DDL of everything on the two link tables, normalised only for
 * what a rebuild changes and SQLite ignores: the quoting RENAME adds and
 * whitespace. CHECKs, comments, column order and constraints all stay in.
 */
function linkTablesDdl(db: DatabaseType): Array<{ type: string; name: string; sql: string }> {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE tbl_name IN ('transaction_checklist_links', 'transaction_checklist_link_members')
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  return rows.map((r) => ({
    type: r.type,
    name: r.name,
    sql: (r.sql ?? "")
      .replace(/IF NOT EXISTS /g, "")
      .replace(/"(transaction_checklist_links|transaction_checklist_link_members)"/g, "$1")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

describe("migration v78 — BACKLOG-3968 checklist links to texts", () => {
  let db: DatabaseType;
  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it("sanity: the REAL driver (a CHECK fires) at a known SQLite version", () => {
    db = freshDb();
    const { v } = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    expect(v).toMatch(/^3\.\d+\.\d+$/);
    expect(() => run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('x', 'y', 'fax', 'z')")).toThrow(
      /CHECK constraint failed/,
    );
  });

  it("R1: the chain runs 1 by 1 from its first version to its last, with v78 after v77", () => {
    const versions = chain().map((m) => m.version);
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBe(versions[i - 1] + 1);
    expect(versions.indexOf(78)).toBe(versions.indexOf(77) + 1);
  });

  it("PRECONDITION: the v77 fixture refuses a 'text' link and has no message_id", () => {
    db = v77Db();
    seed(db);
    expect(() =>
      run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-text', 'i1', 'text', 'A text')"),
    ).toThrow(/CHECK constraint failed/);
    const cols = (all(db, "PRAGMA table_info(transaction_checklist_link_members)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("message_id");
  });

  it("C13a: every existing link and member survives with its id, kind, label, order, date and flag", () => {
    db = v77Db();
    seed(db);
    const linksBefore = all(db, LINKS_SQL);
    const membersBefore = all(db, MEMBERS_SQL);
    expect(linksBefore).toHaveLength(3);
    expect(membersBefore).toHaveLength(4);
    runV78(db);
    expect(all(db, LINKS_SQL)).toEqual(linksBefore);
    expect(all(db, MEMBERS_SQL)).toEqual(membersBefore);
    expect(all(db, "SELECT DISTINCT message_id FROM transaction_checklist_link_members")).toEqual([{ message_id: null }]);
    expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("C13b: after v78 a 'text' link with a text member is accepted; 'fax' still is not", () => {
    db = v77Db();
    seed(db);
    runV78(db);
    run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-text', 'i1', 'text', 'A text')");
    run(db, "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES ('m-t', 'l-text', 'text', 'msg1')");
    expect(all(db, "SELECT kind, message_id FROM transaction_checklist_link_members WHERE id = 'm-t'")).toEqual([
      { kind: "text", message_id: "msg1" },
    ]);
    expect(() =>
      run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-fax', 'i1', 'fax', 'x')"),
    ).toThrow(/CHECK constraint failed/);
  });

  it.each([
    ["upgraded", () => { const d = v77Db(); seed(d); runV78(d); return d; }],
    ["fresh", () => { const d = freshDb(); seed(d); runV78(d); return d; }],
  ])("C13c (%s): exactly one member column — two set, or the wrong one, is refused", (_label, make) => {
    db = make();
    run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-text', 'i1', 'text', 'A text')");
    const bad: Array<[string, string, string]> = [
      ["text + email", "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id, email_id) VALUES ('b1', 'l-text', 'text', 'msg1', 'e1')", ""],
      ["text + attachment", "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id, attachment_id) VALUES ('b2', 'l-text', 'text', 'msg1', 'a1')", ""],
      ["text with no message", "INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES ('b3', 'l-text', 'text', 'e1')", ""],
      ["email + message", "INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id, message_id) VALUES ('b4', 'l-email', 'email', 'e2', 'msg1')", ""],
      ["attachment + message", "INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id, message_id) VALUES ('b5', 'l-att', 'attachment', 'a1', 'msg1')", ""],
    ];
    for (const [name, statement] of bad) {
      expect({ name, threw: (() => { try { run(db, statement); return "no"; } catch (e) { return String((e as Error).message); } })() })
        .toEqual({ name, threw: expect.stringMatching(/CHECK constraint failed/) });
    }
    // The same text twice in one group is refused too.
    run(db, "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES ('ok1', 'l-text', 'text', 'msg1')");
    expect(() =>
      run(db, "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES ('ok2', 'l-text', 'text', 'msg1')"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("C13d: a deleted text takes its member with it, and the trigger removes the emptied group", () => {
    db = v77Db();
    seed(db);
    runV78(db);
    run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-text', 'i1', 'text', 'A text')");
    run(db, "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES ('m-t', 'l-text', 'text', 'msg1')");
    run(db, "DELETE FROM messages WHERE id = 'msg1'");
    expect(all(db, "SELECT id FROM transaction_checklist_link_members WHERE id = 'm-t'")).toEqual([]);
    expect(all(db, "SELECT id FROM transaction_checklist_links WHERE id = 'l-text'")).toEqual([]);
    // The old cascades still work through the rebuilt tables.
    run(db, "DELETE FROM emails WHERE id = 'e1'");
    expect(all(db, "SELECT id FROM transaction_checklist_links WHERE id = 'l-email'")).toEqual([]);
    run(db, "DELETE FROM transaction_checklist_items WHERE id = 'i1'");
    expect(all(db, "SELECT COUNT(*) AS n FROM transaction_checklist_link_members")).toEqual([{ n: 0 }]);
    expect(all(db, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("C13e: the upgraded tables, indexes and trigger are stored exactly as a fresh install's (schema.sql + v78)", () => {
    const fresh = freshDb();
    runV78(fresh);
    const expected = linkTablesDdl(fresh);
    fresh.close();
    db = v77Db();
    seed(db);
    runV78(db);
    expect(linkTablesDdl(db)).toEqual(expected);
    expect(expected.map((r) => r.name)).toEqual(
      expect.arrayContaining(["idx_checklist_members_message", "trg_checklist_link_members_drop_empty_link"]),
    );
  });

  it("C13f: running v78 twice equals running it once; a fresh database is not rebuilt", () => {
    db = v77Db();
    seed(db);
    runV78(db);
    const once = linkTablesDdl(db);
    runV78(db);
    expect(linkTablesDdl(db)).toEqual(once);
    db.close();

    db = freshDb();
    const execs: string[] = [];
    const real = v78();
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "exec") {
          return (sqlText: string) => {
            execs.push(sqlText);
            return target.exec(sqlText);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    runV78(db, () => real(spy as DatabaseType));
    expect(execs.some((s) => /CREATE TABLE|DROP TABLE/.test(s))).toBe(false);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function loadService(): AnyService {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../databaseService").default;
}

describe("migration v78 — a v77 database on the REAL upgrade path (schema.sql exec, then the chain)", () => {
  jest.setTimeout(120000);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3968-v78-"));
    userDataDir = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("C13g: a v77 database with links opens, keeps them, takes a text link and lands at the head", async () => {
    const first = loadService();
    await expect(first.initialize()).resolves.toBe(true);
    const firstDb = first.db as DatabaseType;
    firstDb.pragma("foreign_keys = OFF");
    firstDb.exec(`DROP TABLE transaction_checklist_link_members; DROP TABLE transaction_checklist_links;`);
    firstDb.exec(V77_LINK_TABLES_DDL_50DEF3CCE);
    firstDb.pragma("foreign_keys = ON");
    firstDb.prepare("UPDATE schema_version SET version = 77 WHERE id = 1").run();
    seed(firstDb);
    const linksBefore = all(firstDb, LINKS_SQL);
    const membersBefore = all(firstDb, MEMBERS_SQL);
    // PRECONDITION: the v77 shape.
    const colsBefore = (all(firstDb, "PRAGMA table_info(transaction_checklist_link_members)") as Array<{ name: string }>).map((c) => c.name);
    expect(colsBefore).not.toContain("message_id");
    await first.close();

    const second = loadService();
    await expect(second.initialize()).resolves.toBe(true);
    const db = second.db as DatabaseType;
    const head = (second.constructor as { MIGRATIONS: Array<{ version: number }> }).MIGRATIONS.at(-1)!.version;
    expect(head).toBeGreaterThanOrEqual(78);
    expect((db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version).toBe(head);
    expect(all(db, LINKS_SQL)).toEqual(linksBefore);
    expect(all(db, MEMBERS_SQL)).toEqual(membersBefore);
    expect(all(db, "SELECT name FROM sqlite_master WHERE name = 'idx_checklist_members_message'")).toHaveLength(1);
    run(db, "INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('l-text', 'i1', 'text', 'A text')");
    run(db, "INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES ('m-t', 'l-text', 'text', 'msg1')");
    await second.close();
  });
});
