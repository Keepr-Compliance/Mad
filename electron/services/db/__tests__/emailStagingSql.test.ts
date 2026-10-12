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
 *   2. removed vs protected   every live row of the user is in exactly one set
 *   3. discard                a discarded staged copy takes its participants
 *
 * BACKLOG-3910a rewrote 1-3 for the new rule (every unprotected email of the
 * user is replaced; protected ones are refreshed in place) and added the
 * refresh-in-place pins below.
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
  discardStagedEmails,
  dropStagingTable,
  insertStagedEmails,
  insertStagedParticipants,
  mirrorStagingIndexes,
  refreshLiveEmailFromStaged,
} from "../emailStagingSql";
import { STAGING_PREFIX, checkedStagingTable } from "../stagingDdlSql";
import {
  deleteLiveForceSet,
  selectProtectedLiveEmails,
  type EmailForceSet,
} from "../emailForceSetSql";
import { computeParticipantHash } from "../../../utils/emailAddress";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-c5";
const TOKEN = "deadbeefcafe";
const STAGED_E = checkedStagingTable(`${STAGING_PREFIX["email-recache"]}${TOKEN}_emails`, "email-recache");
const STAGED_P = checkedStagingTable(`${STAGING_PREFIX["email-recache"]}${TOKEN}_participants`, "email-recache");

const SET: EmailForceSet = { userId: USER };

/** Tie a live email to a deal, so the force set keeps it. */
const protect = (emailId: string): void => {
  db.prepare(
    `INSERT OR IGNORE INTO transactions (id, user_id, property_address) VALUES ('deal-1', ?, '1 Main St')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source)
     VALUES (?, ?, 'deal-1', ?, (SELECT thread_id FROM emails WHERE id = ?), 'manual')`,
  ).run(`comm-${emailId}`, USER, emailId, emailId);
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
  it("live ends as protected rows PLUS staged, with no row lost and none duplicated", () => {
    createStagingTable(db as never, "emails", STAGED_E);

    addEmail("live-unprotected", "emails", { sentAt: "2019-01-01T00:00:00Z" }); // removed, any age
    addEmail("live-protected", "emails");                                        // kept
    protect("live-protected");
    addEmail("staged-1", STAGED_E);
    addEmail("staged-2", STAGED_E);

    const before = ids("emails");
    const deleted = deleteLiveForceSet(db as never, SET);
    const inserted = insertStagedEmails(db as never, STAGED_E);

    expect(deleted).toBe(1);
    expect(inserted).toBe(2);
    expect(ids("emails")).toEqual(["live-protected", "staged-1", "staged-2"]);
    expect(before.length - deleted + inserted).toBe(ids("emails").length);
  });

  it("a staged row colliding with a kept row throws rather than silently winning", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    addEmail("collide", "emails");
    protect("collide");
    addEmail("collide", STAGED_E);

    expect(() => insertStagedEmails(db as never, STAGED_E)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });
});

describe("PAIR 2 — removed vs protected: every live row of the user is in exactly one set", () => {
  it("the rows the DELETE spares are exactly the rows the protected read returns", () => {
    addEmail("tied", "emails");
    protect("tied");
    addEmail("untied", "emails");
    addEmail("null-source", "emails", { source: null });

    // Half A: what the swap will pair and keep.
    const kept = selectProtectedLiveEmails(db as never, SET, ["submitted"]).map((r) => r.id);
    // Half B: what the DELETE actually leaves.
    deleteLiveForceSet(db as never, SET);
    const left = ids("emails");

    // A row kept-but-deleted would be "refreshed" into nothing; a row
    // left-but-not-kept would sit beside its fresh copy as a duplicate.
    expect(kept).toEqual(left);
    expect(left).toEqual(["tied"]);
  });
});

describe("PAIR 3 — discarding a staged copy takes its participants", () => {
  it("removes exactly the named staged rows and their participants, nothing else", () => {
    createStagingTable(db as never, "emails", STAGED_E);
    createStagingTable(db as never, "email_participants", STAGED_P);
    addEmail("drop", STAGED_E);
    addEmail("stay", STAGED_E);
    const part = db.prepare(
      `INSERT INTO "${STAGED_P}" (email_id, role, position, participant_hash, email_address) VALUES (?, 'to', 0, ?, 'r@example.test')`,
    );
    part.run("drop", "h-drop");
    part.run("stay", "h-stay");

    discardStagedEmails(db as never, STAGED_E, STAGED_P, ["drop"]);

    expect(ids(STAGED_E)).toEqual(["stay"]);
    expect(db.prepare(`SELECT email_id FROM "${STAGED_P}"`).all()).toEqual([{ email_id: "stay" }]);
  });
});

describe("refreshLiveEmailFromStaged — the kept row is updated IN PLACE (BACKLOG-3910a)", () => {
  beforeEach(() => {
    db.pragma("foreign_keys = ON");
    createStagingTable(db as never, "emails", STAGED_E);
    createStagingTable(db as never, "email_participants", STAGED_P);
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, body_plain, thread_id,
                           ingest_source, classification, created_at)
       VALUES ('live', ?, 'ext-old', 'outlook', NULL, 'old subject', 'old body', 't-old', 'manual', '{"c":1}', '2026-01-01 00:00:00')`,
    ).run(USER);
    db.prepare(
      `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES ('live', 'from', 0, 'stale', 'old@example.test')`,
    ).run();
    protect("live");
    db.prepare(
      `INSERT INTO "${STAGED_E}" (id, user_id, external_id, source, account_id, subject, body_plain, thread_id, ingest_source)
       VALUES ('staged', ?, 'ext-new', 'outlook', 'acct-1', 'new subject', 'new body', 't-new', 'filter')`,
    ).run(USER);
    db.prepare(
      `INSERT INTO "${STAGED_P}" (email_id, role, position, participant_hash, email_address)
       VALUES ('staged', 'from', 0, 'staged-hash', 'new@example.test'), ('staged', 'to', 0, 'staged-hash-2', 'me@example.test')`,
    ).run();
  });

  /**
   * C15 (unit half). MUTATION: copy the staged `participant_hash` instead of
   * recomputing -> the hash assertion is red.
   */
  it("same id, fresh content and identity, kept provenance, participants re-keyed with recomputed hashes", () => {
    refreshLiveEmailFromStaged(db as never, STAGED_E, STAGED_P, {
      liveId: "live",
      stagedId: "staged",
      writeIdentity: true,
      previousThreadId: "t-old",
    });

    expect(
      db
        .prepare(
          `SELECT id, external_id, account_id, subject, body_plain, thread_id, ingest_source, classification, created_at FROM emails`,
        )
        .all(),
    ).toEqual([
      {
        id: "live",
        external_id: "ext-new",
        account_id: "acct-1",
        subject: "new subject",
        body_plain: "new body",
        thread_id: "t-new",
        ingest_source: "manual",
        classification: '{"c":1}',
        created_at: "2026-01-01 00:00:00",
      },
    ]);
    const parts = db
      .prepare(`SELECT email_id, role, position, email_address, participant_hash FROM email_participants ORDER BY role`)
      .all() as Array<{ email_id: string; role: "from" | "to"; position: number; email_address: string; participant_hash: string }>;
    expect(parts.map((p) => `${p.email_id}:${p.role}:${p.email_address}`)).toEqual([
      "live:from:new@example.test",
      "live:to:me@example.test",
    ]);
    for (const p of parts) {
      expect(p.participant_hash).toBe(computeParticipantHash("live", p.role, p.position, p.email_address));
    }
    // The deal link survived (no cascade) and follows the new thread (SR R2).
    expect(db.prepare(`SELECT id, thread_id FROM communications`).all()).toEqual([
      { id: "comm-live", thread_id: "t-new" },
    ]);
    // The staged copy is gone.
    expect(ids(STAGED_E)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "${STAGED_P}"`).get()).toEqual({ n: 0 });
  });

  it("writes content only when told the identity is taken", () => {
    refreshLiveEmailFromStaged(db as never, STAGED_E, STAGED_P, {
      liveId: "live",
      stagedId: "staged",
      writeIdentity: false,
      previousThreadId: "t-old",
    });
    expect(db.prepare(`SELECT external_id, account_id, body_plain FROM emails`).get()).toEqual({
      external_id: "ext-old",
      account_id: null,
      body_plain: "new body",
    });
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
