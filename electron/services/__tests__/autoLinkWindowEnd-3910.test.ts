/**
 * @jest-environment node
 *
 * BACKLOG-3910 (slice c) — the deal's window ends at the END of its End Date.
 *
 * Founder decision, 2026-10-11: no 30-day post-closing buffer. The End Date the
 * user types is saved to `transactions.closed_at` (saveConfirmedTransactionDates
 * `closed_at: dates.endDate`); the "Closing Date" field is `closing_deadline`
 * and no window reads it. The window therefore ends at
 * `auditWindowEnd(closed_at)` — the last millisecond of the End Date, local
 * time — on every consumer of `computeTransactionDateRange().end`.
 *
 * Two consumers had NO test pinning their end (measured: setting the old
 * 30-day buffer to 0 left every auto-link and import-plan suite green):
 *
 *   C-R2b  auto-link candidate window  autoLinkCommunicationsForContact with no
 *          explicit dateRange (the computed branch, autoLinkService.ts)
 *   C-R2c  import-cap protected span   deriveAuditSpans (importPlanInputs.ts)
 *
 * Real in-memory better-sqlite3 wired through the real `dbConnection`; the
 * schema is transcribed from autoLinkService.rejectedDeal-2562.test.ts with
 * `closing_deadline` added from schema.sql. Run under the Electron jest runner.
 *
 * Each case sets `closing_deadline` to a DIFFERENT date from `closed_at`, so an
 * implementation that reads the wrong field cannot pass.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

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
import { autoLinkCommunicationsForContact } from "../autoLinkService";
import { deriveAuditSpans } from "../importPlanInputs";
import { auditWindowEnd } from "../exportPlan";

const USER_ID = "user-3910";
const USER_EMAIL = "agent@keepr.test";
const TXN = "txn-3910";
const ADDR = "100 Oak Street";
const CONTACT = "contact-3910";
const CONTACT_EMAIL = "lender@example.test";

/** End Date as the date input saves it (date-only). */
const END_DATE = "2026-07-29";
/** Closing Date — deliberately LATER, so reading it would admit the late mail. */
const CLOSING_DEADLINE = "2026-08-20";
const STARTED_AT = "2026-01-01";

/** A LOCAL wall-clock instant on the End Date (+ dayOffset days), as ISO. */
function localInstant(dayOffset: number, h: number, m: number, s: number, ms: number): string {
  return new Date(2026, 6, 29 + dayOffset, h, m, s, ms).toISOString();
}

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
      closing_deadline DATE,
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

    -- BACKLOG-2880: linkEmailToTransaction now asks the review store whether a
    -- human has already been asked to rule on this email. The table is created
    -- by migration v65, so every shipped database has it; a fixture without it
    -- describes a state the app cannot be in, and its absence here made the
    -- whole auto-link pass throw into its own catch and link nothing.
    CREATE TABLE pending_review_communications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      email_id TEXT,
      thread_id TEXT,
      found_at DATETIME
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      thread_id TEXT,
      sent_at DATETIME
    );
  `);
}

function insertDeal(closedAt: string | null): void {
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, status, property_address, started_at, created_at, closed_at, closing_deadline)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(TXN, USER_ID, ADDR, STARTED_AT, STARTED_AT, closedAt, CLOSING_DEADLINE);
  db.prepare(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, removed_at)
     VALUES (?, ?, ?, NULL)`,
  ).run(`tc-${TXN}`, TXN, CONTACT);
}

function insertEmail(id: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, sender, recipients, sent_at, subject, body_plain, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    USER_ID,
    CONTACT_EMAIL,
    USER_EMAIL,
    sentAt,
    `Re: ${ADDR}`,
    `Update on ${ADDR}.`,
    `thread-${id}`,
  );
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, email_address)
     VALUES (?, 'from', 0, ?)`,
  ).run(id, CONTACT_EMAIL);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, email_address)
     VALUES (?, 'to', 0, ?)`,
  ).run(id, USER_EMAIL);
}

/** Every email id attached to the deal OR waiting in its Needs Review, as one sorted set. */
function emailIdsReachingDeal(): string[] {
  return db
    .prepare(
      `SELECT email_id FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL
       UNION
       SELECT email_id FROM pending_review_communications WHERE transaction_id = ? AND email_id IS NOT NULL
       ORDER BY email_id`,
    )
    .all(TXN, TXN)
    .map((r) => (r as { email_id: string }).email_id);
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  setDb(db);
  db.prepare(`INSERT INTO users_local (id, email) VALUES (?, ?)`).run(USER_ID, USER_EMAIL);
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)`).run(
    CONTACT,
    USER_ID,
    "Lender",
  );
  db.prepare(
    `INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)`,
  ).run("ce-1", CONTACT, CONTACT_EMAIL);
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// C-R2b — auto-link candidate window (computed branch, no explicit dateRange)
// ===========================================================================
describe("C-R2b: auto-link stops at the end of the End Date", () => {
  it("links mail through the last minute of the End Date and nothing after it", async () => {
    insertDeal(END_DATE);
    insertEmail("email-end-date-2359", localInstant(0, 23, 59, 0, 0));
    insertEmail("email-next-day-noon", localInstant(1, 12, 0, 0, 0));
    // Inside the old 30-day buffer AND before the (unread) Closing Date.
    insertEmail("email-plus-15-days", localInstant(15, 12, 0, 0, 0));

    await autoLinkCommunicationsForContact({ contactId: CONTACT, transactionId: TXN });

    expect(emailIdsReachingDeal()).toEqual(["email-end-date-2359"]);
  });

  it("REVERSE CONTROL: an open deal (no End Date) still reaches today's mail", async () => {
    insertDeal(null);
    insertEmail("email-end-date-2359", localInstant(0, 23, 59, 0, 0));
    insertEmail("email-plus-15-days", localInstant(15, 12, 0, 0, 0));

    await autoLinkCommunicationsForContact({ contactId: CONTACT, transactionId: TXN });

    expect(emailIdsReachingDeal()).toEqual(["email-end-date-2359", "email-plus-15-days"]);
  });
});

// ===========================================================================
// C-R2c — import-cap protected span
// ===========================================================================
describe("C-R2c: the import-cap protected span ends at the end of the End Date", () => {
  it("a closed deal's span ends at auditWindowEnd(closed_at)", () => {
    insertDeal(END_DATE);

    const spans = deriveAuditSpans(USER_ID);

    expect(spans).toEqual([
      {
        startISO: expect.any(String),
        endISO: auditWindowEnd(END_DATE)!.toISOString(),
      },
    ]);
    // Independently of the helper: the last millisecond of 2026-07-29, local.
    expect(spans[0].endISO).toBe(new Date(2026, 6, 29, 23, 59, 59, 999).toISOString());
  });

  it("an open deal's span stays open-ended", () => {
    insertDeal(null);

    expect(deriveAuditSpans(USER_ID).map((s) => s.endISO)).toEqual([null]);
  });
});
