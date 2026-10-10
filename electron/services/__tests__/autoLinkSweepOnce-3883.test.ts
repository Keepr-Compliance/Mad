/**
 * @jest-environment node
 *
 * BACKLOG-3883 — creating a deal swept every contact's auto-link three times on the
 * founder's PC (6 contacts, 18 runs where 6 were needed, all on the main process): the
 * creation pass (transactionService.createAuditedTransaction), then the details screen's
 * on-open review sync (reviewStateService.syncReviewQueueForTransaction) and the create
 * email trigger's covered path (transactionSyncTrigger.ensureTransactionEmailsSynced),
 * the last two overlapping. Opening an existing deal swept every contact again too.
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
// The covered path: one connected mailbox whose cached bounds cover any deal window, so
// planFetchWindows returns no window and the trigger runs its local auto-link sweep.
jest.mock("../db/emailSyncStateService", () => ({
  resolveMailboxAccountId: jest.fn(() => "acct-3883"),
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
import * as autoLinkModule from "../autoLinkService";
import transactionService from "../transactionService";
import * as reviewStateService from "../reviewStateService";
import { ensureTransactionEmailsSynced, __resetSyncThrottleForTests } from "../transactionSyncTrigger";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import emailSyncService from "../emailSyncService";

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
let onSweep: ((contactId: string) => void | "throw" | "aborted") | null = null;

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

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

maybe("BACKLOG-3883 — one full auto-link sweep per deal per input state", () => {
  beforeEach(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    seed();
    setDb(db);
    swept = [];
    onSweep = null;
    __resetFullSweepGuardForTests();
    __resetSyncThrottleForTests();
    const real = jest.requireActual<typeof autoLinkModule>("../autoLinkService").autoLinkCommunicationsForContact;
    jest.spyOn(autoLinkModule, "autoLinkCommunicationsForContact").mockImplementation(async (opts) => {
      swept.push(opts.contactId);
      const act = onSweep?.(opts.contactId);
      if (act === "throw") throw new Error("probe failure");
      const r = await real(opts);
      return act === "aborted" ? { ...r, aborted: true } : r;
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    db.close();
  });

  it("C1: creation, then the details screen's on-open sync: each contact swept exactly once", async () => {
    const txn = await createDeal();
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C6: the skipped on-open sync still reports what creation queued (the needs-review prompt)", async () => {
    const txn = await createDeal();
    const queued = db.prepare("SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?").get(txn) as { n: number };
    expect(queued.n).toBe(CONTACTS.length * 2);
    const res = await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(res.added).toBe(CONTACTS.length * 2);
    expect(res.outstanding).toBeGreaterThanOrEqual(CONTACTS.length * 2);
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C2: two on-open syncs fired while creation is still sweeping: each contact swept exactly once", async () => {
    const creating = createDeal();
    const txn = (db.prepare("SELECT id FROM transactions WHERE user_id = ?").get(USER) as { id: string }).id;
    const a = reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    const b = reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    await Promise.all([creating, a, b]);
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C2b: two concurrent on-open syncs of an existing deal (no prior sweep): one sweep", async () => {
    const txn = await createDeal();
    __resetFullSweepGuardForTests(); // as after an app restart
    swept = [];
    await Promise.all([
      reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" }),
      reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" }),
    ]);
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C3: the create email trigger's covered path after creation: no further sweep", async () => {
    const txn = await createDeal();
    const res = await ensureTransactionEmailsSynced({ transactionId: txn, userId: USER, reason: "create" });
    expect(res).toMatchObject({ ran: true, skipped: "covered" });
    expect(emailSyncService.syncTransactionEmails).not.toHaveBeenCalled();
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C3b: a plain re-open with nothing changed: no sweep from either open path", async () => {
    const txn = await createDeal();
    swept = [];
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    await ensureTransactionEmailsSynced({ transactionId: txn, userId: USER, reason: "open" });
    expect(swept).toEqual([]);
  });

  it("C4: a phone added to a party after creation: the next on-open sync sweeps every contact again", async () => {
    const txn = await createDeal();
    db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('p-new', 'c-ben', '+12065550199', '12065550199')").run();
    swept = [];
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C4b: a new text from a party after creation: the next on-open sync sweeps and links it", async () => {
    const txn = await createDeal();
    db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
       VALUES ('m-late', ?, 'g-late', 'imessage', 'inbound', '{}', '12065550101,19995550100', 'chat-late', '2025-03-03T00:00:00.000Z', 'text', 'late')`,
    ).run(USER);
    swept = [];
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
    const linked = db.prepare("SELECT 1 FROM communications WHERE transaction_id = ? AND thread_id = 'chat-late'").get(txn);
    expect(linked).toBeTruthy();
  });

  it("C5: a text that arrives WHILE creation sweeps: the next on-open sync sweeps again", async () => {
    let inserted = false;
    onSweep = (contactId) => {
      if (inserted || contactId !== CONTACTS[2]) return;
      inserted = true;
      db.prepare(
        `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
         VALUES ('m-mid', ?, 'g-mid', 'imessage', 'inbound', '{}', '12065550100,19995550100', 'chat-mid', '2025-03-03T00:00:00.000Z', 'text', 'mid')`,
      ).run(USER);
    };
    const txn = await createDeal();
    expect(inserted).toBe(true);
    swept = [];
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it.each(["throw", "aborted"] as const)("C8 (%s): a creation sweep in which one contact failed is not remembered; the on-open sync sweeps again", async (mode) => {
    onSweep = (contactId) => (contactId === "c-ben" ? mode : undefined);
    const txn = await createDeal();
    onSweep = null;
    swept = [];
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    expect(sorted(swept)).toEqual(sorted(CONTACTS));
  });

  it("C7: a contact-scoped sync (contacts edited) always runs", async () => {
    const txn = await createDeal();
    swept = [];
    await reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "contact-change", contactIds: ["c-ana"] });
    expect(swept).toEqual(["c-ana"]);
  });
});
