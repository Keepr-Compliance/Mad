/**
 * @jest-environment node
 *
 * BACKLOG-2790 — the two structural claims stage-and-swap rests on, each
 * checked against a REAL sqlite database rather than by reading the SQL.
 *
 *   1. the "what survived the clear" predicate is NULL-safe, so email
 *      attachments stay visible to the rebuild's dedup reads;
 *   2. a derived staging table carries the live table's column DEFAULTS and
 *      does NOT carry its foreign keys.
 *
 * Both are the kind of claim that a comment can assert and a green suite can
 * fail to notice: the first is invisible until a user has both email and
 * iMessage attachments, and the second only bites at the moment the swap runs.
 */

import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import {
  deriveStagingTableDdl,
  forceStagingLifecycle,
  sweepStaleStaging,
  STAGING_TABLE_PREFIX,
  SURVIVING_ATTACHMENTS,
  SURVIVING_MESSAGES,
} from "../macOSMessagesImportService/forceStaging";

const USER = "user-2790";

let db: DatabaseType;

/**
 * The real shapes, reduced to the columns these claims turn on. Transcribed
 * from `electron/database/schema.sql`: `messages` keys the force set on
 * (user_id, external_id); `attachments` is shared with email, which is why
 * `message_id` and `external_message_id` are both nullable and why
 * `has_attachments`/`is_false_positive` carry non-NULL defaults.
 */
function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);
    CREATE TABLE emails (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      external_id TEXT,
      body_text TEXT,
      has_attachments INTEGER DEFAULT 0,
      is_false_positive INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      email_id TEXT,
      external_message_id TEXT,
      filename TEXT NOT NULL,
      storage_path TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
      CHECK (message_id IS NOT NULL OR email_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX idx_messages_user_external_id
      ON messages(user_id, external_id) WHERE external_id IS NOT NULL;
  `);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createSchema(db);
  db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER);
  db.prepare("INSERT INTO emails (id) VALUES (?)").run("email-1");
});

afterEach(() => {
  db?.close();
});

describe("BACKLOG-2790 — what a force re-import does NOT replace", () => {
  beforeEach(() => {
    // One iMessage, one email, and their attachments.
    db.prepare(
      "INSERT INTO messages (id, user_id, external_id) VALUES (?, ?, ?)"
    ).run("msg-imessage", USER, "guid-1");
    db.prepare(
      "INSERT INTO messages (id, user_id, external_id) VALUES (?, ?, NULL)"
    ).run("msg-no-external", USER);
    db.prepare(
      `INSERT INTO attachments (id, message_id, external_message_id, filename, storage_path)
       VALUES (?, ?, ?, ?, ?)`
    ).run("att-imessage", "msg-imessage", "guid-1", "photo.jpg", "/store/aaa.jpg");
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, storage_path) VALUES (?, ?, ?, ?)`
    ).run("att-email", "email-1", "contract.pdf", "/store/bbb.pdf");
  });

  it("keeps EMAIL attachments visible — the predicate is NULL-safe", async () => {
    // THE CLAIM: `message_id IN (…)` evaluates to NULL, not false, when
    // `message_id` is NULL — which is every email attachment, since they carry
    // `email_id` instead. Written the obvious way, as `NOT (a OR b)`, the whole
    // expression is NULL for those rows and SQLite drops them.
    //
    // THE CONSEQUENCE if it were wrong: the rebuild's content-hash dedup would
    // stop seeing files copied for emails, so a force re-import would re-copy
    // every attachment an email had already brought in — silently, and only for
    // users who have both kinds.
    //
    // MUTATION: replace SURVIVING_ATTACHMENTS with
    // `NOT (${FORCE_SET_ATTACHMENTS_BY_MESSAGE_ID} OR ${FORCE_SET_ATTACHMENTS_BY_EXTERNAL_ID})`
    // and this goes red — the email attachment vanishes from the result.
    const survivors = (
      db
        .prepare(`SELECT id FROM attachments WHERE ${SURVIVING_ATTACHMENTS}`)
        .all({ userId: USER }) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(survivors).toEqual(["att-email"]);
  });

  it("keeps messages that carry no external_id", async () => {
    const survivors = (
      db
        .prepare(`SELECT id FROM messages WHERE ${SURVIVING_MESSAGES}`)
        .all({ userId: USER }) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(survivors).toEqual(["msg-no-external"]);
  });

  it("CONTROL: the rows it DOES replace are exactly the macOS ones", async () => {
    // The other half. Without it, a predicate that matched nothing at all would
    // pass both tests above.
    const replaced = (
      db
        .prepare(`SELECT id FROM messages WHERE NOT (${SURVIVING_MESSAGES})`)
        .all({ userId: USER }) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(replaced).toEqual(["msg-imessage"]);
  });
});

describe("BACKLOG-2790 — a derived staging table", () => {
  it("carries the live table's column DEFAULTS", async () => {
    // THE CLAIM: this is why the DDL is derived from `sqlite_master` instead of
    // being built with `CREATE TABLE … AS SELECT * … WHERE 0`. The import's
    // INSERT names sixteen of `messages`' forty columns and lets the table
    // supply the rest, so a staging table without defaults would store NULL
    // where live stores 0 — and the swap would carry those NULLs into live,
    // where nothing would ever report them.
    const staging = forceStagingLifecycle.create(db, USER);

    db.prepare(
      `INSERT INTO "${staging.messagesTable}" (id, user_id, external_id) VALUES (?, ?, ?)`
    ).run("staged-1", USER, "guid-9");

    const row = db
      .prepare(`SELECT has_attachments, is_false_positive, created_at FROM "${staging.messagesTable}"`)
      .get() as { has_attachments: number; is_false_positive: number; created_at: string | null };

    expect(row.has_attachments).toBe(0);
    expect(row.is_false_positive).toBe(0);
    expect(row.created_at).not.toBeNull();

    staging.drop();
  });

  it("does NOT carry foreign keys — they belong to the swap's destination", async () => {
    // THE CLAIM: copied verbatim under `foreign_keys = ON`, `attachments`'
    // `REFERENCES messages(id)` would reject every staging insert, because the
    // row it points at is in the staging messages table and not in live. The
    // constraint is not weakened, only moved to where the real rows land: the
    // swap inserts into LIVE, where it applies to the real final state.
    const staging = forceStagingLifecycle.create(db, USER);

    db.prepare(
      `INSERT INTO "${staging.messagesTable}" (id, user_id, external_id) VALUES (?, ?, ?)`
    ).run("staged-msg", USER, "guid-9");

    // The insert that a copied foreign key would refuse: it points at a row that
    // exists only in staging.
    expect(() =>
      db
        .prepare(
          `INSERT INTO "${staging.attachmentsTable}" (id, message_id, external_message_id, filename)
           VALUES (?, ?, ?, ?)`
        )
        .run("staged-att", "staged-msg", "guid-9", "photo.jpg")
    ).not.toThrow();

    // ...and the LIVE table still refuses it, which is the half that must not
    // have been weakened.
    expect(() =>
      db
        .prepare(
          `INSERT INTO attachments (id, message_id, external_message_id, filename)
           VALUES (?, ?, ?, ?)`
        )
        .run("live-att", "no-such-message", "guid-9", "photo.jpg")
    ).toThrow(/FOREIGN KEY/i);

    staging.drop();
  });

  it("carries the unique index that INSERT OR IGNORE's dedup depends on", async () => {
    // Without the partial unique index on (user_id, external_id), a repeated
    // GUID inside one run inserts a SECOND row into staging instead of being
    // ignored — and the swap then carries a duplicate into live, where the real
    // index would reject the whole insert and fail the re-import.
    const staging = forceStagingLifecycle.create(db, USER);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO "${staging.messagesTable}" (id, user_id, external_id) VALUES (?, ?, ?)`
    );
    insert.run("staged-1", USER, "guid-dup");
    const second = insert.run("staged-2", USER, "guid-dup");

    expect(second.changes).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM "${staging.messagesTable}"`).get() as { c: number }).c
    ).toBe(1);

    staging.drop();
  });

  it("is dropped by drop(), and any survivor is swept by the next run", async () => {
    const staging = forceStagingLifecycle.create(db, USER);
    expect(stagingTables()).toEqual(
      [staging.attachmentsTable, staging.messagesTable].sort()
    );

    staging.drop();
    expect(stagingTables()).toEqual([]);

    // The crashed-run case: tables nobody dropped.
    db.exec(`CREATE TABLE "${STAGING_TABLE_PREFIX}orphan_messages" (id TEXT)`);
    expect(sweepStaleStaging(db)).toEqual([`${STAGING_TABLE_PREFIX}orphan_messages`]);
    expect(stagingTables()).toEqual([]);
  });

  it("refuses to derive a staging table it cannot rename", async () => {
    // A silent no-op rename would produce a staging table named `messages` —
    // i.e. writes going straight to live, which is the one outcome this whole
    // design exists to prevent. It must throw instead.
    expect(() =>
      deriveStagingTableDdl("CREATE TABLE somethingelse (id TEXT)", "messages", "staging_x")
    ).toThrow(/staging table/i);
  });
});

function stagingTables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`${STAGING_TABLE_PREFIX}%`) as Array<{ name: string }>
  )
    .map((r) => r.name)
    .sort();
}
