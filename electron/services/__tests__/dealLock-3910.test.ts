/**
 * @jest-environment node
 */
/**
 * BACKLOG-3910 (slice b) — a locked deal gets nothing automatic.
 *
 * Real driver, real schema (`electron/database/schema.sql`, including
 * `transactions.submission_status` and its CHECK list). Run under the Electron
 * jest runner:
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 *
 * Fixture: one contact (one email address, one phone) assigned to TWO deals.
 * Deal A's submission status varies per test; deal B is always open
 * (`not_submitted`). The contact has one email and one text thread inside both
 * deals' windows, so every automatic path has something to add to BOTH deals.
 * Every assertion is an exact id set, never a count.
 *
 * Paths covered (each is a separate automatic writer or gate):
 *   C-R3a  deal-open sweep          syncReviewQueueForTransaction (review:sync "open")
 *   C-R3b  post-import sweep        autoLinkNewMessagesForUser
 *   C-R3c  thread expansion         expandAttachedThreadsForUser (incl. a deal locked
 *                                   AFTER the expansion watermark was taken)
 *   C-R3e  email writer backstops   linkEmailToTransaction("auto"/"scan"), queueEmailForReview
 *   C-R3f  text writer backstops    createThreadCommunicationReference("auto"),
 *                                   createCommunicationReferenceSync("auto")
 *   C-R3u  unlock                   locked -> needs_changes: the next open sweep and the
 *                                   next expansion add again (no "inputs unchanged" skip)
 */
import fs from "fs";
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
import {
  autoLinkNewMessagesForUser,
  expandAttachedThreadsForUser,
  linkEmailToTransaction,
  resetExpansionWatermarksForTests,
} from "../autoLinkService";
import { queueEmailForReview, syncReviewQueueForTransaction } from "../reviewStateService";
import { createThreadCommunicationReference } from "../db/communicationDbService";
import { createCommunicationReferenceSync } from "../messageMatchingService";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import { computeParticipantHash } from "../../utils/emailAddress";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const USER = "user-3910b";
const USER_EMAIL = "agent@keepr.test";
const CONTACT = "contact-3910b";
const CONTACT_EMAIL = "lender@example.test";
const CONTACT_PHONE = "+12065550103";
const A = "txn-a-3910b";
const B = "txn-b-3910b";
const EMAIL = "email-shared";
const TEXT_THREAD = "T-shared";
const TEXT_MSG = "m-shared";

/** The schema's CHECK list, read from the file so a new status is noticed. */
const ALL_STATUSES = ((): string[] => {
  const m = SCHEMA.match(/submission_status TEXT DEFAULT 'not_submitted' CHECK \(submission_status IN \(([^)]*)\)\)/);
  if (!m) throw new Error("submission_status CHECK list not found in schema.sql");
  return m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
})();
const LOCKED = ["submitted", "under_review", "resubmitted", "approved"];
const OPEN = ["not_submitted", "needs_changes", "rejected"];

let db: DatabaseType;

function seedDeal(id: string, address: string, submissionStatus: string): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, USER, address, submissionStatus);
  db.prepare(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, 'buyer_agent')`,
  ).run(`tc-${id}`, id, CONTACT);
}

function insertText(id: string, threadId: string, sentAt: string): void {
  const last10 = CONTACT_PHONE.replace(/\D/g, "").slice(-10);
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at)
     VALUES (?, ?, 'imessage', 'inbound', 'see you at closing', ?, ?, ?, ?)`,
  ).run(id, USER, JSON.stringify({ from: CONTACT_PHONE, to: ["me"] }), `${last10},me`, threadId, sentAt);
}

function seed(statusA: string): void {
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'o-1')`,
  ).run(USER, USER_EMAIL);
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Lender')`).run(CONTACT, USER);
  db.prepare(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('ce-1', ?, ?, 1)`).run(
    CONTACT,
    CONTACT_EMAIL,
  );
  db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES ('cp-1', ?, ?, 1)`,
  ).run(CONTACT, CONTACT_PHONE);
  seedDeal(A, "100 Oak Street", statusA);
  seedDeal(B, "200 Elm Street", "not_submitted");

  // One email from the contact, naming neither address: both deals' passes find it.
  db.prepare(
    `INSERT INTO emails (id, user_id, sender, recipients, sent_at, subject, body_plain, thread_id)
     VALUES (?, ?, ?, ?, '2026-03-01T15:00:00.000Z', 'Quick question', 'Can we talk tomorrow?', 'et-1')`,
  ).run(EMAIL, USER, CONTACT_EMAIL, USER_EMAIL);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, ?)`,
  ).run(EMAIL, computeParticipantHash(EMAIL, "from", 0, CONTACT_EMAIL), CONTACT_EMAIL);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'to', 0, ?, ?)`,
  ).run(EMAIL, computeParticipantHash(EMAIL, "to", 0, USER_EMAIL), USER_EMAIL);

  // One text thread with the contact.
  insertText(TEXT_MSG, TEXT_THREAD, "2026-03-01T16:00:00.000Z");
}

/** Everything that reached a deal: email links, text links (thread or message) and Needs Review rows. */
function reached(txn: string): string[] {
  return (
    db
      .prepare(
        `SELECT 'email:' || email_id AS k FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL
         UNION SELECT 'thread:' || thread_id FROM communications WHERE transaction_id = ? AND email_id IS NULL AND message_id IS NULL AND thread_id IS NOT NULL
         UNION SELECT 'message:' || message_id FROM communications WHERE transaction_id = ? AND message_id IS NOT NULL
         UNION SELECT 'review:' || COALESCE(email_id, thread_id) FROM pending_review_communications WHERE transaction_id = ?
         ORDER BY k`,
      )
      .all(txn, txn, txn, txn) as Array<{ k: string }>
  ).map((r) => r.k);
}

function setStatus(txn: string, status: string): void {
  db.prepare(`UPDATE transactions SET submission_status = ? WHERE id = ?`).run(status, txn);
}

beforeEach(() => {
  resetExpansionWatermarksForTests();
  __resetFullSweepGuardForTests();
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
});

afterEach(() => {
  db.close();
});

describe("fixture sanity", () => {
  it("the schema's submission statuses are exactly the locked + open lists this file sweeps", () => {
    expect([...ALL_STATUSES].sort()).toEqual([...LOCKED, ...OPEN].sort());
  });
});

// ===========================================================================
// C-R3a — deal-open sweep (review:sync "open")
// ===========================================================================
describe("C-R3a: deal-open sweep", () => {
  it.each(LOCKED)("a %s deal gets nothing new; the open deal on the same contact still does", async (status) => {
    seed(status);

    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    await syncReviewQueueForTransaction({ transactionId: B, reason: "open" });

    expect(reached(A)).toEqual([]);
    expect(reached(B)).toEqual([`review:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });

  it.each(OPEN)("REVERSE: a %s deal still gets the same email and text", async (status) => {
    seed(status);

    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });

    expect(reached(A)).toEqual([`review:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });
});

// ===========================================================================
// C-R3b — post-import sweep (every live contact-deal pair)
// ===========================================================================
describe("C-R3b: post-import sweep", () => {
  it.each(LOCKED)("a %s deal gets nothing; the open deal does", async (status) => {
    seed(status);

    await autoLinkNewMessagesForUser(USER);

    expect(reached(A)).toEqual([]);
    expect(reached(B)).toEqual([`email:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });

  it("REVERSE: with deal A open, the same sweep reaches both deals", async () => {
    seed("needs_changes");

    await autoLinkNewMessagesForUser(USER);

    expect(reached(A)).toEqual([`email:${EMAIL}`, `thread:${TEXT_THREAD}`]);
    expect(reached(B)).toEqual([`email:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });
});

// ===========================================================================
// C-R3c — attached-thread expansion
// ===========================================================================
describe("C-R3c: attached-thread expansion", () => {
  /** A hand-attached text on BOTH deals, plus an unlinked sibling in the same thread. */
  function attachOnBoth(): void {
    for (const txn of [A, B]) {
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source, link_confidence)
         VALUES (?, ?, ?, ?, ?, 'manual', 1.0)`,
      ).run(`comm-${txn}`, USER, txn, TEXT_MSG, TEXT_THREAD);
    }
    insertText("m-sibling", TEXT_THREAD, "2020-01-01T00:00:00.000Z");
  }

  it.each(LOCKED)("a %s deal gets no sibling; the open deal does", async (status) => {
    seed(status);
    attachOnBoth();

    await expandAttachedThreadsForUser(USER);

    expect(reached(A)).toEqual([`message:${TEXT_MSG}`]);
    expect(reached(B)).toEqual([`message:${TEXT_MSG}`, "message:m-sibling"]);
  });

  it("REVERSE: an open deal A gets the sibling", async () => {
    seed("not_submitted");
    attachOnBoth();

    await expandAttachedThreadsForUser(USER);

    expect(reached(A)).toEqual([`message:${TEXT_MSG}`, "message:m-sibling"]);
  });

  it("a deal locked AFTER the last expansion run gets nothing from the next (incremental) run", async () => {
    seed("not_submitted");
    attachOnBoth();
    await expandAttachedThreadsForUser(USER); // watermark taken with A open

    setStatus(A, "submitted");
    insertText("m-new", TEXT_THREAD, "2026-03-02T10:00:00.000Z");
    await expandAttachedThreadsForUser(USER);

    // A keeps what it had before it was locked; the new message goes to B only.
    // (m-sibling went to A on the first run: expansion links an unlinked message
    // once, via messages.transaction_id — existing behaviour, unchanged here.)
    expect(reached(A)).toEqual([`message:${TEXT_MSG}`, "message:m-sibling"]);
    expect(reached(B)).toEqual(["message:m-new", `message:${TEXT_MSG}`]);
  });
});

// ===========================================================================
// C-R3u — unlocking (broker asks for changes) lets automatic additions resume
// ===========================================================================
describe("C-R3u: unlock", () => {
  it("open sweep: nothing while submitted, everything after needs_changes", async () => {
    seed("submitted");
    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    expect(reached(A)).toEqual([]);

    setStatus(A, "needs_changes");
    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });

    expect(reached(A)).toEqual([`review:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });

  it("expansion: nothing while submitted, the sibling after needs_changes", async () => {
    seed("submitted");
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source, link_confidence)
       VALUES ('comm-a', ?, ?, ?, ?, 'manual', 1.0)`,
    ).run(USER, A, TEXT_MSG, TEXT_THREAD);
    insertText("m-sibling", TEXT_THREAD, "2020-01-01T00:00:00.000Z");
    await expandAttachedThreadsForUser(USER);
    expect(reached(A)).toEqual([`message:${TEXT_MSG}`]);

    setStatus(A, "needs_changes");
    await expandAttachedThreadsForUser(USER);

    expect(reached(A)).toEqual([`message:${TEXT_MSG}`, "message:m-sibling"]);
  });
});

// ===========================================================================
// C-R3e / C-R3f — writer backstops, called directly
// ===========================================================================
describe("C-R3e/C-R3f: automatic writers refuse a locked deal; manual writes still land", () => {
  it.each(LOCKED)("%s: email link (auto, scan) and Needs Review queue write nothing", async (status) => {
    seed(status);

    expect(await linkEmailToTransaction(EMAIL, A, "auto")).toBe("locked");
    expect(await linkEmailToTransaction(EMAIL, A, "scan")).toBe("locked");
    expect(await queueEmailForReview(A, EMAIL, USER)).toBe(false);

    expect(reached(A)).toEqual([]);
  });

  it.each(LOCKED)("%s: automatic text links (thread and message) write nothing", async (status) => {
    seed(status);

    expect(await createThreadCommunicationReference(TEXT_THREAD, A, USER, "auto")).toBeNull();
    expect(createCommunicationReferenceSync(TEXT_MSG, A, USER, "auto")).toBeNull();

    expect(reached(A)).toEqual([]);
  });

  it("a manual email link and a manual text link still land on a locked deal", async () => {
    seed("submitted");

    expect(await linkEmailToTransaction(EMAIL, A, "manual")).toBe("linked");
    expect(await createThreadCommunicationReference(TEXT_THREAD, A, USER, "manual")).toEqual(expect.any(String));

    expect(reached(A)).toEqual([`email:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });

  it("REVERSE: on an open deal the automatic writers write", async () => {
    seed("rejected");

    expect(await queueEmailForReview(A, EMAIL, USER)).toBe(true);
    expect(await createThreadCommunicationReference(TEXT_THREAD, A, USER, "auto")).toEqual(expect.any(String));

    expect(reached(A)).toEqual([`review:${EMAIL}`, `thread:${TEXT_THREAD}`]);
  });
});
