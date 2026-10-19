/**
 * @jest-environment node
 *
 * BACKLOG-3925 — the address-only pass runs in EVERY full sweep of a deal, not only the
 * on-open review sync. The full sweeps share one runFullSweepOnce guard per deal
 * (autoLinkSweepGuard.ts), so if creation's sweep lacked the pass, the details screen's
 * on-open sync seconds later would be skipped as "unchanged" and the deal would get no
 * address matches until some input moved.
 *
 * This file: deal CREATION and the create/open trigger's COVERED path (mailbox cache
 * already covers the window). The fetch branch is in addressMatchSweepsFetch-3925.
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
  resolveMailboxAccountId: jest.fn(() => "acct-3925"),
  getSyncState: jest.fn(() => ({ newest_cached_at: "2099-01-01T00:00:00.000Z", oldest_cached_at: "2000-01-01T00:00:00.000Z" })),
  updateCachedBounds: jest.fn(),
  recordSyncSuccess: jest.fn(),
  recordSyncFailure: jest.fn(),
}));
jest.mock("../emailSyncService", () => ({
  __esModule: true,
  default: { syncTransactionEmails: jest.fn() },
  EMAIL_CACHE_FRESHNESS_MS: 5 * 60_000,
}));

import { setDb } from "../db/core/dbConnection";
import transactionService from "../transactionService";
import auditService, { type AuditLogEntry } from "../auditService";
import { syncReviewQueueForTransaction } from "../reviewStateService";
import { ensureTransactionEmailsSynced, __resetSyncThrottleForTests } from "../transactionSyncTrigger";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import emailSyncService from "../emailSyncService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")) as new (
  f: string,
) => DatabaseType;

const USER = "user-3925-sweeps";
const CONTACT = "c-lender";

let db: DatabaseType;

function insertStrangerEmail(id: string, subject: string, sentAt = "2025-03-02T00:00:00.000Z"): void {
  db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, ?, 'See you there.', ?)").run(id, USER, subject, sentAt);
  db.prepare(
    "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, 'neighbour@example.test')",
  ).run(id, `h-${id}`);
}

function seed(): void {
  db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
  db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, 'Lender', 'manual')").run(CONTACT, USER);
  db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES ('ce-1', ?, 'lender@example.test')").run(CONTACT);
  insertStrangerEmail("em-addr-1", "Open house at 12 Probe Lane");
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

describe("BACKLOG-3925 — address pass in creation and the covered trigger", () => {
  beforeEach(() => {
    // BACKLOG-3339: creating a deal writes its audit entry inside the create's
    // transaction. Not what this suite measures, and the audit service is not
    // initialized here, so the entry is stubbed.
    jest.spyOn(auditService, "recordInTransaction").mockReturnValue({} as AuditLogEntry);
    jest.spyOn(auditService, "recordFailure").mockImplementation(() => undefined);
    db = new Database(":memory:");
    seed();
    setDb(db);
    __resetFullSweepGuardForTests();
    __resetSyncThrottleForTests();
  });
  afterEach(() => {
    jest.clearAllMocks();
    db.close();
  });

  it("W1: creation's sweep queues the address match itself", async () => {
    const txn = await createDeal();
    expect(addressPending(txn)).toEqual(["em-addr-1"]);
  });

  it("W1b: and the on-open sync that follows (skipped as unchanged) leaves it there", async () => {
    const txn = await createDeal();
    await syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(addressPending(txn)).toEqual(["em-addr-1"]);
  });

  it("W2: the covered create/open trigger queues a NEW cached address match", async () => {
    const txn = await createDeal();
    insertStrangerEmail("em-addr-2", "12 Probe Lane — fence question", "2025-03-03T00:00:00.000Z");

    const res = await ensureTransactionEmailsSynced({ transactionId: txn, userId: USER, reason: "open" });

    expect(res).toMatchObject({ ran: true, skipped: "covered" });
    expect(emailSyncService.syncTransactionEmails).not.toHaveBeenCalled();
    expect(addressPending(txn)).toEqual(["em-addr-1", "em-addr-2"]);
  });
});
