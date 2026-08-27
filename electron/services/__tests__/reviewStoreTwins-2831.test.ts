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
 *  REACHABILITY — THE ROUTE IS NOW CLOSED (BACKLOG-2880). It used to be:
 *      open the deal   → the deal-surface sweep QUEUES the ambiguous email
 *      any message import/sync afterwards → autoLinkNewMessagesForUser sweeps
 *        EVERY live contact-transaction pair WITHOUT queueAmbiguousInsteadOfLinking,
 *        so it LINKED the same email as address_missing.
 *    `findCandidateEmailsWithMatch` excludes an email that already has a
 *    `communications` row for the deal — but NOT one that is merely pending, so
 *    the queued email was still a candidate for the linking sweep.
 *
 *    BACKLOG-2880 removed that writer: `linkEmailToTransaction` refuses to write
 *    an AUTO link for an email holding a live pending row. The block runs the
 *    SAME scenario with the assertion INVERTED rather than deleted, so it is now
 *    a second control on that guard.
 *
 *    THE DEDUP BELOW IS NOT DEAD CODE. Every twin written before the guard
 *    shipped is still sitting in a user's database and still has to be counted
 *    once. So the twin is now built as DATA by `makeTwins`, and "the twin fixture
 *    matches what the linker really writes" pins that fixture against the live
 *    producer so it cannot drift from the shape it stands in for.
 *
 *  DEDUP — the union contains the twinned email ONCE, by exact ID set.
 *    Mutation: restore `const items = [...pending, ...legacy]` → RED, 2 of 14
 *    ("returns the twinned email ONCE" and "approving one twinned email does not
 *    touch another email's twin"). Only two tests can see it, because the
 *    approve/reject controls assert the STORES, which the dedup does not touch.
 *    (Mutation counts in this header were measured when the suite had 14 tests
 *    and then 18; it has 19. The FAILING SETS named are what matters and were
 *    re-confirmed — the totals are historical.)
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
 *
 *  FULL BODY (BACKLOG-2844) — the review path carries the whole plain body, not
 *    the card's 200-character preview. Mutation: `bodyText: row.body_plain
 *    ?.trim() || null` → `bodyText: null` → RED, 3 of 18 (the tail, the
 *    paragraph-break and the trim tests). The html-only test stays GREEN, since
 *    that email has no plain part to carry either way.
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
import { autoLinkNewMessagesForUser, linkEmailToTransaction } from "../autoLinkService";

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

/**
 * A TWIN, as it exists in a database written before BACKLOG-2880.
 *
 * The route that used to build one — queue on the deal surface, then let the
 * next `autoLinkNewMessagesForUser` sweep link the same email as
 * address_missing — is CLOSED: `linkEmailToTransaction` now refuses to write an
 * auto link for an email that holds a live pending row. The REACHABILITY block
 * below asserts that closure directly.
 *
 * The dedup this suite covers is therefore NOT dead code. Every twin written
 * before the guard shipped is still sitting in a user's database, and
 * `getReviewState` still has to count it once. So the twin is now constructed as
 * DATA rather than by running the (fixed) producer.
 *
 * `addLegacyLink` is not invented for the purpose: it writes the exact row
 * `linkEmailToTransaction` writes on the auto path — link_source 'auto',
 * confidence 0.5, match_reason 'address_missing', thread_id NULL for these
 * thread-less fixtures. "the twin fixture matches what the linker really
 * writes" below pins that equivalence against the live producer, so this fixture
 * cannot drift away from the shape it stands in for.
 */
async function makeTwins(db: DatabaseType, emailIds: string[]): Promise<void> {
  await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
  for (const id of emailIds) addLegacyLink(db, `comm-twin-${id}`, id);
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
    it("the message-sync sweep no longer writes the twin — BACKLOG-2880 closed this route", async () => {
      // THIS TEST USED TO ASSERT THE OPPOSITE, and was right to: it was the
      // standing proof that the twin was reachable on shipped code. BACKLOG-2880
      // removed the writer, so the same scenario now has the opposite outcome
      // and the assertion is inverted rather than deleted — the scenario is what
      // matters, and it must keep being run.
      addEmail(db, "e1", "Offer");

      // 1. The user opens the deal. The deal surface QUEUES the ambiguous half.
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(pendingEmailIds(db)).toEqual(["e1"]);
      expect(legacyEmailIds(db)).toEqual([]);

      // 2. ANY later message import/sync — macOS Messages import, the Android
      //    companion, localSyncService's debounce — runs this sweep for every
      //    live contact-transaction pair, WITHOUT the queue flag. It reaches
      //    `linkEmailToTransaction`, which now declines: an email a human has
      //    been asked to rule on is not a background classifier's to decide.
      await autoLinkNewMessagesForUser(USER);

      expect(pendingEmailIds(db)).toEqual(["e1"]);
      expect(legacyEmailIds(db)).toEqual([]);
    });

    it("the twin fixture matches what the linker really writes (the control on the fixture)", async () => {
      // `makeTwins` stands in for a producer that can no longer run. If its row
      // drifts from the real one, every twin test below would be exercising a
      // database state that never existed. So: write one row each way and
      // compare the columns getReviewState and the approve/reject paths read.
      addEmail(db, "e-fixture", "Offer");
      addEmail(db, "e-producer", "Offer");

      addLegacyLink(db, "comm-fixture", "e-fixture");
      const outcome = await linkEmailToTransaction(
        "e-producer",
        TXN,
        "auto",
        0.5,
        "address_missing",
      );
      expect(outcome).toBe("linked");

      const shape = (emailId: string) =>
        db
          .prepare(
            `SELECT user_id, transaction_id, link_source, link_confidence, match_reason, thread_id
               FROM communications WHERE email_id = ?`,
          )
          .get(emailId);

      expect(shape("e-fixture")).toEqual(shape("e-producer"));
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
      await makeTwins(db, ["e1"]);

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
      await makeTwins(db, ["e1"]);
      // Without the legacy half there is only one candidate and "the pending one
      // wins" would be vacuously true, so the precondition is asserted.
      expect(legacyEmailIds(db)).toEqual(["e1"]);

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

    it("the snippet stays capped at 200 — it is the CARD's preview, not the body (BACKLOG-2844)", async () => {
      // THIS TEST'S MEANING CHANGED. It used to be titled "KNOWN LIMIT, recorded
      // not fixed" and stood for a reading limitation: 200 characters was all
      // the review path carried, so the modal could not show more. BACKLOG-2844
      // removed that limitation — `display.bodyText` now carries the whole body.
      //
      // The 200 cap survives with a narrower job: `snippet` feeds
      // EmailThreadCard's one-line preview, which whitespace-collapses and
      // truncates anyway. So this now pins that the fix did NOT change the card,
      // rather than recording something unfixed.
      addEmail(db, "e-long", "Long", { bodyPlain: "x".repeat(900) });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-long");
      expect(item!.display.snippet).toHaveLength(200);
    });

    it("carries the WHOLE body, asserted at the TAIL (BACKLOG-2844)", async () => {
      // Asserting the HEAD would pass on the truncated version — the first 200
      // characters are identical either way. Only the tail can tell them apart,
      // so the sentinel sits at the very end of a body far longer than any cap
      // in the chain (200 card, 300 modal).
      const body = `${"filler sentence. ".repeat(60)}THE-LAST-WORD`;
      expect(body.length).toBeGreaterThan(900);
      addEmail(db, "e-full", "Long plain", { bodyPlain: body });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-full");
      expect(item!.display.bodyText).toContain("THE-LAST-WORD");
      expect(item!.display.bodyText).toHaveLength(body.length);
    });

    it("preserves paragraph breaks, because the modal renders whitespace-pre-wrap", async () => {
      // `snippet` collapses every run of whitespace to one space; bodyText must
      // NOT, or a multi-paragraph message arrives as one run-on block.
      addEmail(db, "e-para", "Paragraphs", {
        bodyPlain: "First paragraph.\n\nSecond paragraph.",
      });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-para");
      expect(item!.display.bodyText).toBe("First paragraph.\n\nSecond paragraph.");
      expect(item!.display.snippet).toBe("First paragraph. Second paragraph.");
    });

    it("trims the ends, so a body that opens with blank lines still previews", async () => {
      // Untrimmed, EmailThreadCard's `body_text.substring(0, 200)` would spend
      // its whole preview window on whitespace and render an empty-looking row.
      addEmail(db, "e-pad", "Padded", { bodyPlain: "\n\n   Real first line.\n" });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-pad");
      expect(item!.display.bodyText).toBe("Real first line.");
    });

    it("an email with no plain part carries no bodyText, and still has its html", async () => {
      addEmail(db, "e-html2", "Invite", { bodyPlain: "", bodyHtml: "<p>Only html.</p>" });
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

      const item = getReviewState(TXN).items.find((i) => i.email_id === "e-html2");
      expect(item!.display.bodyText).toBeNull();
      expect(item!.display.body).toBe("<p>Only html.</p>");
    });
  });

  describe("TWIN SURVIVAL — acting on the survivor must resolve BOTH stores", () => {
    it("approve leaves NOTHING behind in either store, and the link reads user_confirmed", async () => {
      addEmail(db, "e1", "Offer");
      await makeTwins(db, ["e1"]);
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
      await makeTwins(db, ["e1"]);
      // The reject path has to clear BOTH stores, so both must be populated.
      expect(legacyEmailIds(db)).toEqual(["e1"]);

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
      await makeTwins(db, ["e1"]);
      expect(legacyEmailIds(db)).toEqual(["e1"]);
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
      await makeTwins(db, ["e1", "e2"]);
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
