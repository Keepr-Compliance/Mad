/**
 * Pins for `db/emailStagingSql` — BACKLOG-2989 chunk 5, the last of the move set.
 *
 * ## Three assertions here are shaped deliberately, and it is the shape that matters
 *
 * MUTATION L in commit A2 found a defect that lived in the DISAGREEMENT between
 * two individually-defensible behaviours: a NULL-source row survived the DELETE
 * (correct) and dropped out of the survivor read (wrong), and a test checking
 * either half alone reports success. The force re-cache has three more pairs of
 * exactly that kind, so each is asserted as a pair that must AGREE, never as two
 * independent facts:
 *
 *   1. delete-then-insert     what the swap removes and what it puts back
 *   2. survivors vs staged    every live row is in exactly one of the two sets
 *   3. narrowing vs buffer    dropped staged rows and the metadata pointing at them
 *
 * Schema: `electron/database/schema.sql`, executed whole.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  STALE_STAGING_TABLES_SQL,
  createStagingTable,
  deleteStagedProviderRows,
  dropStagingTable,
  insertStagedEmails,
  insertStagedParticipants,
  mirrorStagingIndexes,
  selectStagedIdsBySource,
} from "../emailStagingSql";
import { STAGING_PREFIX, checkedStagingTable } from "../stagingDdlSql";
import { deleteLiveForceSet, type EmailForceSet } from "../emailForceSetSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-c5";
const TOKEN = "deadbeefcafe";
const STAGED_E = checkedStagingTable(`${STAGING_PREFIX["email-recache"]}${TOKEN}_emails`, "email-recache");
const STAGED_P = checkedStagingTable(`${STAGING_PREFIX["email-recache"]}${TOKEN}_participants`, "email-recache");

const SET: EmailForceSet = {
  userId: USER,
  providers: ["gmail", "outlook"],
  cacheSinceIso: "2026-01-01T00:00:00Z",
};

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addEmail = (
  id: string,
  t: string,
  opts: { source?: string | null; sentAt?: string | null; userId?: string } = {},
): void => {
  db.prepare(
    `INSERT INTO "${t}" (id, user_id, external_id, source, sent_at, subject)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId ?? USER,
    `ext-${id}`,
    opts.source === undefined ? "gmail" : opts.source,
    opts.sentAt === undefined ? "2026-06-01T00:00:00Z" : opts.sentAt,
    `subject ${id}`,
  );
};

const ids = (t: string): string[] =>
  (db.prepare(`SELECT id FROM "${t}" ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-c5-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(USER, "c5@example.test", "oauth-c5");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createStagingTable / mirrorStagingIndexes", () => {
  it("derives a staging table that keeps the live DEFAULTs", () => {
    createStagingTable(db as never, "emails", STAGED_E);

    // `AS SELECT * WHERE 0` would copy names and types and DROP every default,
    // so staging would store NULL where live stores 0 — and the swap would
    // carry those NULLs into live. Deriving the real DDL is what prevents it.
    db.prepare(`INSERT INTO "${STAGED_E}" (id, user_id) VALUES ('x', ?)`).run(USER);
    expect(db.prepare(`SELECT has_attachments FROM "${STAGED_E}"`).get()).toEqual({
      has_attachments: 0,
    });
  });

  it("mirrors the live indexes under run-scoped names", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    mirrorStagingIndexes(db as never, "emails", STAGED_E, `${STAGING_PREFIX["email-recache"]}${TOKEN}_`);

    const mirrored = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
        .all(STAGED_E) as Array<{ name: string }>
    ).map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));

    expect(mirrored.length).toBeGreaterThan(0);
    // Run-scoped: two concurrent rebuilds must not collide on an index name.
    for (const n of mirrored) expect(n).toContain(TOKEN);
  });
});

describe("dropStagingTable and the stale sweep", () => {
  it("the sweep finds this run's tables by prefix and the drop removes them", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    createStagingTable(db as never, "email_participants", STAGED_P);

    const escaped = STAGING_PREFIX["email-recache"].replace(/[\\%_]/g, "\\$&");
    const found = (
      db.prepare(STALE_STAGING_TABLES_SQL).all(`${escaped}%`) as Array<{ name: string }>
    ).map((r) => r.name).sort();
    expect(found).toEqual([STAGED_E, STAGED_P].sort());

    for (const n of found) dropStagingTable(db as never, checkedStagingTable(n, "email-recache"));
    expect(db.prepare(STALE_STAGING_TABLES_SQL).all(`${escaped}%`)).toEqual([]);
  });

  it("the sweep does NOT reach the messages force-import prefix", () => {
    // `sweepStaleStaging` drops every match unscoped, so a shared prefix would
    // let an email re-cache destroy a messages re-import mid-run.
    db.exec(`CREATE TABLE "${STAGING_PREFIX["message-import"]}${TOKEN}_messages" (id TEXT)`);
    const escaped = STAGING_PREFIX["email-recache"].replace(/[\\%_]/g, "\\$&");
    expect(db.prepare(STALE_STAGING_TABLES_SQL).all(`${escaped}%`)).toEqual([]);
  });
});

describe("PAIR 1 — delete-then-insert: what the swap removes and what it puts back", () => {
  it("live ends as survivors PLUS staged, with no row lost and none duplicated", () => {
    createStagingTable(db as never, "emails", STAGED_E);

    addEmail("live-in-set", "emails");                                    // deleted
    addEmail("live-survivor", "emails", { sentAt: "2025-01-01T00:00:00Z" }); // kept
    addEmail("staged-1", STAGED_E);
    addEmail("staged-2", STAGED_E);

    const before = ids("emails");
    const deleted = deleteLiveForceSet(db as never, SET);
    const inserted = insertStagedEmails(db as never, STAGED_E);

    // The two halves must RECONCILE. Asserting only the delete count, or only
    // the final set, lets a swap that deletes the wrong rows and inserts the
    // right number look correct.
    expect(deleted).toBe(1);
    expect(inserted).toBe(2);
    expect(ids("emails")).toEqual(["live-survivor", "staged-1", "staged-2"]);
    expect(before.length - deleted + inserted).toBe(ids("emails").length);
  });

  it("a staged row colliding with a survivor throws rather than silently winning", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    addEmail("collide", "emails", { sentAt: "2025-01-01T00:00:00Z" }); // survivor
    addEmail("collide", STAGED_E);                                      // same id staged

    // The swap's INSERT is plain, so a collision is an error, not an overwrite.
    // That is the point: the rebuild assumed this row would be gone.
    expect(() => insertStagedEmails(db as never, STAGED_E)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});

describe("PAIR 2 — survivors vs staged: every live row is in exactly one set", () => {
  it("the rows the DELETE spares are exactly the rows the survivor read returns", () => {
    addEmail("in-set", "emails");
    addEmail("old", "emails", { sentAt: "2025-01-01T00:00:00Z" });
    addEmail("null-source", "emails", { source: null });

    // Half A: what the survivor predicate SEES.
    const { emailForceReadView } = require("../emailForceSetSql") as typeof import("../emailForceSetSql");
    db.exec(`CREATE TABLE "${STAGED_E}" (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, source TEXT, sent_at TEXT, subject TEXT)`);
    const view = emailForceReadView(SET, STAGED_E, "id");
    const seen = (
      db.prepare(`SELECT id FROM ${view.sql} ORDER BY id`).all(...view.params) as Array<{ id: string }>
    ).map((r) => r.id);

    // Half B: what the DELETE actually LEAVES.
    deleteLiveForceSet(db as never, SET);
    const left = ids("emails");

    // They must be the same set. A row seen-but-deleted is staged twice; a row
    // left-but-unseen stops being deduplicated against. Either alone looks fine.
    expect(seen).toEqual(left);
    expect(left).toEqual(["null-source", "old"]);
  });
});

describe("PAIR 3 — narrowing vs the buffered attachment metadata", () => {
  it("the staged rows a narrowing drops are exactly the ones its metadata must forget", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    createStagingTable(db as never, "email_participants", STAGED_P);

    addEmail("g1", STAGED_E, { source: "gmail" });
    addEmail("o1", STAGED_E, { source: "outlook" });
    db.prepare(
      `INSERT INTO "${STAGED_P}" (email_id, role, position, participant_hash, email_address)
       VALUES (?, 'to', 0, ?, ?)`,
    ).run("o1", "h-o1", "r@example.test");

    // Half A: which staged ids belong to the dropped provider.
    const doomed = selectStagedIdsBySource(db as never, STAGED_E, "outlook").map((r) => r.id);
    expect(doomed).toEqual(["o1"]);

    // Half B: what the delete actually removes.
    deleteStagedProviderRows(db as never, STAGED_E, STAGED_P, "outlook");

    // The two must agree: metadata buffered against `doomed` points at staged
    // email ids that are now gone. Left in place it reaches the swap and fails
    // the REFERENCES emails(id) foreign key, aborting a re-cache that is
    // perfectly valid for the provider that DID succeed.
    expect(ids(STAGED_E)).toEqual(["g1"]);
    expect(
      db.prepare(`SELECT email_id FROM "${STAGED_P}"`).all(),
    ).toEqual([]);
    for (const id of doomed) expect(ids(STAGED_E)).not.toContain(id);
  });

  it("deletes participants BEFORE emails, so nothing is orphaned mid-way", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    createStagingTable(db as never, "email_participants", STAGED_P);
    addEmail("o1", STAGED_E, { source: "outlook" });
    db.prepare(
      `INSERT INTO "${STAGED_P}" (email_id, role, position, participant_hash, email_address)
       VALUES ('o1', 'to', 0, 'h', 'r@example.test')`,
    ).run();

    db.pragma("foreign_keys = ON");
    // Order is load-bearing and the pair travels together in db/ precisely so a
    // caller cannot do half of it.
    expect(() => deleteStagedProviderRows(db as never, STAGED_E, STAGED_P, "outlook")).not.toThrow();
    expect(ids(STAGED_E)).toEqual([]);
  });
});

describe("insertStagedParticipants", () => {
  it("carries every column the live table has, so a migration is not silently dropped", () => {
    createStagingTable(db as never, "email_participants", STAGED_P);
    addEmail("e1", "emails", { sentAt: "2025-01-01T00:00:00Z" });
    db.prepare(
      `INSERT INTO "${STAGED_P}" (email_id, role, position, participant_hash, email_address, display_name)
       VALUES ('e1', 'cc', 2, 'h1', 'x@example.test', 'X Y')`,
    ).run();

    expect(insertStagedParticipants(db as never, STAGED_P)).toBe(1);
    expect(
      db.prepare("SELECT email_id, role, position, display_name FROM email_participants").get(),
    ).toEqual({ email_id: "e1", role: "cc", position: 2, display_name: "X Y" });
  });
});
