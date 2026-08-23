/**
 * @jest-environment node
 *
 * BACKLOG-2831 — an email that lands in BOTH review stores.
 *
 * Store A `pending_review_communications` (queued, never linked) and store B
 * `communications WHERE match_reason='address_missing'` (the legacy 2319
 * population, linked but flagged) are unioned by `getReviewState`. Nothing keeps
 * the two populations disjoint, so the same email can sit in both and the union
 * counted it twice — same `email_id`, two ids, so no id-keyed check upstream
 * noticed. The founder saw "(2 emails)", two identical bubbles and React's
 * "two children with the same key".
 *
 * WHAT EACH BLOCK PINS, and the mutation run to prove it can fail:
 *
 *  REACHABILITY (shipped code, not a hand-built fixture). The route is:
 *      open the deal   → the deal-surface sweep QUEUES the ambiguous email
 *      any message import/sync afterwards → autoLinkNewMessagesForUser sweeps
 *        EVERY live contact-transaction pair WITHOUT queueAmbiguousInsteadOfLinking,
 *        so it LINKS the same email as address_missing.
 *    `findCandidateEmailsWithMatch` excludes an email that already has a
 *    `communications` row for the deal — but NOT one that is merely pending, so
 *    the queued email is still a candidate for the linking sweep.
 *    This block asserts the two ROWS, not the rendered list, so it stays true
 *    after the read-side dedup and remains the standing proof of reachability.
 *
 *  DEDUP — the union contains the twinned email ONCE, by exact ID set.
 *    Mutation: restore `const items = [...pending, ...legacy]` → RED, 2 of 14
 *    ("returns the twinned email ONCE" and "approving one twinned email does not
 *    touch another email's twin"). Only two tests can see it, because the
 *    approve/reject controls assert the STORES, which the dedup does not touch.
 *
 *  NO OVER-COLLAPSE — two genuinely different emails that merely share a
 *    `thread_id` stay two items; a pure-pending and a pure-legacy set are
 *    unchanged. Mutation: dedup on `thread_id` instead of `email_id` → RED, 3
 *    of 14 — the two above PLUS the over-collapse test, which is the one that
 *    exists solely to catch this wrong key.
 *
 *  TWIN SURVIVAL — approve/reject act on the surviving item and must resolve
 *    BOTH stores. Before the fix, approve on the pending twin called
 *    `linkEmailToTransaction`, which returns "already_linked" and deliberately
 *    leaves the existing `match_reason` alone (2319), so the legacy row stayed
 *    `address_missing` and the "reviewed" email remained in `getReviewState` —
 *    a ghost that keeps the Complete gate shut. Mutation: drop both
 *    resolveLegacyTwins calls → RED, 4 of 14 (every test in the block).
 *
 *  NO CONTENT — the display projection carries the email's HTML, so a message
 *    whose only body is HTML is readable. Mutation: `body: row.body_html` →
 *    `body: null` in emailDisplay → RED, 1 of 14 (the html-only test). The
 *    genuinely-body-less case stays GREEN under that mutation, which is what
 *    makes it a real negative rather than a restatement of the positive.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
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
import { autoLinkNewMessagesForUser } from "../autoLinkService";

const USER = "u-2831";
const TXN = "t-2831";
const CONTACT = "c-2831";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

/** The two indexes migration v64 creates (schema.sql must not — 2298/2300). */
const V64_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
    ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
    ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;
`;

/**
 * The deal has a property address and the mail never names it — which is what
 * makes every candidate `address_missing`, i.e. the review population. Without
 * an address on the deal `addressMatched` is null and everything classifies as
 * confident, which is a different (and silent) test.
 */
function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V64_INDEXES);
  // MIGRATION-ONLY COLUMNS (v56 tombstones), declared on NEITHER table in
  // schema.sql. autoLinkService's candidate-transaction count reads
  // `tc.removed_at`; without them it throws into its own catch and reports
  // "found nothing", which would make this whole file pass for the wrong reason.
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_reason TEXT;");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-1')",
  ).run(USER, "me@agent.com");
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?, ?, ?, ?, ?)`,
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
function addEmail(
  db: DatabaseType,
  id: string,
  subject: string,
  opts: { threadId?: string | null; bodyPlain?: string | null; bodyHtml?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, body_html, thread_id, sent_at, created_at)
     VALUES (?, ?, ?, 'paul@example.com', ?, ?, ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(
    id,
    USER,
    subject,
    opts.bodyPlain === undefined ? "hello" : opts.bodyPlain,
    opts.bodyHtml ?? null,
    opts.threadId ?? null,
  );
  // Transcribed from schema.sql: keyed (email_id, role, position) with a NOT
  // NULL participant_hash.
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'paul@example.com')`,
  ).run(id, `hash-${id}`);
}

/** A legacy BACKLOG-2319 row: already LINKED, flagged for review. */
function addLegacyLink(db: DatabaseType, commId: string, emailId: string): void {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source, link_confidence, match_reason)
     VALUES (?, ?, ?, ?, 'auto', 0.5, 'address_missing')`,
  ).run(commId, USER, TXN, emailId);
}

const pendingEmailIds = (db: DatabaseType): string[] =>
  (
    db
      .prepare(
        "SELECT email_id FROM pending_review_communications WHERE transaction_id = ? ORDER BY email_id",
      )
      .all(TXN) as Array<{ email_id: string | null }>
  ).map((r) => r.email_id ?? "");

const legacyEmailIds = (db: DatabaseType): string[] =>
  (
    db
      .prepare(
        `SELECT email_id FROM communications
          WHERE transaction_id = ? AND match_reason = 'address_missing'
          ORDER BY email_id`,
      )
      .all(TXN) as Array<{ email_id: string | null }>
  ).map((r) => r.email_id ?? "");

const reviewEmailIds = (): string[] =>
  getReviewState(TXN)
    .items.map((i) => i.email_id ?? "")
    .sort();

describe("BACKLOG-2831 — the same email in BOTH review stores", () => {
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

  describe("REACHABILITY on the shipped code path", () => {
    it("a queued email is LINKED as address_missing by the next message-sync sweep, landing in both stores", async () => {
      addEmail(db, "e1", "Offer");

      // 1. The user opens the deal. The deal surface QUEUES the ambiguous half.
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(pendingEmailIds(db)).toEqual(["e1"]);
      expect(legacyEmailIds(db)).toEqual([]);

      // 2. ANY later message import/sync — macOS Messages import, the Android
      //    companion, localSyncService's debounce — runs this sweep for every
      //    live contact-transaction pair, WITHOUT the queue flag.
      await autoLinkNewMessagesForUser(USER);

      // The pending row is not a link, so the candidate query never excluded it:
      // the same email is now in BOTH stores. This is the defect's precondition,
      // asserted on ROWS so it survives the read-side dedup.
      expect(pendingEmailIds(db)).toEqual(["e1"]);
      expect(legacyEmailIds(db)).toEqual(["e1"]);
    });

    it("ordering matters: link-first leaves the email in the legacy store ONLY", async () => {
      // The mirror case, so the reachability claim is not overstated. When the
      // linking sweep runs BEFORE the deal is opened, the email is already in
      // `communications` and `findCandidateEmailsWithMatch`'s
      // `LEFT JOIN communications ... AND c.id IS NULL` excludes it, so the
      // deal-surface sweep never queues it. No twin.
      addEmail(db, "e1", "Offer");

      await autoLinkNewMessagesForUser(USER);
      expect(legacyEmailIds(db)).toEqual(["e1"]);

      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(pendingEmailIds(db)).toEqual([]);
      expect(legacyEmailIds(db)).toEqual(["e1"]);
    });
  });

  describe("DEDUP — the union counts a twinned email once", () => {
    it("returns the twinned email ONCE, as an exact ID set", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);

      // Precondition: genuinely in both stores (not a fixture that only claims to be).
      expect(pendingEmailIds(db)).toEqual(["e1"]);
      expect(legacyEmailIds(db)).toEqual(["e1"]);

      const state = getReviewState(TXN);
      expect(state.items.map((i) => i.email_id)).toEqual(["e1"]);
      // The badge, P2/P3 and the Complete gate all read this number.
      expect(state.count).toBe(1);
      expect(state.count).toBe(state.items.length);
    });

    it("the PENDING row wins, because it is the one carrying the review lifecycle", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);

      const [survivor] = getReviewState(TXN).items;
      expect(survivor.origin).toBe("pending");
      // The id is the pending row's, so approve/reject route through the
      // lifecycle-aware branch rather than through the 2319 confirm.
      const pendingRowId = (
        db
          .prepare("SELECT id FROM pending_review_communications WHERE email_id = 'e1'")
          .get() as { id: string }
      ).id;
      expect(survivor.id).toBe(`pending:${pendingRowId}`);
    });

    it("does not over-collapse: two different emails sharing a thread stay two items", async () => {
      // The over-collapse control. Deduping on `thread_id` rather than
      // `email_id` would merge these two into one and silently hide a real
      // needs-review email.
      addEmail(db, "e1", "Offer", { threadId: "th-1" });
      addEmail(db, "e2", "Re: Offer", { threadId: "th-1" });

      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(reviewEmailIds()).toEqual(["e1", "e2"]);
    });

    it("leaves a pure-pending set and a pure-legacy set exactly as they were", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      addEmail(db, "legacy-1", "Ambiguous");
      addLegacyLink(db, "comm-legacy", "legacy-1");

      const state = getReviewState(TXN);
      expect(state.items.map((i) => i.email_id).sort()).toEqual(["e1", "legacy-1"]);
      expect(state.items.map((i) => i.origin).sort()).toEqual(["legacy", "pending"]);
      expect(state.count).toBe(2);
    });

    it("a TEXT item is never collapsed into an email (thread_id is not the key)", async () => {
      // Texts live only in the pending store, so they cannot twin — but a naive
      // dedup keyed on a shared NULL email_id would fold every text into one.
      db.prepare(
        `INSERT INTO messages (id, user_id, thread_id, body_text, sent_at, direction, participants_flat, channel)
         VALUES (?, ?, ?, ?, '2026-06-02T00:00:00.000Z', 'inbound', '+15550100', 'sms')`,
      ).run("m-1", USER, "th-a", "hi there");
      db.prepare(
        `INSERT INTO messages (id, user_id, thread_id, body_text, sent_at, direction, participants_flat, channel)
         VALUES (?, ?, ?, ?, '2026-06-03T00:00:00.000Z', 'inbound', '+15550199', 'sms')`,
      ).run("m-2", USER, "th-b", "and hello");
      db.prepare(
        `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id, thread_id, found_at)
         VALUES ('p-a', ?, ?, NULL, 'th-a', CURRENT_TIMESTAMP)`,
      ).run(USER, TXN);
      db.prepare(
        `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id, thread_id, found_at)
         VALUES ('p-b', ?, ?, NULL, 'th-b', CURRENT_TIMESTAMP)`,
      ).run(USER, TXN);

      const state = getReviewState(TXN);
      expect(state.items.map((i) => i.thread_id).sort()).toEqual(["th-a", "th-b"]);
      expect(state.count).toBe(2);
    });
  });


  describe('"No content" — the display projection carried no HTML at all', () => {
    it("an HTML-only email projects its html, so the reading modal has something to show", async () => {
      // The producing shape, transcribed from outlookFetchService `_parseMessage`
      // (:1219-1223): Graph gives ONE body object plus a preview, and the mapper
      // stores `body.content` in body_html and `bodyPreview || ""` in body_plain
      // — there is no html-to-text derivation anywhere in ingestion. So an HTML
      // message with an empty preview (a calendar invite, an attachment-only
      // mail) lands with an EMPTY body_plain and a full body_html. That is a
      // state the app really produces, not an invented one.
      addEmail(db, "e-html", "Invite", {
        bodyPlain: "",
        bodyHtml: "<p>Closing moved to Friday.</p>",
      });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-html");
      expect(item).toBeDefined();
      // The snippet is empty — this is WHY the modal said "No content", and it
      // stays empty; the fix is not to fake a preview.
      expect(item!.display.snippet).toBe("");
      // ...but the html now travels with the item, which is what the modal's
      // `body_html || body` fallback reads.
      expect(item!.display.body).toBe("<p>Closing moved to Friday.</p>");
    });

    it("a plain-text email still carries no html, and a text item never does", async () => {
      addEmail(db, "e-plain", "Offer", { bodyPlain: "Here is the offer." });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-plain");
      expect(item!.display.snippet).toBe("Here is the offer.");
      expect(item!.display.body).toBeNull();
    });

    it("KNOWN LIMIT, recorded not fixed: the snippet is capped at 200 chars", async () => {
      // The reading modal shows `snippet` for a plain-text review item, so it is
      // a READING surface fed a PREVIEW. The linked loader projects the whole
      // `e.body_plain` (communicationDbService: `COALESCE(m.body_text,
      // e.body_plain) AS body_text`), so the same email reads in full once
      // linked. Carrying the full plain body for every queued item is an IPC
      // payload decision, so it is pinned here as a known asymmetry rather than
      // changed silently — if someone lifts the cap, this test tells them what
      // they are changing.
      addEmail(db, "e-long", "Long", { bodyPlain: "x".repeat(900) });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-long");
      expect(item!.display.snippet).toHaveLength(200);
    });
  });

  describe("TWIN SURVIVAL — acting on the survivor must resolve BOTH stores", () => {
    it("approve leaves NOTHING behind in either store, and the link reads user_confirmed", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);
      expect(pendingEmailIds(db)).toEqual(["e1"]);
      expect(legacyEmailIds(db)).toEqual(["e1"]);

      const { approved } = await approveReviewItems([getReviewState(TXN).items[0].id]);
      expect(approved).toBe(1);

      // Neither store still holds it as needing review...
      expect(pendingEmailIds(db)).toEqual([]);
      expect(legacyEmailIds(db)).toEqual([]);
      // ...the link survives and now reads as the user's decision...
      const links = db
        .prepare("SELECT match_reason FROM communications WHERE transaction_id = ? AND email_id = 'e1'")
        .all(TXN) as Array<{ match_reason: string }>;
      expect(links.map((r) => r.match_reason)).toEqual(["user_confirmed"]);
      // ...and the gate is clear.
      expect(getReviewState(TXN).count).toBe(0);
    });

    it("reject clears both stores and writes exactly ONE suppression row", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);

      const { rejected } = await rejectReviewItems([getReviewState(TXN).items[0].id]);
      expect(rejected).toBe(1);

      expect(pendingEmailIds(db)).toEqual([]);
      expect(legacyEmailIds(db)).toEqual([]);
      // The link row is gone too — rejecting means "not part of this deal".
      const anyLink = db
        .prepare("SELECT id FROM communications WHERE transaction_id = ? AND email_id = 'e1'")
        .all(TXN);
      expect(anyLink).toEqual([]);
      // One suppression row, not two: the Removed section renders these, and a
      // duplicate is a second card with a second Restore for one email.
      const ignored = db
        .prepare("SELECT email_id, match_reason FROM ignored_communications WHERE transaction_id = ?")
        .all(TXN) as Array<{ email_id: string; match_reason: string | null }>;
      expect(ignored.map((r) => r.email_id)).toEqual(["e1"]);
      expect(ignored.map((r) => r.match_reason)).toEqual(["address_missing"]);
      expect(getReviewState(TXN).count).toBe(0);
    });

    it("a rejected twin is not resurrected by the next sweep of EITHER path", async () => {
      addEmail(db, "e1", "Offer");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);
      await rejectReviewItems([getReviewState(TXN).items[0].id]);

      // Clear the watermark so the deal-surface scan genuinely re-examines the
      // window rather than skipping it for free.
      db.prepare("UPDATE transactions SET last_pending_scan_at = NULL WHERE id = ?").run(TXN);
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);

      expect(pendingEmailIds(db)).toEqual([]);
      expect(legacyEmailIds(db)).toEqual([]);
      expect(getReviewState(TXN).count).toBe(0);
    });

    it("approving one twinned email does not touch another email's twin", async () => {
      // Identity, not count: approving e1 must leave e2 in BOTH its stores.
      addEmail(db, "e1", "Offer");
      addEmail(db, "e2", "Inspection");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      await autoLinkNewMessagesForUser(USER);
      expect(pendingEmailIds(db)).toEqual(["e1", "e2"]);
      expect(legacyEmailIds(db)).toEqual(["e1", "e2"]);

      const target = getReviewState(TXN).items.find((i) => i.email_id === "e1");
      await approveReviewItems([target!.id]);

      expect(pendingEmailIds(db)).toEqual(["e2"]);
      expect(legacyEmailIds(db)).toEqual(["e2"]);
      expect(reviewEmailIds()).toEqual(["e2"]);
    });
  });
});
