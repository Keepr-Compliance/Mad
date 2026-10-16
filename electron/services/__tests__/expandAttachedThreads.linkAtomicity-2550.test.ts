/**
 * @jest-environment node
 *
 * BACKLOG-2550: the thread expansion (`expandAttachedThreadsForUserOnce`) links each
 * candidate message with two writes: the junction row (`communications`) and the
 * pointer (`messages.transaction_id`). They must commit together or not at all, and
 * a pointer must never be written without its junction row.
 *
 * Why a pointer with no junction row is PERMANENT here: both candidate queries filter
 * `+m.transaction_id IS NULL` (`db/autoLinkSql.ts`), so a message with an orphan pointer
 * is never offered again, and every reader that joins through `communications` cannot
 * see it.
 *
 * Real driver + real schema.sql. Must run under the node environment: under jsdom
 * `setImmediate` is undefined and the expansion's outer catch turns that into a silent
 * `messagesLinked: 0`.
 *
 * Writes on the baseline, in order (measured): 1 snapshot bookkeeping
 * (`temp.keepr_expansion_gen`), 2 junction m-old1, 3 pointer m-old1, 4 junction m-old2,
 * 5 pointer m-old2, 6 `UPDATE transactions` (thread count).
 *
 * Controls (each mutation applied to autoLinkService.ts, proven applied, then reverted):
 *  - V0, the code before this fix (pointer, then async junction INSERT, two autocommits):
 *    crash sweep k=3 leaves `P-,PJ` and k=5 leaves `PJ,P-`, both still `P-` after a
 *    retry; lock race leaves `P-,P-`. RED.
 *  - F1, per-message transaction but POINTER FIRST and unconditional (the obvious copy
 *    of transactionService.linkMessages): crash sweep GREEN, lock race `P-,P-` RED.
 *    The lock-race case exists for this variant; the crash sweep cannot tell F1 from
 *    the fix.
 *  - W2, try/catch INSIDE the transaction: the crash is swallowed, the transaction
 *    commits the half it wrote. RED.
 *  - W3, only the junction INSERT inside the transaction, pointer after it: RED.
 *
 * k=6 (the thread-count UPDATE) asserts link states only. A crash there leaves
 * `text_thread_count` stale; that drift is cosmetic and out of scope.
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType, Statement } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

/** Calls 1..N see an open deal; later calls see it locked. Infinity = never locked. */
let mockOpenCalls = Infinity;
let mockLockCalls = 0;
jest.mock("../dealLockState", () => ({
  getDealLockReason: jest.fn(() => (++mockLockCalls <= mockOpenCalls ? null : "submitted")),
}));

import { setDb, dbTransaction } from "../db/core/dbConnection";
import { expandAttachedThreadsForUser, resetExpansionWatermarksForTests } from "../autoLinkService";
import { createCommunicationReferenceSync } from "../messageMatchingService";
import { linkMessageToTransaction } from "../db/messageDbService";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-2550";
const CONTACT = "contact-2550";
const CONTACT_PHONE = "+12065550103";
const A = "txn-a-2550";
const THREAD = "T-2550";
const MSGS = ["m-old1", "m-old2"];

const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
let writeCount = 0;
let crashAt = 0;
let firedAt = 0;
function resetInjector(at = 0): void {
  writeCount = 0;
  crashAt = at;
  firedAt = 0;
}
/** Throws on the k-th write statement run through this handle. */
function instrument(handle: DatabaseType): void {
  const realPrepare = handle.prepare.bind(handle);
  (handle as unknown as { prepare: (s: string) => Statement }).prepare = (source: string) => {
    const stmt = realPrepare(source);
    if (IS_WRITE.test(source)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...params: unknown[]) => {
        writeCount += 1;
        if (crashAt !== 0 && writeCount === crashAt) {
          firedAt = writeCount;
          throw new Error(`INJECTED CRASH at write ${writeCount}`);
        }
        return realRun(...(params as never[]));
      };
    }
    return stmt;
  };
}

let db: DatabaseType;
function insertText(id: string, sentAt: string): void {
  const last10 = CONTACT_PHONE.replace(/\D/g, "").slice(-10);
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at)
     VALUES (?, ?, 'imessage', 'inbound', 'see you at closing', ?, ?, ?, ?)`,
  ).run(id, USER, JSON.stringify({ from: CONTACT_PHONE, to: ["me"] }), `${last10},me`, THREAD, sentAt);
}
/** Seed transcribed from dealLock-3910.test.ts; the attach is linkMessages' chunk body. */
function seed(): void {
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent@keepr.test', 'google', 'o-1')`).run(USER);
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Lender')`).run(CONTACT, USER);
  db.prepare(`INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary) VALUES ('cp-1', ?, ?, 1)`).run(CONTACT, CONTACT_PHONE);
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, '100 Oak Street', 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
  ).run(A, USER);
  db.prepare(`INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES ('tc-a', ?, ?, 'buyer_agent')`).run(A, CONTACT);
  insertText("m-recent", "2026-03-01T16:00:00.000Z");
  dbTransaction(() => {
    linkMessageToTransaction("m-recent", A);
    createCommunicationReferenceSync("m-recent", A, USER, "manual", 1.0);
  });
  insertText("m-old1", "2020-01-01T00:00:00.000Z");
  insertText("m-old2", "2020-01-02T00:00:00.000Z");
}
/** `P` = pointer names A, `J` = junction row for A. */
function state(id: string): string {
  const p = db.prepare("SELECT transaction_id FROM messages WHERE id = ?").get(id) as { transaction_id: string | null };
  const j = db.prepare("SELECT 1 FROM communications WHERE message_id = ? AND transaction_id = ?").get(id, A);
  return `${p?.transaction_id === A ? "P" : "-"}${j ? "J" : "-"}`;
}
function junctionRows(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?").get(A) as { n: number }).n;
}

beforeEach(() => {
  resetExpansionWatermarksForTests();
  __resetFullSweepGuardForTests();
  mockOpenCalls = Infinity;
  mockLockCalls = 0;
  db = new Database(":memory:") as unknown as DatabaseType;
  instrument(db);
  setDb(db);
  seed();
});
afterEach(() => db.close());

describe("BACKLOG-2550: expansion links pointer and junction atomically", () => {
  it("baseline: links both siblings with six writes", async () => {
    resetInjector(0);
    const res = await expandAttachedThreadsForUser(USER);
    expect(res.messagesLinked).toBe(2);
    expect(res.errors).toBe(0);
    expect(writeCount).toBe(6);
    expect(MSGS.map(state)).toEqual(["PJ", "PJ"]);
    expect(junctionRows()).toBe(3);
  });

  // [k, sibling states after the crash, junction rows (incl. m-recent), messagesLinked, errors]
  const SWEEP: Array<[number, string[], number, number, number]> = [
    [2, ["--", "PJ"], 2, 1, 1], // junction m-old1
    [3, ["--", "PJ"], 2, 1, 1], // pointer m-old1: its junction row rolls back with it
    [4, ["PJ", "--"], 2, 1, 1], // junction m-old2
    [5, ["PJ", "--"], 2, 1, 1], // pointer m-old2
  ];
  it.each(SWEEP)(
    "crash at write %i: each message whole or absent, retry completes",
    async (k, expectedStates, expectedRows, expectedLinked, expectedErrors) => {
      resetInjector(k);
      const res = await expandAttachedThreadsForUser(USER);
      expect(firedAt).toBe(k);
      const after = MSGS.map(state);
      for (const s of after) expect(["PJ", "--"]).toContain(s);
      expect(after).toEqual(expectedStates);
      expect(junctionRows()).toBe(expectedRows);
      expect(res.messagesLinked).toBe(expectedLinked);
      expect(res.errors).toBe(expectedErrors);

      resetExpansionWatermarksForTests();
      resetInjector(0);
      const retry = await expandAttachedThreadsForUser(USER);
      expect(retry.messagesLinked).toBe(1);
      expect(MSGS.map(state)).toEqual(["PJ", "PJ"]);
      expect(junctionRows()).toBe(3);
    },
  );

  it("crash at write 1 (snapshot bookkeeping, before any link): both siblings link", async () => {
    resetInjector(1);
    const res = await expandAttachedThreadsForUser(USER);
    expect(firedAt).toBe(1);
    expect(MSGS.map(state)).toEqual(["PJ", "PJ"]);
    expect(junctionRows()).toBe(3);
    expect(res.messagesLinked).toBe(2);
    expect(res.errors).toBe(0);
  });

  it("crash at write 6 (thread count): link states only", async () => {
    resetInjector(6);
    await expandAttachedThreadsForUser(USER);
    expect(firedAt).toBe(6);
    expect(MSGS.map(state)).toEqual(["PJ", "PJ"]);
    expect(junctionRows()).toBe(3);
  });

  it("deal locked after the per-deal check: no pointer without a junction row", async () => {
    mockOpenCalls = 1; // the per-deal check passes; every link-time check sees a lock
    resetInjector(0);
    const res = await expandAttachedThreadsForUser(USER);
    expect(mockLockCalls).toBeGreaterThan(1);
    expect(MSGS.map(state)).toEqual(["--", "--"]);
    expect(junctionRows()).toBe(1);
    expect(res.messagesLinked).toBe(0);
    expect(res.errors).toBe(0);
  });
});
