/**
 * @jest-environment node
 *
 * BACKLOG-2791 — L > 0 DEMONSTRATED on a staged corpus, not just unit-proven.
 *
 * The founder's real-data run reported 7 found / 0 linked / 7 require review and
 * he wanted to see the other half actually happen. His numbers are consistent
 * with genuine address-missing mail: his corpus simply had no email whose body
 * names the property address.
 *
 * This stages a corpus that DOES contain such mail and drives the real
 * discovery pipeline — real schema.sql, real driver, real
 * autoLinkCommunicationsForContact — then asserts the exact L/R/N the popup
 * receives. No mocked classifier anywhere.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: { getAllWindows: () => [] },
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

const USER = "u-corpus", TXN = "t-corpus", CONTACT = "c-corpus";
const PROPERTY = "3414 Sapp Rd SW";
const PHONE = "+15555550142";
const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

/** The staged corpus: what a real deal's mailbox looks like. */
const CORPUS: Array<{ id: string; subject: string; body: string; expect: "link" | "queue" }> = [
  { id: "c-1", subject: "Signed purchase agreement",
    body: `Attached is the signed agreement for ${PROPERTY}. Closing is set for the 14th.`,
    expect: "link" },
  { id: "c-2", subject: "Inspection scheduled",
    body: `The inspector will be at ${PROPERTY} on Thursday at 9am.`,
    expect: "link" },
  { id: "c-3", subject: "Quick question",
    body: "Are you free for a call tomorrow afternoon?",
    expect: "queue" },
  { id: "c-4", subject: "Re: paperwork",
    body: "Sending the rest over shortly, thanks for your patience.",
    expect: "queue" },
];

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_email
             ON pending_review_communications(transaction_id, email_id) WHERE email_id IS NOT NULL;`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_review_txn_thread
             ON pending_review_communications(transaction_id, thread_id) WHERE thread_id IS NOT NULL;`);
  // v56 tombstones live only in the migration chain, never in schema.sql.

  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,'google','o1')")
    .run(USER, "agent@example.com");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?,?,?,?,?)",
  ).run(TXN, USER, PROPERTY, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?,?,?)")
    .run(CONTACT, USER, "Jane Seller");
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?,?,?)")
    .run("ce1", CONTACT, "jane@example.com");
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?,?,?)")
    .run("cp1", CONTACT, PHONE);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?,?,?)")
    .run("tc1", TXN, CONTACT);

  for (const e of CORPUS) {
    db.prepare(
      `INSERT INTO emails (id, user_id, subject, sender, body_plain, sent_at, created_at)
       VALUES (?,?,?, 'jane@example.com', ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
    ).run(e.id, USER, e.subject, e.body);
    db.prepare(
      `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
       VALUES (?, 'from', 0, ?, 'jane@example.com')`,
    ).run(e.id, `h-${e.id}`);
  }

  // One text thread — always links, never queues (TASK-2087).
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat, thread_id, sent_at, created_at)
     VALUES ('m-1', ?, 'sms', 'inbound', 'running late', ?, 'th-corpus', '2026-06-02T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(USER, PHONE);
}

describe("staged corpus — the popup's numbers, end to end", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);
  });
  afterEach(async () => {
    try { await harness.cleanup(); } catch { /* already cleaned */ }
  });

  it("links the address-matching mail and the text, queues the rest — L > 0", async () => {
    const result = await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });

    // 2 address-matching emails + 1 text thread = 3 linked.
    expect(result.linked).toBe(3);
    // 2 emails that never named the address.
    expect(result.added).toBe(2);
    // The popup's N.
    expect(result.linked + result.added).toBe(5);

    // Asserted by IDENTITY, so a swap could not pass.
    const linked = (db.prepare(
      "SELECT email_id FROM communications WHERE transaction_id = ? AND email_id IS NOT NULL ORDER BY email_id",
    ).all(TXN) as Array<{ email_id: string }>).map((r) => r.email_id);
    expect(linked).toEqual(CORPUS.filter((c) => c.expect === "link").map((c) => c.id));

    const queued = (db.prepare(
      "SELECT email_id FROM pending_review_communications WHERE transaction_id = ? ORDER BY email_id",
    ).all(TXN) as Array<{ email_id: string }>).map((r) => r.email_id);
    expect(queued).toEqual(CORPUS.filter((c) => c.expect === "queue").map((c) => c.id));

    // The text linked and did not queue.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ? AND thread_id IS NOT NULL").get(TXN),
    ).toEqual({ n: 1 });

    // And the review surfaces show exactly the queued two.
    expect(getReviewState(TXN).count).toBe(2);
  });
});
