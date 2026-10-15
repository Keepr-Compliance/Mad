/**
 * @jest-environment node
 *
 * BACKLOG-3925 — the address-only pass in the FETCH branch's post-fetch sweep
 * (emailSyncService.syncTransactionEmails, the Sync Emails path). Only the provider
 * fetch is replaced: it stores one email from a stranger naming the deal's address.
 * The cache's newest bound is in the past, so the trigger takes the fetch branch.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 * Reserved .test addresses, invented ids.
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../db/emailSyncStateService", () => ({
  resolveMailboxAccountId: jest.fn((_u: string, provider: string) => (provider === "google" ? "acct-3925" : null)),
  getSyncState: jest.fn(() => ({ newest_cached_at: "2025-03-01T00:00:00.000Z", oldest_cached_at: "2000-01-01T00:00:00.000Z" })),
  updateCachedBounds: jest.fn(),
  recordSyncSuccess: jest.fn(),
  recordSyncFailure: jest.fn(),
}));
jest.mock("../failureLogService", () => ({ __esModule: true, default: { logEvent: jest.fn() } }));

import { setDb } from "../db/core/dbConnection";
import transactionService from "../transactionService";
import { ensureTransactionEmailsSynced, __resetSyncThrottleForTests } from "../transactionSyncTrigger";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import emailSyncService from "../emailSyncService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")) as new (
  f: string,
) => DatabaseType;

const USER = "user-3925-fetch";
const CONTACT = "c-lender";

let db: DatabaseType;
let fetchCalls = 0;

function seed(): void {
  db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
  db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, 'Lender', 'manual')").run(CONTACT, USER);
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES ('ce-1', ?, 'lender@example.test')").run(CONTACT);
}

async function createDeal(): Promise<string> {
  const created = await transactionService.createAuditedTransaction(USER, {
    property_address: "12 Probe Lane, Testville, WA 98000",
    transaction_type: "purchase",
    started_at: "2025-01-01T00:00:00.000Z",
    contact_assignments: [{ contact_id: CONTACT, role: "buyer", role_category: "client", is_primary: true }],
  } as unknown as Parameters<typeof transactionService.createAuditedTransaction>[1]);
  return (created as { id: string }).id;
}

function addressPending(txn: string): string[] {
  return (
    db
      .prepare(
        `SELECT p.email_id AS k FROM pending_review_communications p
           JOIN pending_review_match_reasons r ON r.transaction_id = p.transaction_id AND r.email_id = p.email_id
          WHERE p.transaction_id = ? AND r.reason = 'address' ORDER BY k`,
      )
      .all(txn) as Array<{ k: string }>
  ).map((r) => r.k);
}

describe("BACKLOG-3925 — address pass in the post-fetch sweep", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    seed();
    setDb(db);
    fetchCalls = 0;
    __resetFullSweepGuardForTests();
    __resetSyncThrottleForTests();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(emailSyncService as any, "fetchGmailEmails").mockImplementation(async () => {
      fetchCalls++;
      const id = `em-fetched-${fetchCalls}`;
      db.prepare(
        "INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, 'Fence at 12 Probe Lane', 'Two feet over.', '2025-03-05T00:00:00.000Z')",
      ).run(id, USER);
      db.prepare(
        "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, 'neighbour@example.test')",
      ).run(id, `h-${id}`);
      return { fetched: 1, stored: 1, duplicates: 0, networkError: false };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(emailSyncService as any, "fetchOutlookEmails").mockResolvedValue({ fetched: 0, stored: 0, duplicates: 0, networkError: false });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    db.close();
  });

  it("W3: a fetched address-only email is queued by the post-fetch sweep", async () => {
    const txn = await createDeal();
    expect(addressPending(txn)).toEqual([]);

    const res = await ensureTransactionEmailsSynced({ transactionId: txn, userId: USER, reason: "open" });

    expect(res).toMatchObject({ ran: true });
    expect(res.skipped).toBeUndefined();
    expect(fetchCalls).toBeGreaterThan(0);
    expect(addressPending(txn)).toEqual(
      Array.from({ length: fetchCalls }, (_, i) => `em-fetched-${i + 1}`).sort(),
    );
  });
});
