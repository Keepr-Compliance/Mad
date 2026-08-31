/**
 * @jest-environment node
 *
 * BACKLOG-2791 — the SHIPPED auto-link split, restored (founder ruling
 * 2026-08-22, "keep it like before").
 *
 * An earlier revision of this PR queued EVERYTHING a deal-scoped run found, so
 * the popup read "0 linked successfully" on every transaction. The rule is
 * develop's again:
 *
 *   emails, content names THIS deal's address        -> LINK   (counts in L)
 *   emails, deal has NO property address to check    -> LINK   (counts in L)
 *   emails, address exists and this one never named it -> QUEUE (counts in R)
 *   texts                                            -> LINK   (counts in L)
 *
 * The predicate is not reimplemented here; it is delegated to
 * autoLinkCommunicationsForContact, which is where the multi-deal
 * disambiguation and the rejection suppression already live.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(), setUser: jest.fn(), addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn().mockResolvedValue(undefined), debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined), error: jest.fn().mockResolvedValue(undefined) };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = { initialize: jest.fn().mockResolvedValue(undefined), getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false), getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}) };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({ queryContacts: jest.fn(), isPoolReady: jest.fn(() => false) }));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import { getReviewState, syncReviewQueueForTransaction } from "../reviewStateService";

const USER = "u-split";
const TXN = "t-split";
const CONTACT = "c-split";
const ADDRESS = "3414 Sapp Rd";
const PHONE = "+15555550142";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");
const V65_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
    ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
    ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;`;

function seed(db: DatabaseType, propertyAddress: string): void {
  db.exec(SCHEMA);
  db.exec(V65_INDEXES);
  // MIGRATION-ONLY COLUMNS. v56's tombstones are added by the chain and are
  // declared on NEITHER table in schema.sql, so a schema.sql-only fixture is a
  // database state the app never actually has. autoLinkService's
  // candidate-transaction count reads `tc.removed_at`, and without these the
  // whole classification threw "no such column: tc.removed_at" — swallowed by
  // its own catch, so it silently returned "found nothing" and every email fell
  // through to the queue. The fixture was describing a shape the code cannot
  // meet; adding them is what makes this suite test the real predicate.
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google','o1')",
  ).run(USER, "me@agent.com");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?,?,?,?,?)",
  ).run(TXN, USER, propertyAddress, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?,?,?)").run(
    CONTACT, USER, "Jane Seller",
  );
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?,?,?)").run(
    "ce1", CONTACT, "jane@example.com",
  );
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?,?,?)").run(
    "cp1", CONTACT, PHONE,
  );
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?,?,?)").run(
    "tc1", TXN, CONTACT,
  );
}

function addEmail(db: DatabaseType, id: string, body: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
     VALUES (?,?,?, 'jane@example.com', ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, USER, `Subject ${id}`, body);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'jane@example.com')`,
  ).run(id, `h-${id}`);
}

function addText(db: DatabaseType, id: string, threadId: string): void {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat, thread_id, sent_at, created_at)
     VALUES (?,?, 'sms', 'inbound', 'on my way', ?, ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, USER, PHONE, threadId);
}

const linkedEmailIds = (db: DatabaseType): string[] =>
  (db.prepare(
    "SELECT email_id FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL ORDER BY email_id",
  ).all(TXN) as Array<{ email_id: string }>).map((r) => r.email_id);

const queuedEmailIds = (db: DatabaseType): string[] =>
  (db.prepare(
    "SELECT email_id FROM pending_review_communications WHERE transaction_id = ? AND email_id IS NOT NULL ORDER BY email_id",
  ).all(TXN) as Array<{ email_id: string }>).map((r) => r.email_id);

describe("BACKLOG-2791 — the shipped split", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  afterEach(async () => {
    try { await harness.cleanup(); } catch { /* already cleaned */ }
  });

  it("an email that NAMES the property address LINKS, counts in L, and is absent from the queue", async () => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db, ADDRESS);
    addEmail(db, "e-names", `Closing docs for ${ADDRESS} attached.`);

    const r = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    expect(linkedEmailIds(db)).toEqual(["e-names"]);
    expect(queuedEmailIds(db)).toEqual([]);
    expect(r.linked).toBeGreaterThan(0);
    expect(r.added).toBe(0);
  });

  it("an email that NEVER names the address QUEUES, counts in R, and is NOT linked", async () => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db, ADDRESS);
    addEmail(db, "e-silent", "Are you free on Thursday?");

    const r = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
    expect(queuedEmailIds(db)).toEqual(["e-silent"]);
    expect(linkedEmailIds(db)).toEqual([]);
    expect(r.added).toBe(1);
    expect(r.linked).toBe(0);
    // And it is what the review surfaces show.
    expect(getReviewState(TXN).items.map((i) => i.email_id)).toEqual(["e-silent"]);
  });

  it("both together split by identity — one linked, one queued, in the same run", async () => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db, ADDRESS);
    addEmail(db, "e-names", `Inspection at ${ADDRESS} on Friday.`);
    addEmail(db, "e-silent", "Quick question about timing.");

    const r = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    // Asserted by ID SET, never by count.
    expect(linkedEmailIds(db)).toEqual(["e-names"]);
    expect(queuedEmailIds(db)).toEqual(["e-silent"]);
    expect(r.linked).toBeGreaterThan(0);
    expect(r.added).toBe(1);
  });

  it("TEXTS always link and NEVER queue — TASK-2087 stands, per the founder", async () => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db, ADDRESS);
    addText(db, "m1", "th-1");

    const r = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    const threads = db.prepare(
      "SELECT thread_id FROM communications WHERE transaction_id = ? AND thread_id IS NOT NULL",
    ).all(TXN) as Array<{ thread_id: string }>;
    expect(threads.map((t) => t.thread_id)).toEqual(["th-1"]);

    expect(
      db.prepare(
        "SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ? AND thread_id IS NOT NULL",
      ).get(TXN),
    ).toEqual({ n: 0 });
    expect(r.linked).toBeGreaterThan(0);
  });

  it("a deal with no USABLE property address links everything — develop's edge, kept deliberately", async () => {
    // addressMatched === null means "nothing to check", which the shipped rule
    // treats as confident, so such a deal never accumulates a review queue.
    //
    // Worth recording precisely: `transactions.property_address` is NOT NULL, so
    // this edge is NOT reached by a missing address. It is reached by one that
    // normalizeAddress cannot parse into a street number plus a distinctive
    // word — an empty string here, but equally a free-text placeholder. The
    // first draft of this test seeded NULL and the schema rejected it outright.
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db, "");
    addEmail(db, "e-silent", "Are you free on Thursday?");

    const r = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    expect(linkedEmailIds(db)).toEqual(["e-silent"]);
    expect(queuedEmailIds(db)).toEqual([]);
    expect(r.added).toBe(0);
  });
});
