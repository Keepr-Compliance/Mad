/**
 * @jest-environment node
 *
 * BACKLOG-2791 / BACKLOG-2792 — the review queue's behavioural contract, against
 * the REAL SQLite driver and the REAL schema.sql (not a hand-written fixture, so
 * the tables here are the tables that ship).
 *
 * What each block pins, and the mutation that was run to prove it can fail:
 *
 *  CONTROL 1 — persistence + dedup. Items survive a dismissal, and a second sync
 *    does NOT re-queue them.
 *
 *    MEASURED, and not what the first draft of this file claimed. Dedup is
 *    defence in depth and EITHER layer alone holds the line, so a single-layer
 *    mutation stays green:
 *      · drop `AND p.id IS NULL` (the JS predicate), keep the indexes → GREEN
 *        (INSERT OR IGNORE + the unique index absorbs it; `changes` is 0)
 *      · drop BOTH the predicate and the unique indexes            → RED, 2 tests
 *    So the predicate is a cheapness optimisation and the UNIQUE INDEX is the
 *    guarantee. Do not write the claim the other way round.
 *
 *    The second sync deliberately runs on the contact-change axis, which ignores
 *    the watermark. With a second "open" run the watermark filters the
 *    candidates out before dedup is ever consulted, and the test passes with NO
 *    dedup at all — measured.
 *
 *  CONTROL 4a — approve links, asserted by exact ID SET, never by count.
 *
 *  CONTROL 4b — reject is durable. A rejected item is NOT resurrected by a later
 *    sync, because rejection writes the same `ignored_communications` suppression
 *    row every discovery path already filters on.
 *
 *  FOUNDER RULING — getReviewState is ONE set: the pending queue unioned with the
 *    legacy BACKLOG-2319 `address_missing` population, both counted, both gating.
 *
 *  WATERMARK — an "open" sync advances it and a "background"/"contact-change" one
 *    does not, which is what stops P2 under-reporting freshly-fetched mail.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
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
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import {
  getReviewState,
  syncReviewQueueForTransaction,
  approveReviewItems,
  rejectReviewItems,
} from "../reviewStateService";

const USER = "u-2791";
const TXN = "t-2791";
const CONTACT = "c-2791";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "../../database/schema.sql"),
  "utf8",
);

/** The two indexes migration v64 creates (schema.sql must not — 2298/2300). */
const V64_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
    ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
    ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;
`;

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V64_INDEXES);
  // MIGRATION-ONLY COLUMNS (v56 tombstones). They are declared on NEITHER table
  // in schema.sql, so a schema.sql-only fixture is a state the app never has:
  // autoLinkService's candidate-transaction count reads `tc.removed_at` and
  // threw "no such column", which its own catch swallowed into "found nothing".
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_reason TEXT;");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-1')",
  ).run(USER, "me@agent.com");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?, ?, ?, ?, ?)",
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(
    CONTACT,
    USER,
    "Paul Buyer",
  );
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)").run(
    "ce-1",
    CONTACT,
    "paul@example.com",
  );
  db.prepare(
    "INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)",
  ).run("tc-1", TXN, CONTACT);
}

/** An in-window email from the contact, discoverable by the sync. */
function addEmail(db: DatabaseType, id: string, subject: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
     VALUES (?, ?, ?, 'paul@example.com', 'hello', '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, USER, subject);
  // Transcribed from schema.sql, not invented: the junction is keyed
  // (email_id, role, position) with a NOT NULL participant_hash.
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'paul@example.com')`,
  ).run(id, `hash-${id}`);
}

function ids(items: Array<{ id: string }>): string[] {
  return items.map((i) => i.id).sort();
}

describe("reviewStateService (BACKLOG-2791)", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);
  });

  afterEach(async () => {
    try {
      await harness.cleanup();
    } catch {
      /* already cleaned */
    }
  });

  describe("CONTROL 1 — the queue persists and does not duplicate", () => {
    it("queues found mail as PENDING, links nothing, and survives a dismissal", async () => {
      addEmail(db, "e1", "Offer");
      addEmail(db, "e2", "Inspection");

      const first = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(first.added).toBe(2);

      // NOT linked — the whole point. `communications` is untouched.
      const links = db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?")
        .get(TXN) as { n: number };
      expect(links.n).toBe(0);

      // "Later" persists nothing and destroys nothing: the items are already
      // in the queue, so the state after a dismissal is simply the state.
      expect(getReviewState(TXN).count).toBe(2);
    });

    it("a second sync does NOT re-queue what is already pending (the 'new' definition)", async () => {
      addEmail(db, "e1", "Offer");
      addEmail(db, "e2", "Inspection");

      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      const before = ids(getReviewState(TXN).items);
      expect(before).toHaveLength(2);

      // The second run uses the contact-change axis, which by design IGNORES the
      // watermark and so genuinely re-examines the very same candidates. That is
      // what makes this a test of the DEDUP rather than of the watermark:
      // measured, with a second "open" run instead, removing BOTH the
      // `p.id IS NULL` predicate AND the unique indexes still left it green,
      // because the watermark alone filtered the candidates out.
      const second = await syncReviewQueueForTransaction({
        transactionId: TXN,
        reason: "contact-change",
        contactIds: [CONTACT],
      });

      // Nothing new, so P2 stays silent...
      expect(second.added).toBe(0);
      // ...and the SET is identical — asserted by id, not by count, so a
      // swap-one-for-another could not pass. This is the assertion that goes red
      // when the dedup is removed: the rows duplicate.
      expect(ids(getReviewState(TXN).items)).toEqual(before);
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?")
        .get(TXN) as { n: number };
      expect(rows.n).toBe(2);
    });

    it("a newly relevant contact's older mail is found, not lost behind the watermark", async () => {
      // Open first with nothing to find → watermark advances to now.
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      // Mail that arrived earlier in the window but is only NOW relevant (the
      // contact was just added). An "open" sync filters it out by created_at;
      // "contact-change" must not, or a newly-added party's history is lost.
      db.prepare(
        `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
         VALUES ('old-1', ?, 'Older thread', 'paul@example.com', 'hi', '2026-06-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      ).run(USER);
      db.prepare(
        `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
         VALUES ('old-1', 'from', 0, 'hash-old-1', 'paul@example.com')`,
      ).run();

      // BACKLOG-2791 (founder ruling, 2026-08-22): classification is delegated to
      // autoLinkCommunicationsForContact, which scans the deal's FULL window on
      // every run — develop's behaviour, restored deliberately. So the watermark
      // no longer BOUNDS discovery; it only decides what counts as newly
      // announced. Mail that predates it is therefore found by either axis, and
      // this test now asserts the property that still matters: a newly relevant
      // contact's older mail is not lost.
      const changeRun = await syncReviewQueueForTransaction({
        transactionId: TXN,
        reason: "contact-change",
        contactIds: [CONTACT],
      });
      expect(changeRun.added).toBe(1);
      expect(getReviewState(TXN).items.map((i) => i.email_id)).toEqual(["old-1"]);
    });
  });

  describe("CONTROL 4a — approve links, by exact identity", () => {
    it("links exactly the approved email and leaves the other pending", async () => {
      addEmail(db, "e1", "Offer");
      addEmail(db, "e2", "Inspection");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const state = getReviewState(TXN);
      const target = state.items.find((i) => i.email_id === "e1");
      expect(target).toBeDefined();

      await approveReviewItems([target!.id]);

      // The linked SET is exactly {e1} — not "one row".
      const linked = db
        .prepare("SELECT email_id FROM communications WHERE transaction_id = ? ORDER BY email_id")
        .all(TXN) as Array<{ email_id: string }>;
      expect(linked.map((r) => r.email_id)).toEqual(["e1"]);

      // e2 is still waiting, and e1 has left the queue.
      const after = getReviewState(TXN);
      expect(after.items.map((i) => i.email_id)).toEqual(["e2"]);
    });

    it("an approved link carries user_confirmed, so it reads as Linked and not as needs-review", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await approveReviewItems([getReviewState(TXN).items[0].id]);

      const row = db
        .prepare("SELECT match_reason FROM communications WHERE email_id = 'e1'")
        .get() as { match_reason: string };
      expect(row.match_reason).toBe("user_confirmed");
      expect(getReviewState(TXN).count).toBe(0);
    });
  });

  describe("CONTROL 4b — reject is durable", () => {
    it("a rejected item is NOT resurrected by a later sync", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      await rejectReviewItems([getReviewState(TXN).items[0].id]);
      expect(getReviewState(TXN).count).toBe(0);

      // A suppression row is what makes it durable — the same row every other
      // discovery path already filters on.
      const ignored = db
        .prepare("SELECT email_id FROM ignored_communications WHERE transaction_id = ?")
        .all(TXN) as Array<{ email_id: string }>;
      expect(ignored.map((r) => r.email_id)).toEqual(["e1"]);

      // Re-sync from scratch: clear the watermark so the scan genuinely
      // re-examines the whole window rather than skipping it for free.
      db.prepare("UPDATE transactions SET last_pending_scan_at = NULL WHERE id = ?").run(TXN);
      const again = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      expect(again.added).toBe(0);
      expect(getReviewState(TXN).count).toBe(0);
    });

    it("a rejected item RESTORED from the Removed section returns to review, not to Linked", async () => {
      // The suppression row is also what the Removed section renders, and the
      // existing restore path recreates the link with the STORED classification
      // — where NULL means "legacy, treat as address_found", i.e. Linked. If a
      // pending rejection stored NULL there would be a one-click path from
      // "rejected, never linked" to "silently linked, never approved", straight
      // through existing UI and around the whole point of this feature.
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await rejectReviewItems([getReviewState(TXN).items[0].id]);

      const row = db
        .prepare("SELECT match_reason FROM ignored_communications WHERE transaction_id = ?")
        .get(TXN) as { match_reason: string | null };
      expect(row.match_reason).toBe("address_missing");
    });
  });

  describe("FOUNDER RULING — one source of trust", () => {
    it("unions the pending queue with the legacy address_missing population into ONE set", async () => {
      // A legacy BACKLOG-2319 row: already LINKED, but flagged for review.
      addEmail(db, "legacy-1", "Ambiguous");
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source, link_confidence, match_reason)
         VALUES ('comm-legacy', ?, ?, 'legacy-1', 'auto', 0.5, 'address_missing')`,
      ).run(USER, TXN);

      // A new-style pending row.
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const state = getReviewState(TXN);
      expect(state.count).toBe(2);
      expect(state.items.map((i) => i.email_id).sort()).toEqual(["e1", "legacy-1"]);
      expect(state.items.map((i) => i.origin).sort()).toEqual(["legacy", "pending"]);

      // count is ALWAYS items.length — a badge cannot disagree with its list.
      expect(state.count).toBe(state.items.length);
    });

    it("approving a legacy item uses the 2319 confirm and clears it from the same set", async () => {
      addEmail(db, "legacy-1", "Ambiguous");
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source, link_confidence, match_reason)
         VALUES ('comm-legacy', ?, ?, 'legacy-1', 'auto', 0.5, 'address_missing')`,
      ).run(USER, TXN);

      const item = getReviewState(TXN).items[0];
      expect(item.origin).toBe("legacy");

      await approveReviewItems([item.id]);

      // The row stays LINKED (it always was) — only its classification moves.
      const row = db
        .prepare("SELECT match_reason FROM communications WHERE id = 'comm-legacy'")
        .get() as { match_reason: string };
      expect(row.match_reason).toBe("user_confirmed");
      expect(getReviewState(TXN).count).toBe(0);
    });
  });

  describe("the watermark", () => {
    it("is advanced by an open sync and left alone by background and contact-change", async () => {
      const read = () =>
        (db.prepare("SELECT last_pending_scan_at AS w FROM transactions WHERE id = ?").get(TXN) as {
          w: string | null;
        }).w;

      expect(read()).toBeNull();

      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      const afterOpen = read();
      expect(afterOpen).not.toBeNull();

      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "background" });
      expect(read()).toBe(afterOpen);

      await syncReviewQueueForTransaction({
        transactionId: TXN,
        reason: "contact-change",
        contactIds: [CONTACT],
      });
      expect(read()).toBe(afterOpen);
    });

    it("an open sync counts what a background run queued moments earlier, so P2 does not under-report", async () => {
      addEmail(db, "e1", "Offer");

      // The provider fetch on this same open queues it first.
      const bg = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "background" });
      expect(bg.added).toBe(1);

      // The open sync inserted nothing of its own, but must still announce it —
      // counting only its own inserts would report 0 for exactly the mail P2
      // exists to announce.
      const open = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(open.added).toBe(1);
    });
  });
});
