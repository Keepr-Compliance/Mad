/**
 * Pin for `TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL` — BACKLOG-2989 PR 1.
 *
 * ## Why this test exists at all
 *
 * The statement moved out of `submissionService.downloadMissingEmailAttachments`
 * into `db/submissionEmailSql.ts`. `submissionService.test.ts` cannot notice if
 * the move changed its meaning: it does `jest.mock("../databaseService")`
 * wholesale, so the statement never reaches a database and a mutated column
 * name leaves it green. That is the BACKLOG-2848 shape, and it is why the
 * control for this move had to be written rather than inherited.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * It asserts the ROW SET READ BACK from a real database — the exact ids, not a
 * count. A count passes for two different bugs (one row too many and one row
 * too few cancel out), and BACKLOG-2989's brief requires the row read back
 * rather than any value the caller constructs in memory.
 *
 * The schema is not invented and not transcribed: the test executes the whole
 * of `electron/database/schema.sql`, so the tables, types, CHECK constraints
 * and defaults are the ones production creates. `PRAGMA foreign_keys = ON`
 * because production runs with them on, and every parent row is inserted — a
 * fixture that only works with the constraints off is describing a database
 * the app never has.
 *
 * One case per branch of the WHERE clause, not a sample: an off-by-one in a
 * predicate is invisible to a fixture that exercises only the happy path.
 */

import fs from "fs";
import os from "os";
import path from "path";

// The real driver, required by path so jest's moduleNameMapper mock for
// `better-sqlite3-multiple-ciphers` does not intercept it — the same trick
// `storageDiagnostics.test.ts` uses, and for the same reason.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL } from "../submissionEmailSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");

const USER = "user-2989";
const TX = "tx-2989";
const OTHER_TX = "tx-2989-other";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

/** Insert an email row, defaulting every column the statement filters on. */
function insertEmail(
  id: string,
  opts: {
    hasAttachments?: number;
    externalId?: string | null;
    source?: string | null;
  } = {},
): void {
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
}

function link(commId: string, emailId: string, txId: string = TX): void {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source)
     VALUES (?, ?, ?, ?, 'auto')`,
  ).run(commId, USER, txId, emailId);
}

function attach(attachmentId: string, emailId: string): void {
  db.prepare(
    `INSERT INTO attachments (id, email_id, filename) VALUES (?, ?, ?)`,
  ).run(attachmentId, emailId, `${attachmentId}.pdf`);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-submission-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, ?, 'google', ?)`,
  ).run(USER, "pin@example.test", "oauth-2989");

  for (const t of [TX, OTHER_TX]) {
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)`,
    ).run(t, USER, `${t} address`);
  }
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const run = (txId: string = TX): string[] =>
  (
    db.prepare(TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL).all(txId) as Array<{
      id: string;
    }>
  ).map((r) => r.id);

describe("TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL", () => {
  it("selects exactly the emails that advertise attachments and have none stored", () => {
    insertEmail("e-wanted");
    link("c-wanted", "e-wanted");

    expect(run()).toEqual(["e-wanted"]);
  });

  it("returns the four columns the caller re-fetches with", () => {
    insertEmail("e-cols");
    link("c-cols", "e-cols");

    const row = db
      .prepare(TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL)
      .get(TX) as Record<string, unknown>;

    // The row READ BACK from the database, not a value the caller assembled.
    expect(row).toEqual({
      id: "e-cols",
      external_id: "ext-e-cols",
      source: "gmail",
      user_id: USER,
    });
  });

  it("excludes every row the WHERE clause is there to exclude", () => {
    // One case per predicate. Each of these is a row the download path must
    // NOT attempt, and each would be selected if its clause were dropped.
    insertEmail("e-wanted");
    link("c-wanted", "e-wanted");

    insertEmail("e-no-flag", { hasAttachments: 0 }); // has_attachments = 1
    link("c-no-flag", "e-no-flag");

    insertEmail("e-null-external", { externalId: null }); // external_id IS NOT NULL
    link("c-null-external", "e-null-external");

    insertEmail("e-null-source", { source: null }); // source IS NOT NULL
    link("c-null-source", "e-null-source");

    insertEmail("e-already-fetched"); // NOT EXISTS (attachments)
    link("c-already-fetched", "e-already-fetched");
    attach("a-1", "e-already-fetched");

    insertEmail("e-other-tx"); // INNER JOIN … transaction_id = ?
    link("c-other-tx", "e-other-tx", OTHER_TX);

    insertEmail("e-unlinked"); // no communications row at all

    expect(run().sort()).toEqual(["e-wanted"]);
  });

  /**
   * The statement carries a `DISTINCT`, and this is what became of the test
   * written to exercise it.
   *
   * The first draft linked one email to one transaction twice and asserted it
   * came back once. Against the REAL schema that insert does not happen:
   * `idx_comm_email_txn` (schema.sql:1172) is a partial UNIQUE index on
   * `(email_id, transaction_id)` where both are NOT NULL, and the second link
   * is rejected. Both columns are non-null by construction on this join — the
   * statement binds `transaction_id` and joins `email_id` to `emails.id` — so
   * the join can match AT MOST ONE communications row per email and the
   * `DISTINCT` cannot change the result set.
   *
   * That is worth a test rather than a deletion. The `DISTINCT` is unreachable
   * because of an INDEX, not because of anything in the statement, and an index
   * is a much easier thing to drop in a future migration than a keyword is to
   * re-derive. If that unique index ever goes away, this test fails and
   * whoever removed it learns that a submission-path query depended on it.
   *
   * The `DISTINCT` itself is deliberately NOT removed here: BACKLOG-2989 moves
   * SQL text byte-identically (verified by content hash), and editing a
   * statement inside a mechanical move is how a refactor smuggles a behaviour
   * change past review.
   */
  it("cannot hold the duplicate link its DISTINCT would deduplicate", () => {
    insertEmail("e-double");
    link("c-double-a", "e-double");

    expect(() => link("c-double-b", "e-double")).toThrow(
      /UNIQUE constraint failed: communications\.email_id, communications\.transaction_id/,
    );

    expect(run()).toEqual(["e-double"]);
  });

  it("returns nothing when every linked email already has its attachments", () => {
    insertEmail("e-done");
    link("c-done", "e-done");
    attach("a-done", "e-done");

    expect(run()).toEqual([]);
  });
});
