/**
 * @jest-environment node
 *
 * BACKLOG-2562 — a REJECTED deal must stop receiving auto-linked mail and stop
 * competing as an address candidate.
 *
 * Runs against a REAL in-memory better-sqlite3 database wired through the real
 * `dbConnection` via `setDb`, so production SQL executes verbatim (the defect
 * IS a SQL predicate, so a mocked dbAll could not have caught it). Same vehicle
 * as `expandAttachedThreads.test.ts`; run under the Electron jest runner.
 *
 * The defect: three predicates in autoLinkService read `t.status != 'archived'`.
 * `'archived'` is not a permitted transaction status (the schema CHECK admits
 * only pending|active|closed|rejected), so that predicate excluded NOTHING and
 * in particular admitted rejected deals. The correct rule, already used by the
 * import floor and the export gate, is `status != 'rejected'`.
 *
 * PER-SITE CONTROLS (each mutation must go red on its OWN test — one input per
 * branch is not enough when three sites are being changed at once). Commands
 * and observed results are recorded in the PR body.
 *
 *   Site 1  countContactCandidateTransactions        → describe "site 1"
 *   Site 2  getOtherCandidateTransactionAddresses    → describe "site 2"
 *   Site 3  autoLinkNewMessagesForUser's pair query  → describe "site 3"
 *
 * Reverse control: the same fixtures with the deal LEFT LIVE keep linking — so
 * the tests are proving "rejected is excluded", not "nothing links at all".
 *
 * All assertions are exact ID SETS / exact values, never counts of anonymous
 * rows (project rule).
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

// Mocks must be registered before the SUT is imported.
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: { info: noop, warn: noop, error: noop, debug: noop },
  };
});

import { setDb } from "../db/core/dbConnection";
import {
  autoLinkCommunicationsForContact,
  autoLinkNewMessagesForUser,
  countContactCandidateTransactions,
  getOtherCandidateTransactionAddresses,
} from "../autoLinkService";
import {
  LIVE_TRANSACTION_SQL_PREDICATE,
  isLiveTransactionStatus,
} from "../transactionEligibility";

// ---------------------------------------------------------------------------
// Fixture identities
// ---------------------------------------------------------------------------
const USER_ID = "user-2562";
const USER_EMAIL = "agent@keepr.test";

/** The deal the user REJECTED. Must never receive mail, never be a candidate. */
const TXN_REJECTED = "txn-rejected";
const ADDR_REJECTED = "742 Evergreen Terrace";

/** A live deal sharing the same contact. Mail belongs here. */
const TXN_LIVE = "txn-live";
const ADDR_LIVE = "100 Oak Street";

/** A SECOND live deal — present so the multi-candidate address gate engages. */
const TXN_LIVE_2 = "txn-live-2";
const ADDR_LIVE_2 = "500 Pine Boulevard";

/** The shared contact assigned to all three deals. */
const CONTACT = "contact-shared";
const CONTACT_EMAIL = "lender@example.test";

/** An email that names the REJECTED deal's address and nothing else. */
const EMAIL_NAMES_REJECTED = "email-names-rejected";
/** An email that names NO deal address at all. */
const EMAIL_NAMES_NOTHING = "email-names-nothing";

const SENT_AT = "2026-03-15T12:00:00.000Z";
const WINDOW = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-12-31T23:59:59.000Z"),
};

let db: DatabaseType;

function createSchema(database: DatabaseType): void {
  database.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY, email TEXT);

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT
    );

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );

    -- Mirrors the production CHECK: 'archived' is NOT a permitted value, which
    -- is exactly why the predicate under test was a no-op.
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'active'
        CHECK (status IN ('pending', 'active', 'closed', 'rejected')),
      property_address TEXT,
      property_street TEXT,
      skip_address_filter INTEGER DEFAULT 0,
      started_at DATETIME,
      created_at DATETIME,
      closed_at DATETIME,
      text_thread_count INTEGER DEFAULT 0
    );

    CREATE TABLE transaction_contacts (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      removed_at DATETIME
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sender TEXT,
      recipients TEXT,
      cc TEXT,
      bcc TEXT,
      sent_at DATETIME,
      subject TEXT,
      body_plain TEXT,
      thread_id TEXT
    );

    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      display_name TEXT,
      resolved_contact_id TEXT,
      PRIMARY KEY (email_id, role, position)
    );
    CREATE INDEX idx_email_participants_email_address
      ON email_participants(email_address);

    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      transaction_id TEXT,
      email_id TEXT,
      message_id TEXT,
      thread_id TEXT,
      link_source TEXT,
      link_confidence REAL,
      match_reason TEXT,
      linked_at DATETIME
    );

    CREATE TABLE ignored_communications (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      email_id TEXT,
      thread_id TEXT,
      original_communication_id TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      thread_id TEXT,
      sent_at DATETIME
    );
  `);
}

/** Insert a transaction. `status` is written explicitly, never defaulted. */
function insertTransaction(id: string, status: string, address: string): void {
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, status, property_address, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, USER_ID, status, address, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function assignContact(transactionId: string): void {
  db.prepare(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, removed_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(`tc-${transactionId}`, transactionId, CONTACT);
}

function insertEmail(id: string, subject: string, body: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, sender, recipients, sent_at, subject, body_plain, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, USER_ID, CONTACT_EMAIL, USER_EMAIL, SENT_AT, subject, body, `thread-${id}`);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, email_address)
     VALUES (?, 'from', 0, ?)`,
  ).run(id, CONTACT_EMAIL);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, email_address)
     VALUES (?, 'to', 0, ?)`,
  ).run(id, USER_EMAIL);
}

/** The transaction ids an email is currently linked to, as an exact sorted set. */
function linkedTransactionIds(emailId: string): string[] {
  return db
    .prepare(`SELECT transaction_id FROM communications WHERE email_id = ? ORDER BY transaction_id`)
    .all(emailId)
    .map((r) => (r as { transaction_id: string }).transaction_id);
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  setDb(db);

  db.prepare(`INSERT INTO users_local (id, email) VALUES (?, ?)`).run(USER_ID, USER_EMAIL);
  db.prepare(
    `INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)`,
  ).run(CONTACT, USER_ID, "Shared Lender");
  db.prepare(
    `INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)`,
  ).run("ce-1", CONTACT, CONTACT_EMAIL);

  insertEmail(
    EMAIL_NAMES_REJECTED,
    "Re: 742 Evergreen Terrace",
    "Docs for 742 Evergreen Terrace are attached.",
  );
  insertEmail(
    EMAIL_NAMES_NOTHING,
    "Rate lock confirmation",
    "Your rate lock is confirmed through the end of the month.",
  );
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// SITE 1 — countContactCandidateTransactions (autoLinkService)
//
// CONTROL: revert ONLY this predicate to `t.status != 'archived'`.
// Expected red: the rejected deal is counted, so the count is 2 not 1.
// ===========================================================================
describe("site 1: countContactCandidateTransactions ignores a rejected deal", () => {
  it("counts only the live deal when the contact's other deal was rejected", () => {
    insertTransaction(TXN_LIVE, "active", ADDR_LIVE);
    insertTransaction(TXN_REJECTED, "rejected", ADDR_REJECTED);
    assignContact(TXN_LIVE);
    assignContact(TXN_REJECTED);

    expect(countContactCandidateTransactions(USER_ID, CONTACT)).toBe(1);
  });

  it("REVERSE CONTROL: counts both while the second deal is still live", () => {
    insertTransaction(TXN_LIVE, "active", ADDR_LIVE);
    insertTransaction(TXN_LIVE_2, "active", ADDR_LIVE_2);
    assignContact(TXN_LIVE);
    assignContact(TXN_LIVE_2);

    // Un-rejected deals still count — the predicate excludes 'rejected', not
    // "everything that is not active".
    expect(countContactCandidateTransactions(USER_ID, CONTACT)).toBe(2);
  });

  it("counts pending and closed deals as live", () => {
    insertTransaction(TXN_LIVE, "pending", ADDR_LIVE);
    insertTransaction(TXN_LIVE_2, "closed", ADDR_LIVE_2);
    assignContact(TXN_LIVE);
    assignContact(TXN_LIVE_2);

    expect(countContactCandidateTransactions(USER_ID, CONTACT)).toBe(2);
  });
});

// ===========================================================================
// SITE 2 — getOtherCandidateTransactionAddresses (autoLinkService)
//
// CONTROL: revert ONLY this predicate to `t.status != 'archived'`.
// Expected red: the rejected deal's address is back in the candidate array.
// ===========================================================================
describe("site 2: a rejected deal's address is not a disambiguation candidate", () => {
  beforeEach(() => {
    insertTransaction(TXN_LIVE, "active", ADDR_LIVE);
    insertTransaction(TXN_LIVE_2, "active", ADDR_LIVE_2);
    insertTransaction(TXN_REJECTED, "rejected", ADDR_REJECTED);
    assignContact(TXN_LIVE);
    assignContact(TXN_LIVE_2);
    assignContact(TXN_REJECTED);
  });

  it("returns the other LIVE deal's address only — the rejected address is absent", () => {
    const addresses = getOtherCandidateTransactionAddresses(USER_ID, CONTACT, TXN_LIVE);

    // Exact array, not its length: the surviving candidate must still be there
    // AND the rejected one must be gone.
    expect(addresses).toEqual([ADDR_LIVE_2]);
    expect(addresses).not.toContain(ADDR_REJECTED);
  });

  it("harm, end to end: an email naming the rejected deal's address is NOT routed away from the live deal", async () => {
    // The multi-candidate address gate is engaged (two LIVE deals share this
    // contact), so `matchesOtherCandidate` is genuinely consulted. Before the
    // fix the rejected deal's address sat in that candidate list, so this email
    // was skipped entirely — "routed" to a deal the user had already rejected.
    await autoLinkCommunicationsForContact({
      contactId: CONTACT,
      transactionId: TXN_LIVE,
      dateRange: WINDOW,
    });

    expect(linkedTransactionIds(EMAIL_NAMES_REJECTED)).toEqual([TXN_LIVE]);
  });

  it("REVERSE CONTROL: an email naming a genuinely LIVE other deal's address IS still routed away", async () => {
    insertEmail(
      "email-names-live-2",
      "Re: 500 Pine Boulevard",
      "Appraisal for 500 Pine Boulevard came back.",
    );

    await autoLinkCommunicationsForContact({
      contactId: CONTACT,
      transactionId: TXN_LIVE,
      dateRange: WINDOW,
    });

    // Disambiguation still works: this email belongs to the OTHER live deal, so
    // it must NOT attach here. Absence asserted as an exact empty set.
    expect(linkedTransactionIds("email-names-live-2")).toEqual([]);
  });
});

// ===========================================================================
// SITE 3 — autoLinkNewMessagesForUser's contact/transaction pair query
//
// CONTROL: revert ONLY this predicate to `t.status != 'archived'`.
// Expected red: the rejected deal is processed and receives communications.
// ===========================================================================
describe("site 3: a sync-wide auto-link run skips rejected deals", () => {
  it("links the sync's mail to the live deal only — the rejected deal receives nothing", async () => {
    insertTransaction(TXN_LIVE, "active", ADDR_LIVE);
    insertTransaction(TXN_REJECTED, "rejected", ADDR_REJECTED);
    assignContact(TXN_LIVE);
    assignContact(TXN_REJECTED);

    await autoLinkNewMessagesForUser(USER_ID);

    // Absence asserted BY ID on both emails, not by a row count.
    expect(linkedTransactionIds(EMAIL_NAMES_REJECTED)).toEqual([TXN_LIVE]);
    expect(linkedTransactionIds(EMAIL_NAMES_NOTHING)).toEqual([TXN_LIVE]);

    const touchedTransactions = db
      .prepare(`SELECT DISTINCT transaction_id FROM communications ORDER BY transaction_id`)
      .all()
      .map((r) => (r as { transaction_id: string }).transaction_id);
    expect(touchedTransactions).toEqual([TXN_LIVE]);
  });

  it("reject-then-sync: a deal rejected AFTER its mail was linked receives no NEW mail", async () => {
    insertTransaction(TXN_LIVE, "active", ADDR_LIVE);
    assignContact(TXN_LIVE);

    // First sync while the deal is live — it links, as it should.
    await autoLinkNewMessagesForUser(USER_ID);
    expect(linkedTransactionIds(EMAIL_NAMES_NOTHING)).toEqual([TXN_LIVE]);

    // The user rejects the deal, then new mail arrives and a sync runs.
    db.prepare(`UPDATE transactions SET status = 'rejected' WHERE id = ?`).run(TXN_LIVE);
    insertEmail("email-after-reject", "Closing disclosure", "Please review the attached CD.");

    await autoLinkNewMessagesForUser(USER_ID);

    // The new mail must NOT attach. Existing links are deliberately left alone
    // (the fix is forward-only; no backfill — BACKLOG-2562 open question 2).
    expect(linkedTransactionIds("email-after-reject")).toEqual([]);
    expect(linkedTransactionIds(EMAIL_NAMES_NOTHING)).toEqual([TXN_LIVE]);
  });

  it("REVERSE CONTROL: un-rejecting the deal lets the same mail link again", async () => {
    insertTransaction(TXN_LIVE, "rejected", ADDR_LIVE);
    assignContact(TXN_LIVE);

    await autoLinkNewMessagesForUser(USER_ID);
    expect(linkedTransactionIds(EMAIL_NAMES_NOTHING)).toEqual([]);

    // The user changes their mind and reactivates the deal.
    db.prepare(`UPDATE transactions SET status = 'active' WHERE id = ?`).run(TXN_LIVE);

    await autoLinkNewMessagesForUser(USER_ID);
    expect(linkedTransactionIds(EMAIL_NAMES_NOTHING)).toEqual([TXN_LIVE]);
  });
});

// ===========================================================================
// The lock-step claim, made mechanical.
//
// Without this the shared helper is decorative: the next engineer can hand-write
// a fourth copy of the rule and nothing notices. `transactionEligibility` is the
// ONE definition; these assertions fail if a site stops referring to it.
// ===========================================================================
/** Read autoLinkService's source verbatim. */
function readAutoLinkSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  return fs.readFileSync(path.join(__dirname, "..", "autoLinkService.ts"), "utf8");
}

/** Drop `//` and block-comment content so only executable code is inspected. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the eligibility rule has exactly one definition", () => {
  it("the SQL predicate names 'rejected', not the dead 'archived' form", () => {
    expect(LIVE_TRANSACTION_SQL_PREDICATE).toBe("t.status != 'rejected'");
    expect(LIVE_TRANSACTION_SQL_PREDICATE).not.toContain("archived");
  });

  it("no autoLinkService query still carries the dead 'archived' predicate", () => {
    // The tautology must be gone from the executable SQL. Prose recording the
    // migration is expected and must NOT trip this — so comment lines are
    // stripped first. (A bare substring check over the whole file could not
    // separate a docblock from a live predicate, and reported a false red.)
    const code = stripComments(readAutoLinkSource());

    expect(code).not.toContain("status != 'archived'");
    expect(code).not.toContain('status != "archived"');

    // Control on the stripper itself: the prose the fix deliberately leaves
    // behind IS present in the raw file, so a green above means the stripper
    // removed a real mention rather than the mention never existing.
    expect(readAutoLinkSource()).toContain("archived");
  });

  it("every rejected-deal SQL site interpolates the shared constant", () => {
    const code = stripComments(readAutoLinkSource());

    // Three sites, three interpolations of the ONE definition.
    const interpolations = code.match(/\$\{LIVE_TRANSACTION_SQL_PREDICATE\}/g) ?? [];
    expect(interpolations).toHaveLength(3);

    // A hand-written fourth copy of the rule fails here — which is the whole
    // point of the shared constant.
    const handWritten = code.match(/status\s*!=\s*'rejected'/g) ?? [];
    expect(handWritten).toEqual([]);
  });

  it("the JS form treats a NULL status as live, matching auditCoverageService's early return", () => {
    // Deliberate divergence from the SQL predicate, transcribed not invented —
    // see the transactionEligibility docblock and BACKLOG-2562 open question 1.
    expect(isLiveTransactionStatus("rejected")).toBe(false);
    expect(isLiveTransactionStatus("active")).toBe(true);
    expect(isLiveTransactionStatus("pending")).toBe(true);
    expect(isLiveTransactionStatus("closed")).toBe(true);
    expect(isLiveTransactionStatus(null)).toBe(true);
    expect(isLiveTransactionStatus(undefined)).toBe(true);
  });

  it("SQL NULL-status behaviour is unchanged by the migration", () => {
    // The dead `!= 'archived'` form ALSO excluded NULL-status rows (in SQL,
    // NULL != 'x' is NULL, which is not TRUE). Swapping the literal is
    // therefore behaviour-neutral for NULL, and this test says so by execution
    // rather than by assertion in a comment.
    db.exec(`DROP TABLE transactions`);
    db.exec(`CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT, status TEXT)`);
    db.prepare(`INSERT INTO transactions (id, user_id, status) VALUES (?, ?, NULL)`).run(
      "txn-null",
      USER_ID,
    );

    const underNewRule = db
      .prepare(`SELECT id FROM transactions t WHERE ${LIVE_TRANSACTION_SQL_PREDICATE}`)
      .all();
    const underDeadRule = db
      .prepare(`SELECT id FROM transactions t WHERE t.status != 'archived'`)
      .all();

    expect(underNewRule).toEqual([]);
    expect(underDeadRule).toEqual([]);
  });
});
