/**
 * Pins for `db/emailSyncSql` — BACKLOG-2989 chunk 4.
 *
 * The two INSERTs are RECOMPOSED (the write table is interpolated), so they
 * have no content hash. Their controls are these pins plus a resolved-text
 * sweep across both write modes — a CLOSED space of two, so that sweep is
 * exhaustive rather than a sample.
 *
 * The `dbAll`/`dbGet`-backed selectors bind through the module singleton and
 * are not drivable from here; they are covered by the same resolved-text sweep
 * and by `emailSyncService`'s existing suites.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  CLEAR_SYNC_CURSOR_SQL,
  UPDATE_EMAIL_IDENTITY_SQL,
  prepareEmailInsert,
  prepareParticipantInsert,
  type EmailWriteTarget,
} from "../emailSyncSql";
import { STAGING_PREFIX, checkedStagingTable } from "../stagingDdlSql";
import { CACHED_EMAIL_SENT_AT_BOUNDS_SQL } from "../emailCacheWindow";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-sync";

const STAGING_E = checkedStagingTable(
  `${STAGING_PREFIX["email-recache"]}deadbeefcafe_emails`,
  "email-recache",
);
const STAGING_P = checkedStagingTable(
  `${STAGING_PREFIX["email-recache"]}deadbeefcafe_participants`,
  "email-recache",
);

const LIVE: EmailWriteTarget = { mode: "live" };
const FORCE: EmailWriteTarget = {
  mode: "force",
  emailsTable: STAGING_E,
  participantsTable: STAGING_P,
};

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

/** The 27 bound values the INSERT takes, in the order the caller binds them. */
const emailRow = (id: string): unknown[] => [
  id, USER, `ext-${id}`, "gmail", null, "inbound",
  `subject ${id}`, "plain", "<p>html</p>",
  "s@example.test", "r@example.test", null, null,
  "thread-1", null, null,
  "2026-06-01T00:00:00Z", "2026-06-01T00:05:00Z",
  0, 0,
  `<${id}@example.test>`, `hash-${id}`, null,
  null,
  "filter", null,   // ingest_source CHECK: legacy | filter | search_validated | manual
  3,
];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-sync-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(USER, "sync@example.test", "oauth-sync");
  // The staging pair a force run would have created.
  db.exec(`CREATE TABLE "${STAGING_E}" AS SELECT * FROM emails WHERE 0`);
  db.exec(`CREATE TABLE "${STAGING_P}" AS SELECT * FROM email_participants WHERE 0`);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("prepareEmailInsert — the write target decides the table, nothing else", () => {
  it("live mode writes to `emails` and NOT to staging", () => {
    prepareEmailInsert(db as never, LIVE).run(...emailRow("e-live"));

    // The ROW READ BACK, and from the right table.
    expect(db.prepare("SELECT id, subject, derived_version FROM emails").all()).toEqual([
      { id: "e-live", subject: "subject e-live", derived_version: 3 },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "${STAGING_E}"`).get()).toEqual({ n: 0 });
  });

  it("force mode writes to staging and leaves live untouched", () => {
    prepareEmailInsert(db as never, FORCE).run(...emailRow("e-staged"));

    expect(db.prepare(`SELECT id FROM "${STAGING_E}"`).all()).toEqual([{ id: "e-staged" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM emails").get()).toEqual({ n: 0 });
  });

  it("binds derived_version LAST, which the caller's positional list depends on", () => {
    // `emailSyncService.retainedHeaders.test.ts` transcribes positional indices
    // into this column list, so a column inserted mid-list would silently
    // re-point its assertions. Pinning the tail is what makes that safe.
    prepareEmailInsert(db as never, LIVE).run(...emailRow("e-order"));
    expect(
      db.prepare("SELECT derived_version, ingest_source, content_hash FROM emails").get(),
    ).toEqual({ derived_version: 3, ingest_source: "filter", content_hash: "hash-e-order" });
  });

  it("stamps created_at itself rather than taking it as a parameter", () => {
    prepareEmailInsert(db as never, LIVE).run(...emailRow("e-ts"));
    const row = db.prepare("SELECT created_at FROM emails").get() as { created_at: string };
    expect(row.created_at).not.toBeNull();
  });
});

describe("prepareParticipantInsert", () => {
  const participant = (emailId: string): unknown[] => [
    emailId, "to", 0, `${emailId}-hash`, "r@example.test", "R Ecipient",
  ];

  it("live and force modes each write to their own junction table", () => {
    prepareEmailInsert(db as never, LIVE).run(...emailRow("e1"));
    prepareParticipantInsert(db as never, LIVE).run(...participant("e1"));

    prepareEmailInsert(db as never, FORCE).run(...emailRow("e2"));
    prepareParticipantInsert(db as never, FORCE).run(...participant("e2"));

    expect(db.prepare("SELECT email_id, role FROM email_participants").all()).toEqual([
      { email_id: "e1", role: "to" },
    ]);
    expect(db.prepare(`SELECT email_id FROM "${STAGING_P}"`).all()).toEqual([{ email_id: "e2" }]);
  });
});

describe("the static statements", () => {
  it("UPDATE_EMAIL_IDENTITY_SQL re-points external_id and KEEPS an existing header", () => {
    prepareEmailInsert(db as never, LIVE).run(...emailRow("e1"));

    db.prepare(UPDATE_EMAIL_IDENTITY_SQL).run("new-ext", "<ignored@x>", "e1");

    // COALESCE: a row that already knows its Message-ID must not lose it.
    expect(
      db.prepare("SELECT external_id, message_id_header FROM emails WHERE id = 'e1'").get(),
    ).toEqual({ external_id: "new-ext", message_id_header: "<e1@example.test>" });
  });

  it("UPDATE_EMAIL_IDENTITY_SQL fills a NULL header rather than leaving it empty", () => {
    const row = emailRow("e2");
    row[20] = null; // message_id_header
    prepareEmailInsert(db as never, LIVE).run(...row);

    db.prepare(UPDATE_EMAIL_IDENTITY_SQL).run("ext-2", "<recovered@x>", "e2");

    expect(db.prepare("SELECT message_id_header FROM emails WHERE id = 'e2'").get()).toEqual({
      message_id_header: "<recovered@x>",
    });
  });

  // BACKLOG-3056 / BACKLOG-2989 merge: `LATEST_SENT_AT_SQL` and its
  // `selectLatestSentAt` wrapper were removed here — the MIN/MAX pair in
  // `db/emailCacheWindow` subsumes the MAX half and is now the only reader.
  // The control that came with them is NOT dropped: it is the sole assertion
  // anywhere that this aggregate is scoped to ONE user, and the service suites
  // mock `dbGet`, so without it the `WHERE user_id = ?` executes in no test at
  // all. It moves onto the surviving statement, and now pins BOTH ends —
  // dropping the predicate moves `oldest` and `newest` in opposite directions,
  // so either bound alone would catch it.
  it("CACHED_EMAIL_SENT_AT_BOUNDS_SQL bounds THIS user's mail, not the whole table's", () => {
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('other', 'o@x.test', 'google', 'o')`,
    ).run();

    // Mine: two rows, so MIN and MAX are genuinely different values.
    const mineOld = emailRow("mine-old");
    mineOld[16] = "2026-01-01T00:00:00Z";
    prepareEmailInsert(db as never, LIVE).run(...mineOld);
    prepareEmailInsert(db as never, LIVE).run(...emailRow("mine-new")); // 2026-06-01

    // Theirs: STRADDLING mine on both sides. An unscoped MIN/MAX returns these.
    for (const [id, sentAt] of [
      ["theirs-older", "2020-01-01T00:00:00Z"],
      ["theirs-newer", "2027-01-01T00:00:00Z"],
    ] as const) {
      const theirs = emailRow(id);
      theirs[1] = "other";
      theirs[16] = sentAt;
      prepareEmailInsert(db as never, LIVE).run(...theirs);
    }

    expect(db.prepare(CACHED_EMAIL_SENT_AT_BOUNDS_SQL).get(USER)).toEqual({
      oldest: "2026-01-01T00:00:00Z",
      newest: "2026-06-01T00:00:00Z",
    });
  });

  it("CLEAR_SYNC_CURSOR_SQL nulls the cursor for that user only", () => {
    const ins = db.prepare(
      `INSERT INTO email_sync_state (user_id, account_id, provider, cursor) VALUES (?, ?, 'google', ?)`,
    );
    db.prepare(
      `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('other', 'o@x.test', 'google', 'o')`,
    ).run();
    ins.run(USER, "a", "cursor-mine");
    ins.run("other", "b", "cursor-theirs");

    db.prepare(CLEAR_SYNC_CURSOR_SQL).run(USER);

    expect(
      db.prepare("SELECT user_id, cursor FROM email_sync_state ORDER BY user_id").all(),
    ).toEqual([
      { user_id: "other", cursor: "cursor-theirs" },
      { user_id: USER, cursor: null },
    ]);
  });
});

describe("the write target keeps the staging brand", () => {
  it("refuses an unchecked staging table at the type level", () => {
    // @ts-expect-error a raw string is not a StagingTableName
    const bad: EmailWriteTarget = { mode: "force", emailsTable: "staging_emailrecache_deadbeefcafe_emails", participantsTable: STAGING_P };
    expect(bad).toBeDefined();
  });

  it("accepts the checked pair, so the brand is satisfiable", () => {
    expect(FORCE.mode).toBe("force");
  });
});
