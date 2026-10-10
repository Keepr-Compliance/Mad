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
import { __resetFullSweepGuardForTests, __setInFlightWaitTimeoutForTests, runFullSweepOnce } from "../autoLinkSweepGuard";
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
  // B3 (SR review): one control per input class the token counts. Each op is the ONE write
  // that class makes, issued as plain SQL so only its own trigger can see it. The control
  // for the trigger itself is to stop it counting: that test must go red.
  describe("every counted input class makes the next on-open sync sweep again", () => {
    const USER2 = "38830000-0000-4000-8000-0000000000bb"; // pii-allow-uuid: invented, not from any live row
    const run = (sqlText: string, ...args: unknown[]): void => {
      const r = db.prepare(sqlText).run(...args);
      expect(r.changes).toBeGreaterThan(0); // the write really happened
    };
    function addSpares(): void {
      // Rows nothing sweeps, so a write to them can only be seen through the tracker. Each
      // "top" row is inserted last so the row written to is not the table's MAX(rowid).
      db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'other@example.test', 'google', 'o2')").run(USER2);
      db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t-spare', ?, '99 Spare Road, Testville, WA 98000')").run(USER2);
      db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('t-spare-bare', ?, '98 Spare Road, Testville, WA 98000')").run(USER2); // no children: its delete cascades nothing
      db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c-spare', ?, 'spare', 'manual')").run(USER2);
      db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES ('tc-spare', 't-spare', 'c-spare', 'buyer')").run();
      db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c-spare2', ?, 'spare2', 'manual')").run(USER2);
      db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('p-spare', 'c-spare', '+12065550188', '12065550188')").run();
      db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES ('e-spare', 'c-spare', 'c-spare@example.test')").run();
      const insMsg = db.prepare(
        `INSERT INTO messages (id, user_id, external_id, channel, direction, participants, participants_flat, thread_id, sent_at, message_type, body_text)
         VALUES (?, ?, ?, 'imessage', 'inbound', '{}', '19995550177', ?, '2025-03-01T00:00:00.000Z', 'text', 'spare')`,
      );
      insMsg.run("m-spare", USER, "g-spare", "chat-spare");
      insMsg.run("m-top", USER, "g-top", "chat-top");
      const insEmail = db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, 'spare', 'nothing', '2025-03-02T00:00:00.000Z')");
      const insEp = db.prepare("INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, 'spare@example.test')");
      insEmail.run("em-spare", USER); // no participant rows: deleting it fires only the emails trigger
      insEmail.run("em-spare2", USER);
      insEp.run("em-spare2", "h-spare2");
      insEmail.run("em-top", USER);
      insEp.run("em-top", "h-top");
    }
    const sync = (txn: string) => reviewStateService.syncReviewQueueForTransaction({ transactionId: txn, reason: "open" });
    const ownCommunication = "(SELECT id FROM communications WHERE transaction_id = ? ORDER BY id LIMIT 1)";

    type Class = { trigger: string; prepare?: (txn: string) => void; op: (txn: string) => void };
    const CLASSES: Class[] = [
      { trigger: "keepr_al_msg_del", op: () => run("DELETE FROM messages WHERE id = 'm-spare'") },
      { trigger: "keepr_al_msg_upd", op: () => run("UPDATE messages SET thread_id = 'chat-moved' WHERE id = 'm-spare'") },
      {
        trigger: "keepr_al_msg_unlink",
        prepare: (txn) => run("UPDATE messages SET transaction_id = ? WHERE id = 'm-spare'", txn), // a text attached to the deal ...
        op: () => run("UPDATE messages SET transaction_id = NULL WHERE id = 'm-spare'"), // ... is detached
      },
      { trigger: "keepr_al_email_del", op: () => run("DELETE FROM emails WHERE id = 'em-spare'") },
      { trigger: "keepr_al_email_upd", op: () => run("UPDATE emails SET subject = 'edited' WHERE id = 'em-spare'") },
      { trigger: "keepr_al_ep_del", op: () => run("DELETE FROM email_participants WHERE email_id = 'em-spare2'") },
      { trigger: "keepr_al_ep_upd", op: () => run("UPDATE email_participants SET email_address = 'moved@example.test' WHERE email_id = 'em-spare2'") },
      { trigger: "keepr_al_comm_del", op: (txn) => run(`DELETE FROM communications WHERE id = ${ownCommunication}`, txn) }, // unlink
      { trigger: "keepr_al_comm_upd", op: (txn) => run(`UPDATE communications SET thread_id = 'chat-moved' WHERE id = ${ownCommunication}`, txn) },
      {
        trigger: "keepr_al_ign_ins",
        op: (txn) => run("INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig-1', ?, ?, 'chat-ig')", USER, txn),
      },
      {
        trigger: "keepr_al_ign_del", // restore from ignored
        prepare: (txn) => run("INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig-1', ?, ?, 'chat-ig')", USER, txn),
        op: () => run("DELETE FROM ignored_communications WHERE id = 'ig-1'"),
      },
      {
        trigger: "keepr_al_ign_upd",
        prepare: (txn) => run("INSERT INTO ignored_communications (id, user_id, transaction_id, thread_id) VALUES ('ig-1', ?, ?, 'chat-ig')", USER, txn),
        op: () => run("UPDATE ignored_communications SET thread_id = 'chat-ig-2' WHERE id = 'ig-1'"),
      },
      { trigger: "keepr_al_ce_ins", op: () => run("INSERT INTO contact_emails (id, contact_id, email) VALUES ('e-new', 'c-ben', 'ben.new@example.test')") }, // contact email added
      { trigger: "keepr_al_ce_del", op: () => run("DELETE FROM contact_emails WHERE id = 'e-spare'") },
      { trigger: "keepr_al_ce_upd", op: () => run("UPDATE contact_emails SET email = 'ben.edited@example.test' WHERE id = 'e-c-ben'") },
      { trigger: "keepr_al_cp_ins", op: () => run("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES ('p-new2', 'c-ana', '+12065550177', '12065550177')") },
      { trigger: "keepr_al_cp_del", op: () => run("DELETE FROM contact_phones WHERE id = 'p-spare'") },
      { trigger: "keepr_al_cp_upd", op: () => run("UPDATE contact_phones SET phone_normalized = '12065550166' WHERE id = 'p-c-ana'") },
      {
        trigger: "keepr_al_tc_ins",
        op: () => run("INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES ('tc-spare2', 't-spare', 'c-spare2', 'seller')"),
      },
      { trigger: "keepr_al_tc_del", op: () => run("DELETE FROM transaction_contacts WHERE id = 'tc-spare'") },
      { trigger: "keepr_al_tc_upd", op: () => run("UPDATE transaction_contacts SET removed_at = '2025-04-01T00:00:00.000Z' WHERE id = 'tc-spare'") }, // party removed / merged
      { trigger: "keepr_al_txn_del", op: () => run("DELETE FROM transactions WHERE id = 't-spare-bare'") },
      {
        trigger: "keepr_al_txn_upd", // window / address change
        op: (txn) => run("UPDATE transactions SET started_at = '2024-06-01T00:00:00.000Z', property_address = '14 Probe Lane, Testville, WA 98000' WHERE id = ?", txn),
      },
      { trigger: "keepr_al_contact_del", op: () => run("DELETE FROM contacts WHERE id = 'c-spare2'") },
      { trigger: "keepr_al_user_upd", op: () => run("UPDATE users_local SET email = 'owner.new@example.test' WHERE id = ?", USER) },
    ];

    it("lists every trigger the tracker installs (a new trigger needs a class here)", () => {
      const source = readFileSync(path.join(__dirname, "../db/autoLinkInputTracker.ts"), "utf8");
      const declared = [...source.matchAll(/trigger\("(keepr_al_[a-z_]+)"/g)].map((m) => m[1]);
      expect(declared.length).toBeGreaterThan(20);
      expect(sorted(CLASSES.map((c) => c.trigger))).toEqual(sorted(declared));
    });

    it.each(CLASSES.map((c) => [c.trigger, c] as const))("%s: a write of its class is seen by the next on-open sync", async (_name, cls) => {
      addSpares();
      const txn = await createDeal();
      cls.prepare?.(txn);
      await sync(txn); // settle: remembers a clean sweep of everything set up so far
      swept = [];
      await sync(txn);
      expect(swept).toEqual([]); // nothing changed -> skipped, so the next sweep can only be the op's doing
      cls.op(txn);
      await sync(txn);
      expect(sorted(swept)).toEqual(sorted(CONTACTS));
    });
  });

  describe("the in-flight wait is bounded", () => {
    it("W1: a sweep that never settles does not hang the next caller", async () => {
      __setInFlightWaitTimeoutForTests(50);
      void runFullSweepOnce("t-hung", () => new Promise<{ clean: boolean }>(() => undefined), "hung");
      const second = await runFullSweepOnce("t-hung", async () => ({ clean: true }), "second");
      expect(second.ran).toBe(true);
    }, 3000);

    it("W2: a sweep that settles inside the wait is still waited for, not overtaken", async () => {
      __setInFlightWaitTimeoutForTests(5000);
      let release: () => void = () => undefined;
      const order: string[] = [];
      const first = runFullSweepOnce("t-slow", () => new Promise<{ clean: boolean }>((resolve) => {
        release = () => { order.push("first-done"); resolve({ clean: true }); };
      }), "first");
      const second = runFullSweepOnce("t-slow", async () => { order.push("second-ran"); return { clean: true }; }, "second");
      await new Promise((r) => setTimeout(r, 30));
      expect(order).toEqual([]); // second is still waiting
      release();
      await Promise.all([first, second]);
      expect(order[0]).toBe("first-done");
    }, 3000);
  });
});
