/**
 * @jest-environment node
 */
/**
 * BACKLOG-3925 — address-only Needs Review matches from the LOCAL email cache.
 *
 * Real driver, real schema (`electron/database/schema.sql`). Run under the Electron
 * jest runner:
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 *
 * Fixture: one contact (lender@example.test) on TWO deals —
 *   A "1428 Maple Ave, Springfield"  (window from 2026-01-01, open-ended)
 *   B "100 Main St"                  (same window)
 * and a set of cached emails, each built to sit on one boundary of the rule. Every
 * assertion is an exact set of (email, reason), never a count. Reserved .test
 * addresses and invented ids only.
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
import { linkEmailToTransaction, resetExpansionWatermarksForTests } from "../autoLinkService";
import {
  ADDRESS_MATCH_CAP_PER_DEAL,
  approveReviewItems,
  getReviewState,
  queueAddressMatchesForTransaction,
  queueEmailForReview,
  rejectReviewItems,
  restoreRejectedToQueue,
  syncReviewQueueForTransaction,
} from "../reviewStateService";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import { computeParticipantHash } from "../../utils/emailAddress";
import {
  REVIEW_MATCH_REASON_PRECEDENCE,
  strongerReviewMatchReason,
} from "../../types/ipc/reviewMatchReason";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const USER = "user-3925";
const USER_EMAIL = "agent@keepr.test";
const CONTACT = "contact-3925";
const CONTACT_EMAIL = "lender@example.test";
const STRANGER = "neighbour@example.test";
const A = "txn-a-3925";
const B = "txn-b-3925";
const IN_WINDOW = "2026-03-01T15:00:00.000Z";

let db: DatabaseType;

function seedDeal(id: string, address: string | null, status = "not_submitted"): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, USER, address, status);
  db.prepare(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, 'buyer_agent')`,
  ).run(`tc-${id}`, id, CONTACT);
}

function insertEmail(id: string, from: string, subject: string, body: string, sentAt = IN_WINDOW): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, sender, recipients, sent_at, subject, body_plain, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, USER, from, USER_EMAIL, sentAt, subject, body, `th-${id}`);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, ?)`,
  ).run(id, computeParticipantHash(id, "from", 0, from), from);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'to', 0, ?, ?)`,
  ).run(id, computeParticipantHash(id, "to", 0, USER_EMAIL), USER_EMAIL);
}

function seedBase(statusA = "not_submitted", addressA: string | null = "1428 Maple Ave, Springfield"): void {
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'o-1')`,
  ).run(USER, USER_EMAIL);
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Lender')`).run(CONTACT, USER);
  db.prepare(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('ce-1', ?, ?, 1)`).run(
    CONTACT,
    CONTACT_EMAIL,
  );
  seedDeal(A, addressA, statusA);
  seedDeal(B, "100 Main St");
}

/** The boundary corpus. */
function seedCorpus(): void {
  // Address match for A: full spelling of the abbreviated deal suffix.
  insertEmail("e-addr", STRANGER, "Showing feedback for 1428 Maple Avenue", "Buyers loved it.");
  // Address match for A with a unit number, address only in the body.
  insertEmail("e-unit", STRANGER, "HOA question", "Writing about 1428 Maple Ave #4 — is the fee monthly?");
  // Street name without the number: NOT a match.
  insertEmail("e-name-only", STRANGER, "Maple Ave open house", "Lovely street, Maple Ave.");
  // The number inside a longer number: NOT a match (11428 / 14280).
  insertEmail("e-number-inside", STRANGER, "11428 Maple Ave", "Also see 14280 Maple Ave.");
  // Address match for B with the number inside another number for A's sake.
  insertEmail("e-main", STRANGER, "100 Main Street inspection", "Inspector at 9.");
  insertEmail("e-main-1100", STRANGER, "1100 Main St", "Different house.");
  // From the deal contact, naming A's address: the CONTACT route links it.
  insertEmail("e-contact-addr", CONTACT_EMAIL, "Appraisal for 1428 Maple Ave", "Attached.");
  // From the deal contact, naming nothing: the contact route queues it ("contact").
  insertEmail("e-contact-plain", CONTACT_EMAIL, "Quick question", "Can we talk tomorrow?");
  // Outside the window (deal starts 2026-01-01): NOT a match.
  insertEmail("e-old", STRANGER, "1428 Maple Ave last year", "Old listing.", "2025-06-01T00:00:00.000Z");
}

function pending(txn: string): string[] {
  return (
    db
      .prepare(
        `SELECT p.email_id || ':' || COALESCE(r.reason, '-') AS k
           FROM pending_review_communications p
           LEFT JOIN pending_review_match_reasons r
             ON r.transaction_id = p.transaction_id AND r.email_id = p.email_id
          WHERE p.transaction_id = ? AND p.email_id IS NOT NULL
          ORDER BY k`,
      )
      .all(txn) as Array<{ k: string }>
  ).map((r) => r.k);
}

function linked(txn: string): string[] {
  return (
    db
      .prepare(`SELECT email_id AS k FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL ORDER BY k`)
      .all(txn) as Array<{ k: string }>
  ).map((r) => r.k);
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

describe("BACKLOG-3925 discovery on the deal-open sweep", () => {
  it("C1/C2/C5: queues exactly the address-only emails for A, with reasons; the contact route keeps its own", async () => {
    seedBase();
    seedCorpus();

    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });

    expect(pending(A)).toEqual(["e-addr:address", "e-contact-plain:contact", "e-unit:address"]);
    expect(linked(A)).toEqual(["e-contact-addr"]);
  });

  it("C3: cross-deal — B gets its own address match and none of A's; A gets none of B's", async () => {
    seedBase();
    seedCorpus();

    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    await syncReviewQueueForTransaction({ transactionId: B, reason: "open" });

    expect(pending(B)).toEqual(["e-contact-plain:contact", "e-main:address"]);
    expect(pending(A)).not.toContain("e-main:address");
  });

  it("getReviewState projects the reason on each item (texts/legacy/no-row read as contact)", async () => {
    seedBase();
    seedCorpus();
    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });

    const byEmail = Object.fromEntries(getReviewState(A).items.map((i) => [i.email_id, i.matchReason]));
    expect(byEmail).toEqual({ "e-addr": "address", "e-unit": "address", "e-contact-plain": "contact" });
  });

  it("C5: an email with a deal contact on it is never an address item, even before the contact pass runs", async () => {
    seedBase();
    seedCorpus();

    const r = await queueAddressMatchesForTransaction(A);

    expect(pending(A)).toEqual(["e-addr:address", "e-unit:address"]);
    expect(r).toMatchObject({ queued: 2, matched: 2, capped: false });
  });

  it("a deal with no street number gets no address pass", async () => {
    seedBase("not_submitted", "Maple Ave, Springfield");
    seedCorpus();

    const r = await queueAddressMatchesForTransaction(A);

    expect(r.skipped).toBe("no-address");
    expect(pending(A)).toEqual([]);
  });
});

describe("C4 — locked deals queue nothing", () => {
  it.each(["submitted", "under_review", "resubmitted", "approved"])(
    "a %s deal: the pass is skipped before any read",
    async (status) => {
      seedBase(status);
      seedCorpus();

      const r = await queueAddressMatchesForTransaction(A);

      expect(r).toEqual({ queued: 0, candidates: 0, matched: 0, capped: false, skipped: "locked" });
      expect(pending(A)).toEqual([]);
    },
  );

  it("the backstop: queueEmailForReview refuses an address item on a locked deal", async () => {
    seedBase("submitted");
    seedCorpus();

    expect(await queueEmailForReview(A, "e-addr", USER, "address")).toBe(false);
    expect(pending(A)).toEqual([]);
  });
});

describe("C6 — already decided or already waiting is not queued again", () => {
  it("already linked to the deal", async () => {
    seedBase();
    seedCorpus();
    await linkEmailToTransaction("e-addr", A, "manual", 0.95, "user_confirmed");

    await queueAddressMatchesForTransaction(A);

    expect(pending(A)).toEqual(["e-unit:address"]);
  });

  it("already rejected for the deal, and restore brings it back as an ADDRESS item (C7)", async () => {
    seedBase();
    seedCorpus();
    await queueAddressMatchesForTransaction(A);
    const item = getReviewState(A).items.find((i) => i.email_id === "e-addr");
    expect(item?.matchReason).toBe("address");

    await rejectReviewItems([item!.id]);
    await queueAddressMatchesForTransaction(A);
    expect(pending(A)).toEqual(["e-unit:address"]);

    const ignored = db
      .prepare(`SELECT id FROM ignored_communications WHERE transaction_id = ? AND email_id = 'e-addr'`)
      .get(A) as { id: string };
    expect(await restoreRejectedToQueue(ignored.id)).toBe(1);
    expect(pending(A)).toEqual(["e-addr:address", "e-unit:address"]);
  });

  it("a second pass adds nothing", async () => {
    seedBase();
    seedCorpus();
    const first = await queueAddressMatchesForTransaction(A);
    const second = await queueAddressMatchesForTransaction(A);
    expect(first.queued).toBe(2);
    expect(second).toMatchObject({ queued: 0, matched: 0 });
  });
});

describe("C8 — precedence (address over contact), one list", () => {
  it("the order lives in REVIEW_MATCH_REASON_PRECEDENCE", () => {
    expect(REVIEW_MATCH_REASON_PRECEDENCE).toEqual(["address", "contact"]);
    expect(strongerReviewMatchReason("contact", "address")).toBe("address");
    expect(strongerReviewMatchReason("address", "contact")).toBe("address");
    expect(strongerReviewMatchReason(null, "contact")).toBe("contact");
  });

  it("contact first, then address -> address", async () => {
    seedBase();
    seedCorpus();
    await queueEmailForReview(A, "e-addr", USER, "contact");
    await queueEmailForReview(A, "e-addr", USER, "address");
    expect(pending(A)).toEqual(["e-addr:address"]);
  });

  it("address first, then contact -> address", async () => {
    seedBase();
    seedCorpus();
    await queueEmailForReview(A, "e-addr", USER, "address");
    await queueEmailForReview(A, "e-addr", USER, "contact");
    expect(pending(A)).toEqual(["e-addr:address"]);
  });
});

describe("C9 — approving an address item settles it", () => {
  it("leaves the queue, links as user_confirmed, no legacy twin", async () => {
    seedBase();
    seedCorpus();
    await queueAddressMatchesForTransaction(A);
    const item = getReviewState(A).items.find((i) => i.email_id === "e-addr")!;

    await approveReviewItems([item.id]);

    expect(getReviewState(A).items.map((i) => i.email_id)).toEqual(["e-unit"]);
    const row = db
      .prepare(`SELECT match_reason FROM communications WHERE transaction_id = ? AND email_id = 'e-addr'`)
      .get(A) as { match_reason: string };
    expect(row.match_reason).toBe("user_confirmed");
  });
});

describe("C10 — noise cap", () => {
  it(`queues at most ${ADDRESS_MATCH_CAP_PER_DEAL} address items per deal, newest first`, async () => {
    seedBase();
    const total = ADDRESS_MATCH_CAP_PER_DEAL + 10;
    for (let i = 0; i < total; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const hour = String(i % 24).padStart(2, "0");
      insertEmail(`e-flood-${i}`, STRANGER, `Newsletter ${i}`, `Open house at 1428 Maple Ave`, `2026-02-${day}T${hour}:00:00.000Z`);
    }

    const first = await queueAddressMatchesForTransaction(A);
    expect(first).toMatchObject({ queued: ADDRESS_MATCH_CAP_PER_DEAL, matched: total, capped: true });

    const newest = (
      db
        .prepare(`SELECT id FROM emails WHERE id LIKE 'e-flood-%' ORDER BY sent_at DESC LIMIT ?`)
        .all(ADDRESS_MATCH_CAP_PER_DEAL) as Array<{ id: string }>
    )
      .map((r) => `${r.id}:address`)
      .sort();
    expect(pending(A)).toEqual(newest);

    const second = await queueAddressMatchesForTransaction(A);
    expect(second).toMatchObject({ queued: 0, capped: true });
  });
});

describe("schema — the new table is idempotent on an existing database", () => {
  it("re-running schema.sql over a database with queued rows keeps every row and one table", async () => {
    seedBase();
    seedCorpus();
    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    const before = pending(A);

    db.exec(SCHEMA);
    db.exec(SCHEMA);

    expect(pending(A)).toEqual(before);
    const tables = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'pending_review_match_reasons'`)
      .get() as { n: number };
    expect(tables.n).toBe(1);
  });

  it("a pre-3925 database (no reasons table, rows queued) gains the table and reads every row as contact", async () => {
    seedBase();
    seedCorpus();
    db.exec(`DROP TABLE pending_review_match_reasons`);
    db.prepare(
      `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id) VALUES ('p-old', ?, ?, 'e-contact-plain')`,
    ).run(USER, A);

    db.exec(SCHEMA);

    expect(getReviewState(A).items.map((i) => `${i.email_id}:${i.matchReason}`)).toEqual(["e-contact-plain:contact"]);
  });
});
