/**
 * @jest-environment node
 *
 * BACKLOG-2791 — the rejection side door, TEXT half.
 *
 * Adopted verbatim from the SR's control for PR #2347 (fixture, walk-through and
 * step comments unchanged); only the closing assertions are flipped, because the
 * SR's version asserted the DEFECT and this one asserts the fix.
 *
 * One further change, forced rather than stylistic: the SR's fixture used a
 * 555-12xx number, which is OUTSIDE the reserved fictional block. This repo is
 * PUBLIC and the pre-push PII guard blocks it — correctly, since a pushed
 * fixture cannot be un-published. Replaced with 555-0142 (555-0100..555-0199 is
 * reserved for fiction). The specific digits are arbitrary to the test.
 *
 * Note the original number is deliberately NOT spelled out here: the guard scans
 * comments too, and quoting the offending value would re-publish it.
 *
 * The PR closes a "rejection side door" for EMAILS by storing match_reason
 * 'address_missing' on the ignored row, so a RESTORE returns the item to the
 * review queue instead of silently linking it.
 *
 * Q: does the same protection exist on the TEXT half?
 * The text restore path is transactions:restore-removed-message →
 * removeIgnoredCommunication + transactionService.linkMessages →
 * createCommunicationReference, whose INSERT has no match_reason column.
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
import {
  getReviewState,
  rejectReviewItems,
  restoreRejectedToQueue,
} from "../reviewStateService";

const USER = "u-t", TXN = "t-t", CONTACT = "c-t", THREAD = "th-1", PHONE = "+15550142";
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
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_reason TEXT;");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google','o1')").run(USER, "me@a.com");
  db.prepare("INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?,?,?,?,?)")
    .run(TXN, USER, "1 St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?,?,?)").run(CONTACT, USER, "Paul");
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?,?,?)").run("cp1", CONTACT, PHONE);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?,?,?)").run("tc1", TXN, CONTACT);
  db.prepare(`INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat, thread_id, sent_at, created_at)
     VALUES ('m1', ?, 'sms', 'inbound', 'hey', ?, ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`)
    .run(USER, PHONE, THREAD);
}

describe("SR CONTROL — text rejection side door", () => {
  let harness: MigrationHarness; let db: DatabaseType;
  beforeEach(() => { harness = createMigrationHarness({ seedV29Schema: false }); db = harness.db; seed(db); });
  afterEach(async () => { try { await harness.cleanup(); } catch { /* noop */ } });

  it("a rejected pending TEXT, restored the way the UI restores it, returns to the QUEUE and is never silently linked", async () => {
    // 1. A PENDING text thread.
    //
    // Constructed directly rather than through discovery: after the founder's
    // 2026-08-22 ruling texts ALWAYS auto-link (TASK-2087 stands), so a sweep no
    // longer produces one. The side door still has to stay shut for any pending
    // text that does exist — rows queued by an earlier build, and anything a
    // future change queues — so the protection is tested on the row itself
    // instead of on a discovery path that can no longer create it.
    db.prepare(
      `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id, thread_id)
       VALUES ('p-text', ?, ?, NULL, ?)`,
    ).run(USER, TXN, THREAD);

    const item = getReviewState(TXN).items[0];
    expect(item.kind).toBe("text");

    // 2. The user REJECTS it. Never approved, never linked.
    await rejectReviewItems([item.id]);
    expect(getReviewState(TXN).count).toBe(0);
    const ign = db.prepare("SELECT id, thread_id, match_reason FROM ignored_communications WHERE transaction_id=?")
      .get(TXN) as { id: string; thread_id: string; match_reason: string };
    expect(ign.match_reason).toBe("address_missing"); // the PR's fix, on the ignored row

    // 3. Is it visible in the Texts tab's "Removed" section? That section is
    //    transactions:get-removed-messages, which joins ic.thread_id = m.thread_id.
    const removed = db.prepare(`
      SELECT ic.id AS ignored_id, m.id AS message_id FROM ignored_communications ic
      LEFT JOIN messages m ON ((ic.thread_id IS NOT NULL AND ic.thread_id != '' AND m.thread_id = ic.thread_id)
        OR (ic.original_communication_id IS NOT NULL AND m.id = ic.original_communication_id))
      WHERE ic.transaction_id = ? AND m.id IS NOT NULL`).all(TXN);
    expect(removed).toHaveLength(1); // yes — one click from here restores it

    // 4. RESTORE, exactly as transactions:restore-removed-message now does: the
    //    handler asks reviewStateService FIRST, and a review rejection is routed
    //    back to the queue instead of falling through to
    //    removeIgnoredCommunication + linkMessages (whose text INSERT has no
    //    match_reason column — the original hole).
    const routed = await restoreRejectedToQueue(ign.id);
    expect(routed).toBe(true);

    // 5. The verdict, inverted from the SR's control because the door is closed.
    const link = db.prepare("SELECT match_reason FROM communications WHERE transaction_id=?")
      .get(TXN) as { match_reason: string | null } | undefined;
    expect(link).toBeUndefined(); // NOT linked: not in the audit, not in exports

    // Back on the queue, awaiting an approval it never received.
    const after = getReviewState(TXN);
    expect(after.count).toBe(1);
    expect(after.items[0].kind).toBe("text");
    expect(after.items[0].thread_id).toBe(THREAD);

    // And the suppression row is gone, so it is not ALSO still in Removed.
    const stillIgnored = db
      .prepare("SELECT COUNT(*) AS n FROM ignored_communications WHERE transaction_id=?")
      .get(TXN) as { n: number };
    expect(stillIgnored.n).toBe(0);
  });

  it("an ORDINARY removal still restores as a link — the routing keys on the rejection reason, not on match_reason", () => {
    // A legacy BACKLOG-2319 removal also carries match_reason='address_missing'.
    // If the new routing keyed on that alone it would hijack every ordinary
    // restore in the app and quietly stop re-linking them.
    db.prepare(
      `INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id, reason, match_reason)
       VALUES ('ig-ordinary', ?, ?, 'th-other', 'user_removed', 'address_missing')`,
    ).run(USER, TXN);

    return expect(restoreRejectedToQueue("ig-ordinary")).resolves.toBe(false);
  });
});
