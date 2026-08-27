/**
 * @jest-environment node
 *
 * BACKLOG-2880 — the "Sync" button silently LINKED mail that was queued for
 * review seconds earlier.
 *
 * OBSERVED on the founder's machine, three matcher passes inside 25 seconds on
 * one contact/transaction pair:
 *
 *   A  15:28:46.021  contact save        flag TRUE   -> queued 9
 *   B  15:28:46.036  contact save sync   flag TRUE   -> alreadyLinked 9 (A's rows)
 *   C  15:29:11.473  "Sync Emails" click flag FALSE  -> emailsLinked 9
 *
 * Pass C took `linkEmailToTransaction` for the SAME nine address-unmatched
 * candidates, writing `match_reason='address_missing'` links over rows a human
 * had already been asked to rule on. `linkEmailToTransaction` does not delete
 * the pending row, so the nine ended up in BOTH stores (BACKLOG-2831's twin).
 *
 * The founder's standing rule is that nothing is ever silently linked — it is
 * why BACKLOG-2791 exists. A shipped button labelled *Sync* broke it.
 *
 * TWO defences, because one of them alone leaves a hole:
 *
 *   1. The Sync button now passes `queueForReviewInsteadOfLinking: true`, so it
 *      behaves like every other deal-surface discovery path: confident mail
 *      links, ambiguous mail QUEUES. (A per-call-site argument — the parameter
 *      default in emailSyncService is deliberately NOT changed.)
 *
 *   2. `linkEmailToTransaction` refuses to write an AUTO link for an email that
 *      already holds a live pending row. That covers callers nobody enumerated,
 *      including `autoLinkNewMessagesForUser`, which sweeps every live
 *      contact-transaction pair after any message import and cannot be given the
 *      flag (the founder's scope decision keeps the global pipelines
 *      auto-linking, pinned by reviewQueueTriggers-2791).
 *
 * WHY THE GUARD IS SCOPED TO `linkSource === "auto"`. `approveReviewItems`
 * links with `"manual"` and deletes the pending row AFTERWARDS, so an unscoped
 * guard would make APPROVAL itself a silent no-op — the guard would break the
 * feature it exists to defend. "Approve still links" below is that control.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
// `captureMessage` is mocked deliberately. autoLinkService's BACKLOG-1340
// zero-results warning calls it on any pass that links nothing, and a
// queue-only pass links nothing. Omitting it throws inside the try block, which
// the outer catch swallows — the DB assertions would still pass while every
// statement after the Sentry block, INCLUDING the completion log this suite
// pins, was silently skipped.
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
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

import * as Sentry from "@sentry/electron/main";
import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import {
  autoLinkCommunicationsForContact,
  autoLinkNewMessagesForUser,
} from "../autoLinkService";
import {
  approveReviewItems,
  getReviewState,
  syncReviewQueueForTransaction,
} from "../reviewStateService";
import logService from "../logService";

const USER = "u-2880";
const TXN = "t-2880";
const CONTACT = "c-2880";
const ADDRESS = "884 Dale Dr SE";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");
const V65_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
    ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
    ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;`;

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(V65_INDEXES);
  // MIGRATION-ONLY COLUMNS — the v56 tombstones are added by the chain and are
  // on NEITHER table in schema.sql. Without them autoLinkService's
  // candidate-transaction count throws "no such column: tc.removed_at" into its
  // own catch and silently reports "found nothing", so every email would fall
  // through to the queue and this suite would pass for the wrong reason.
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_reason TEXT;");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google','o1')",
  ).run(USER, "me@agent.com");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?,?,?,?,?)",
  ).run(TXN, USER, ADDRESS, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?,?,?)").run(
    CONTACT,
    USER,
    "Jane Seller",
  );
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?,?,?)").run(
    "ce1",
    CONTACT,
    "jane@example.com",
  );
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?,?,?)").run(
    "tc1",
    TXN,
    CONTACT,
  );
}

/** An email that never names the property address — the review candidate. */
function addAmbiguousEmail(db: DatabaseType, id: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
     VALUES (?,?,?, 'jane@example.com', 'Are you free on Thursday?', '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, USER, `Subject ${id}`);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'jane@example.com')`,
  ).run(id, `h-${id}`);
}

/** An email that names the address — must keep linking, guard or no guard. */
function addConfidentEmail(db: DatabaseType, id: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
     VALUES (?,?,?, 'jane@example.com', ?, '2026-06-02T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, USER, `Subject ${id}`, `Closing docs for ${ADDRESS} attached.`);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'jane@example.com')`,
  ).run(id, `h-${id}`);
}

const linkedEmailIds = (db: DatabaseType): string[] =>
  (
    db
      .prepare(
        "SELECT email_id FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL ORDER BY email_id",
      )
      .all(TXN) as Array<{ email_id: string }>
  ).map((r) => r.email_id);

const queuedEmailIds = (db: DatabaseType): string[] =>
  (
    db
      .prepare(
        "SELECT email_id FROM pending_review_communications WHERE transaction_id = ? AND email_id IS NOT NULL ORDER BY email_id",
      )
      .all(TXN) as Array<{ email_id: string }>
  ).map((r) => r.email_id);

/** The flag=false pass — exactly what the Sync button did at 15:29:11. */
const autoPassWithoutFlag = () =>
  autoLinkCommunicationsForContact({ contactId: CONTACT, transactionId: TXN });

describe("BACKLOG-2880 — an auto pass may not link what review already owns", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    jest.clearAllMocks();
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

  describe("THE DEFECT — pass C over pass A's rows", () => {
    it("an email queued for review is NOT linked by a later flag=false pass", async () => {
      addAmbiguousEmail(db, "e-queued");

      // Pass A: the deal surface queues the ambiguous email.
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(queuedEmailIds(db)).toEqual(["e-queued"]);
      expect(linkedEmailIds(db)).toEqual([]);

      // Pass C: the same classifier, flag omitted — the Sync button's shape.
      const result = await autoPassWithoutFlag();

      // By exact ID, never by count.
      expect(linkedEmailIds(db)).toEqual([]);
      expect(queuedEmailIds(db)).toEqual(["e-queued"]);
      expect(result.emailsLinked).toBe(0);
      // And the caller is TOLD, so a refusal is never silent.
      expect(result.blockedPendingReview).toBe(1);
      // One item on the review screen, still awaiting a human.
      expect(getReviewState(TXN).items.map((i) => i.email_id)).toEqual(["e-queued"]);
      expect(getReviewState(TXN).items.map((i) => i.origin)).toEqual(["pending"]);
    });

    it("the global message-sync sweep cannot overwrite a queued email either", async () => {
      // `autoLinkNewMessagesForUser` runs after ANY message import for every
      // live contact-transaction pair and is never given the queue flag — the
      // founder's scope decision, pinned by reviewQueueTriggers-2791. Only the
      // guard reaches it.
      addAmbiguousEmail(db, "e-queued");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      expect(queuedEmailIds(db)).toEqual(["e-queued"]);

      await autoLinkNewMessagesForUser(USER);

      expect(linkedEmailIds(db)).toEqual([]);
      expect(queuedEmailIds(db)).toEqual(["e-queued"]);
    });
  });

  describe("THE GUARD DOES NOT OVERREACH", () => {
    it("an email with NO pending row still links normally on a flag=false pass", async () => {
      // The negative that makes the positive mean something: the guard keys on
      // the pending row, not on ambiguity. Without this, "nothing links" would
      // satisfy the suite.
      addAmbiguousEmail(db, "e-never-queued");

      const result = await autoPassWithoutFlag();

      expect(linkedEmailIds(db)).toEqual(["e-never-queued"]);
      expect(queuedEmailIds(db)).toEqual([]);
      expect(result.emailsLinked).toBe(1);
      expect(result.blockedPendingReview ?? 0).toBe(0);
      const reasons = db
        .prepare("SELECT match_reason FROM communications WHERE transaction_id = ?")
        .all(TXN) as Array<{ match_reason: string }>;
      expect(reasons.map((r) => r.match_reason)).toEqual(["address_missing"]);
    });

    it("a confident email still links while its queued neighbour is refused, in ONE pass", async () => {
      addAmbiguousEmail(db, "e-queued");
      addConfidentEmail(db, "e-names-address");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      // The confident one linked on the open sweep; the ambiguous one queued.
      expect(linkedEmailIds(db)).toEqual(["e-names-address"]);
      expect(queuedEmailIds(db)).toEqual(["e-queued"]);

      const result = await autoPassWithoutFlag();

      // Unchanged: the link stands, the queued row is still queued.
      expect(linkedEmailIds(db)).toEqual(["e-names-address"]);
      expect(queuedEmailIds(db)).toEqual(["e-queued"]);
      expect(result.emailsLinked).toBe(0);
      expect(result.alreadyLinked).toBe(0);
      expect(result.blockedPendingReview).toBe(1);
    });

    it("APPROVE still links the pending email — the guard is scoped to auto", async () => {
      // The reason the guard tests `linkSource`. approveReviewItems links with
      // "manual" and deletes the pending row AFTERWARDS, so an unscoped guard
      // turns approval into a silent no-op.
      addAmbiguousEmail(db, "e-queued");
      await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
      const [item] = getReviewState(TXN).items;
      expect(item.email_id).toBe("e-queued");

      const { approved } = await approveReviewItems([item.id]);

      expect(approved).toBe(1);
      expect(linkedEmailIds(db)).toEqual(["e-queued"]);
      expect(queuedEmailIds(db)).toEqual([]);
      const rows = db
        .prepare("SELECT match_reason FROM communications WHERE transaction_id = ?")
        .all(TXN) as Array<{ match_reason: string }>;
      expect(rows.map((r) => r.match_reason)).toEqual(["user_confirmed"]);
      expect(getReviewState(TXN).count).toBe(0);
    });
  });

  describe("THE LOGGING GAP that made pass A look like a no-op", () => {
    it("the completion log reports queuedForReview", async () => {
      addAmbiguousEmail(db, "e-queued");

      await autoLinkCommunicationsForContact({
        contactId: CONTACT,
        transactionId: TXN,
        queueAmbiguousInsteadOfLinking: true,
      });

      const calls = (logService.info as jest.Mock).mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].startsWith("Auto-link complete for contact"),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toMatchObject({ queuedForReview: 1, emailsLinked: 0 });
    });

    it("a queue-only pass does not fire the BACKLOG-1340 zero-results alarm", async () => {
      // The same blind spot in the other diagnostic: queueing nine emails is
      // not "0 results", and reporting it as one sends the next investigation
      // down the wrong path.
      addAmbiguousEmail(db, "e-queued");

      await autoLinkCommunicationsForContact({
        contactId: CONTACT,
        transactionId: TXN,
        queueAmbiguousInsteadOfLinking: true,
      });

      expect(queuedEmailIds(db)).toEqual(["e-queued"]);
      expect((Sentry.captureMessage as jest.Mock).mock.calls).toEqual([]);
    });
  });
});

// ============================================================
// TRIGGER-SITE ENUMERATION
// ============================================================

const ROOT = path.join(__dirname, "../..");
const read = (r: string) => fs.readFileSync(path.join(ROOT, "..", r), "utf8");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", "dist-electron", "__tests__"].includes(e.name)) continue;
        walk(full);
      } else if (e.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

/** The balanced `{...}` argument of each `<needle>({` call in a source file. */
function callArguments(src: string, needle: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\.?${needle}\\s*\\(\\s*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the opening brace
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

describe("BACKLOG-2880 — every deal-surface trigger states its flag at the call site", () => {
  it("the extractor can tell a passing argument from a missing one (the control on the control)", () => {
    const src = `a.f({ x: 1, flag: true });\nb.f({ y: 2 });`;
    expect(callArguments(src, "f")).toHaveLength(2);
    expect(callArguments(src, "f")[0]).toContain("flag: true");
    expect(callArguments(src, "f")[1]).not.toContain("flag");
  });

  it("EVERY syncTransactionEmails call site passes queueForReviewInsteadOfLinking explicitly", () => {
    // Enumerated by call site, not by whole-file grep: reviewQueueTriggers-2791
    // was rebuilt precisely because a 1700-line file containing the string
    // anywhere passed while a branch inside it leaked past the flag.
    //
    // A caller that omits the parameter inherits `false` and silently links —
    // which is what emailSyncHandlers did, and is this whole item.
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(f, "utf8");
      if (f.endsWith("emailSyncService.ts")) continue; // the definition, not a call
      for (const arg of callArguments(src, "syncTransactionEmails")) {
        if (!arg.includes("queueForReviewInsteadOfLinking")) {
          offenders.push(path.relative(path.join(ROOT, ".."), f).split(path.sep).join("/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the three shipped triggers each queue the ambiguous half", () => {
    // 1. The "Sync Emails" button — the site this item is about.
    const handler = read("electron/handlers/emailSyncHandlers.ts");
    const syncCalls = callArguments(handler, "syncTransactionEmails");
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]).toContain("queueForReviewInsteadOfLinking: true");

    // 2. Contact save.
    const crud = read("electron/handlers/transactionCrudHandlers.ts");
    expect(crud).toContain("queueAmbiguousInsteadOfLinking: true");
    expect(crud).toContain("queueForReviewInsteadOfLinking: true");

    // 3. Transaction open.
    const trigger = read("electron/services/transactionSyncTrigger.ts");
    expect(trigger).toContain("queueAmbiguousInsteadOfLinking: true");
    expect(trigger).toContain("queueForReviewInsteadOfLinking: true");
  });
});
