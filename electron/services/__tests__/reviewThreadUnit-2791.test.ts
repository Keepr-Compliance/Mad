/**
 * @jest-environment node
 *
 * BACKLOG-2791 — THE THREAD IS THE UNIT (Communication Lifecycle Contract, the
 * unit rule + rows T3/T4 "acts on: whole thread").
 *
 * This file pins the BACKEND half of that rule: the review queue must hand the
 * renderer enough to group its items into threads. It cannot, unless the
 * EMAIL's own `thread_id` is projected onto the item.
 *
 * WHY THE PROJECTION IS NEEDED AT ALL — the fact that blocked the first attempt:
 * `pending_review_communications.thread_id` is NULL for every EMAIL row. The
 * queue keys emails by `email_id` and threads by `thread_id`, one or the other,
 * so an email item's `thread_id` column is not "the email's thread" — it is
 * empty by design. Grouping therefore cannot be done in the renderer alone; the
 * email's thread has to be read from `emails.thread_id` and carried.
 *
 * WHY IT IS CARRIED ON `display` AND NOT ON `ReviewItem.thread_id`:
 * `rejectReviewItems` writes `item.thread_id` into the `ignored_communications`
 * suppression row, and RemovedMessagesSection selects removed TEXT threads by
 * that column (`row.ic_thread_id || row.thread_id`). Setting an email item's
 * `thread_id` would file rejected EMAILS under removed TEXTS. The routing field
 * stays NULL; the grouping key travels with the display payload, which is the
 * payload the renderer already uses to draw the card.
 *
 * CONTROLS RUN — each mutation applied to the source, suite re-run, the number
 * below is the MEASURED result (not the predicted one; controls 1 and 2 each
 * took down one more test than expected, which is why these are recorded):
 *  1. Delete `thread_id` from emailDisplay's SELECT list   -> RED, 5 of 5 tests.
 *     The column is simply absent from the row, so the projection yields
 *     `undefined` — which fails even the NULL-key assertion.
 *  2. Return `threadId: null` from emailDisplay instead of `row.thread_id`
 *                                                          -> RED, 4 of 5 tests.
 *     The survivor is "an email the provider never threaded projects a NULL
 *     key", which a constant null satisfies by accident. That is precisely why
 *     the other four assert a SPECIFIC provider id rather than "not null".
 *  3. Move the key onto the ITEM (`thread_id: r.thread_id ?? <email's thread>`),
 *     i.e. group the wrong way                             -> RED, 1 of 5 tests:
 *     "the routing thread_id stays NULL for an email item". Only one test can
 *     see this mutation, and without that test the removed-TEXTS regression
 *     would have shipped green.
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
  rejectReviewItems,
} from "../reviewStateService";

const USER = "u-2791t";
const TXN = "t-2791t";
const CONTACT = "c-2791t";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

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
  // v56 tombstone columns — migration-only, on neither table in schema.sql.
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

/**
 * An in-window, address-missing email from the contact — the shape that QUEUES.
 * `threadId` is written to `emails.thread_id`, exactly where the provider's
 * conversation id lands, so this fixture is the producer's own column and not a
 * stand-in for one.
 */
function addEmail(
  db: DatabaseType,
  id: string,
  subject: string,
  threadId: string | null,
): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, thread_id, created_at)
     VALUES (?, ?, ?, 'paul@example.com', 'hello', '2026-06-01T00:00:00.000Z', ?, CURRENT_TIMESTAMP)`,
  ).run(id, USER, subject, threadId);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'paul@example.com')`,
  ).run(id, `hash-${id}`);
}

describe("BACKLOG-2791 — the thread is the unit (backend projection)", () => {
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

  it("two queued emails in ONE provider thread carry that thread_id as their grouping key", async () => {
    addEmail(db, "e1", "Re: Offer", "thr-shared");
    addEmail(db, "e2", "Re: Offer", "thr-shared");

    await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    const items = getReviewState(TXN).items;
    expect(items).toHaveLength(2);
    // Identity, not count: BOTH of these specific emails, keyed to the same thread.
    expect(items.map((i) => i.email_id).sort()).toEqual(["e1", "e2"]);
    expect(items.map((i) => i.display.threadId)).toEqual(["thr-shared", "thr-shared"]);
  });

  it("a lone email carries its OWN thread_id — a one-email thread, not a null one", async () => {
    addEmail(db, "solo", "Standalone", "thr-solo");

    await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    const items = getReviewState(TXN).items;
    expect(items).toHaveLength(1);
    expect(items[0].display.threadId).toBe("thr-solo");
  });

  it("two emails in DIFFERENT threads carry different keys, so they never group", async () => {
    addEmail(db, "a1", "Offer", "thr-a");
    addEmail(db, "b1", "Inspection", "thr-b");

    await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    const keys = getReviewState(TXN)
      .items.map((i) => i.display.threadId)
      .sort();
    expect(keys).toEqual(["thr-a", "thr-b"]);
  });

  it("an email the provider never threaded projects a NULL key (the renderer falls back to item id)", async () => {
    addEmail(db, "untbreaded", "No thread", null);

    await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    const items = getReviewState(TXN).items;
    expect(items).toHaveLength(1);
    expect(items[0].display.threadId).toBeNull();
  });

  it("the routing thread_id stays NULL for an email item — a rejected EMAIL must not be filed as a removed TEXT", async () => {
    addEmail(db, "e1", "Re: Offer", "thr-shared");
    await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    const item = getReviewState(TXN).items[0];
    // The grouping key is present...
    expect(item.display.threadId).toBe("thr-shared");
    // ...and the ROUTING field, which reject writes into the suppression row, is not.
    expect(item.thread_id).toBeNull();

    await rejectReviewItems([item.id]);

    // The suppression row must carry the email, and NO thread — RemovedMessagesSection
    // selects removed TEXT threads by exactly this column.
    const ignored = db
      .prepare(
        "SELECT email_id, thread_id FROM ignored_communications WHERE transaction_id = ?",
      )
      .all(TXN) as Array<{ email_id: string | null; thread_id: string | null }>;
    expect(ignored).toHaveLength(1);
    expect(ignored[0].email_id).toBe("e1");
    expect(ignored[0].thread_id).toBeNull();
  });
});
