/**
 * @jest-environment node
 *
 * BACKLOG-2791 — the SERVICE half of the StrictMode question.
 *
 * Adopted from the SR's control for PR #2347. Its finding is CORRECT and is now
 * pinned as expected behaviour: a second back-to-back "open" sweep reports
 * added=0, because the first advanced the watermark and nothing is new.
 *
 * The defect was in the RENDERER, which took the LATEST value and so reset the
 * announcement to 0 before paint. That fix and its reds live in
 * useReviewQueue.strictMode-2791.
 *
 * Q1: does a StrictMode double-invoke of the on-open effect suppress the P2 popup?
 * Q2: what does the FIRST run (watermark NULL) scan?
 */
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
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

const USER = "u-x", TXN = "t-x", CONTACT = "c-x";
const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");
const V64_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
    ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
    ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;`;

function seed(db: DatabaseType): void {
  db.exec(SCHEMA); db.exec(V64_INDEXES);
  // MIGRATION-ONLY COLUMNS (v56 tombstones). They are declared on NEITHER table
  // in schema.sql, so a schema.sql-only fixture is a state the app never has:
  // autoLinkService's candidate-transaction count reads `tc.removed_at` and
  // threw "no such column", which its own catch swallowed into "found nothing".
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'o1')").run(USER, "me@a.com");
  db.prepare("INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?,?,?,?,?)")
    .run(TXN, USER, "1 St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?,?,?)").run(CONTACT, USER, "Paul");
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?,?,?)").run("ce1", CONTACT, "paul@example.com");
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?,?,?)").run("tc1", TXN, CONTACT);
}
function addEmail(db: DatabaseType, id: string): void {
  db.prepare(`INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
     VALUES (?,?,?, 'paul@example.com','hi','2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`).run(id, USER, "S" + id);
  db.prepare(`INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'paul@example.com')`).run(id, "h" + id);
}

describe("reviewStateService — a second open sweep reports nothing new", () => {
  let harness: MigrationHarness; let db: DatabaseType;
  beforeEach(() => { harness = createMigrationHarness({ seedV29Schema: false }); db = harness.db; seed(db); });
  afterEach(async () => { try { await harness.cleanup(); } catch { /* noop */ } });

  it("two back-to-back open syncs: the first announces, the second correctly reports 0", async () => {
    addEmail(db, "e1"); addEmail(db, "e2");
    const first = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
    const second = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
    expect(first.added).toBe(2);
    // Correct: the watermark advanced, so there is genuinely nothing new. The
    // renderer must not treat this as "the popup should disappear" — see
    // useReviewQueue.strictMode-2791.
    expect(second.added).toBe(0);

    // Nothing was lost or duplicated by the second sweep.
    expect(getReviewState(TXN).count).toBe(2);
  });
});
