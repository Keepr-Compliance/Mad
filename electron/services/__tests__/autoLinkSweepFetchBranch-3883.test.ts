/**
 * @jest-environment node
 *
 * BACKLOG-3883 — the FETCH branch of the create/open email trigger. An open-ended deal's
 * window ends now, so planFetchWindows adds a forward window and the trigger calls the
 * REAL emailSyncService.syncTransactionEmails, which sweeps every contact afterwards
 * (postFetch) or, for a deal whose parties have no email address, runs autoLinkOnly.
 * Only the provider fetch is replaced (it stores 0 or N emails); the cached bounds are in
 * the past, NOT 2099, so the trigger never takes the covered branch here.
 *
 * Asserted on the IDENTITY of the contacts swept (the exact multiset of contact ids
 * handed to autoLinkCommunicationsForContact), not a count. The callers are the real
 * ones; the database is the real schema.sql on the real driver.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 * (CI runs it under node, where `npm test` has switched the driver to the node ABI.)
 * Reserved 555-01xx numbers, .test addresses, invented ids.
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
// One connected mailbox whose cache ends in the past: for an open-ended deal (window end =
// now) planFetchWindows returns a forward window, so the trigger takes the fetch branch.
jest.mock("../db/emailSyncStateService", () => ({
  resolveMailboxAccountId: jest.fn((_u: string, provider: string) => (provider === "google" ? "acct-3883" : null)),
  getSyncState: jest.fn(() => ({ newest_cached_at: "2025-03-01T00:00:00.000Z", oldest_cached_at: "2000-01-01T00:00:00.000Z" })),
  updateCachedBounds: jest.fn(),
  recordSyncSuccess: jest.fn(),
  recordSyncFailure: jest.fn(),
}));
jest.mock("../failureLogService", () => ({ __esModule: true, default: { logEvent: jest.fn() } }));

import { setDb } from "../db/core/dbConnection";
import * as autoLinkModule from "../autoLinkService";
import transactionService from "../transactionService";
import { ensureTransactionEmailsSynced, __resetSyncThrottleForTests } from "../transactionSyncTrigger";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import emailSyncService from "../emailSyncService";
import { computeTransactionDateRange } from "../../utils/emailDateRange";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3883] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "38830000-0000-4000-8000-0000000000aa"; // pii-allow-uuid: invented, not from any live row
const CONTACTS = ["c-ana", "c-ben", "c-cyd"];

let db: DatabaseType;
let swept: string[] = [];

function seed(): void {
  db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
  const insMsg = db.prepare(
    `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
     VALUES (?, ?, ?, 'imessage', 'inbound', ?, ?, ?, ?, 'text', 'hello')`,
  );
  const insEmail = db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, ?, ?, ?)");
  const insEp = db.prepare(
    "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, ?)",
  );
  CONTACTS.forEach((id, i) => {
    const phone = `+1206555010${i}`;
    const address = `${id}@example.test`;
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, 'manual')").run(id, USER, id);
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES (?, ?, ?, ?)").run(`p-${id}`, id, phone, phone.replace(/\D/g, ""));
    db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)").run(`e-${id}`, id, address);
    for (let t = 0; t < 2; t++) {
      insMsg.run(`m-${id}-${t}`, USER, `g-${id}-${t}`, JSON.stringify({ from: phone }), `${phone.replace(/\D/g, "")},19995550100`, `chat-${id}-${t}`, "2025-03-01T00:00:00.000Z");
    }
    // Two emails per contact that never name the deal's address -> queued for review.
    for (let k = 0; k < 2; k++) {
      insEmail.run(`em-${id}-${k}`, USER, `Hello ${k}`, "No property named here.", "2025-03-02T00:00:00.000Z");
      insEp.run(`em-${id}-${k}`, `h-${id}-${k}`, address);
    }
  });
}

async function createDeal(): Promise<string> {
  const created = await transactionService.createAuditedTransaction(USER, {
    property_address: "12 Probe Lane, Testville, WA 98000",
    transaction_type: "purchase",
    started_at: "2025-01-01T00:00:00.000Z",
    contact_assignments: CONTACTS.map((contact_id, i) => ({
      contact_id,
      role: "buyer",
      role_category: "client",
      is_primary: i === 0,
    })),
  } as unknown as Parameters<typeof transactionService.createAuditedTransaction>[1]);
  return (created as { id: string }).id;
}


let storeCount = 0;
let fetchCalls = 0;

maybe("BACKLOG-3883 — the fetch branch of the create/open email trigger sweeps once per input state", () => {
  beforeEach(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    seed();
    setDb(db);
    swept = [];
    storeCount = 0;
    fetchCalls = 0;
    __resetFullSweepGuardForTests();
    __resetSyncThrottleForTests();
    const real = jest.requireActual<typeof autoLinkModule>("../autoLinkService").autoLinkCommunicationsForContact;
    jest.spyOn(autoLinkModule, "autoLinkCommunicationsForContact").mockImplementation(async (opts) => {
      swept.push(`${opts.caller}:${opts.contactId}`);
      return real(opts);
    });
    // The provider fetch: store `storeCount` emails (as fetchStoreAndDedup does, rows in
    // emails + email_participants), report them stored. No network.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(emailSyncService as any, "fetchGmailEmails").mockImplementation(async () => {
      fetchCalls++;
      for (let i = 0; i < storeCount; i++) {
        const id = `em-fetched-${fetchCalls}-${i}`;
        db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, 'Fetched', 'No property named here.', '2025-03-05T00:00:00.000Z')").run(id, USER);
        db.prepare("INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, 'c-ana@example.test')").run(id, `h-${id}`);
      }
      return { fetched: storeCount, stored: storeCount, duplicates: 0, networkError: false };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(emailSyncService as any, "fetchOutlookEmails").mockResolvedValue({ fetched: 0, stored: 0, duplicates: 0, networkError: false });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    db.close();
  });

  const swept4 = (caller: string) => CONTACTS.map((c) => `${caller}:${c}`).sort();
  const open = (txn: string) => ensureTransactionEmailsSynced({ transactionId: txn, userId: USER, reason: "open" });

  it("F0: the fixture takes the fetch branch for an open-ended deal (not the covered one)", async () => {
    const txn = await createDeal();
    const details = db.prepare("SELECT closed_at FROM transactions WHERE id = ?").get(txn) as { closed_at: string | null };
    expect(details.closed_at).toBeNull(); // open-ended: window end = now
    expect(computeTransactionDateRange({ started_at: "2025-01-01T00:00:00.000Z" } as never, new Date()).end.getFullYear()).toBeGreaterThanOrEqual(2026);
    const res = await open(txn);
    expect(res).toMatchObject({ ran: true });
    expect(res.skipped).toBeUndefined();
    expect(fetchCalls).toBeGreaterThan(0);
  });

  it("F1: the fetch stored 0 emails and nothing else changed: the postFetch sweep is skipped", async () => {
    const txn = await createDeal(); // creation swept every contact
    swept = [];
    await open(txn);
    expect(fetchCalls).toBeGreaterThan(0);
    expect(swept).toEqual([]);
  });

  it("F2: the fetch stored N emails: the postFetch sweep runs for every contact and queues them", async () => {
    const txn = await createDeal();
    swept = [];
    storeCount = 2;
    await open(txn);
    expect(fetchCalls).toBeGreaterThan(0);
    expect(swept.sort()).toEqual(swept4("postFetch"));
    const queued = db.prepare("SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?").get(txn) as { n: number };
    expect(queued.n).toBe(CONTACTS.length * 2 + 2);
  });

  it("F2b: a second open after the N-email fetch (stored 0 this time) is skipped again", async () => {
    const txn = await createDeal();
    storeCount = 2;
    await open(txn);
    __resetSyncThrottleForTests();
    storeCount = 0;
    swept = [];
    await open(txn);
    expect(swept).toEqual([]);
  });

  it("F3: a deal whose parties have no email address (autoLinkOnly): skipped when nothing changed", async () => {
    db.prepare("DELETE FROM contact_emails").run();
    const txn = await createDeal();
    swept = [];
    await open(txn);
    expect(fetchCalls).toBe(0); // no contact emails -> no provider fetch at all
    expect(swept).toEqual([]);
  });

  it("F3b: autoLinkOnly runs again for a new text from a party", async () => {
    db.prepare("DELETE FROM contact_emails").run();
    const txn = await createDeal();
    db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
       VALUES ('m-late', ?, 'g-late', 'imessage', 'inbound', '{}', '12065550101,19995550100', 'chat-late', '2025-03-03T00:00:00.000Z', 'text', 'late')`,
    ).run(USER);
    swept = [];
    await open(txn);
    expect(swept.sort()).toEqual(swept4("autoLinkOnly"));
    expect(db.prepare("SELECT 1 FROM communications WHERE transaction_id = ? AND thread_id = 'chat-late'").get(txn)).toBeTruthy();
  });

  it("F4: a phone added to a party after creation: the fetch branch sweeps again even though 0 emails were stored", async () => {
    const txn = await createDeal();
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('p-new', 'c-ben', '+12065550199', '12065550199')").run();
    swept = [];
    await open(txn);
    expect(swept.sort()).toEqual(swept4("postFetch"));
  });
});
