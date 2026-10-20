/**
 * @jest-environment node
 *
 * BACKLOG-2845 — approve and reject in the review queue are all-or-nothing per
 * call: one click (one card, or "Approve all" / "Reject all") is one IPC call
 * and one `dbTransaction`.
 *
 * ===========================================================================
 * WHAT THIS PROVES
 * ===========================================================================
 * Writes per item, in order (counted by the injector below):
 *   approve pending   3  link INSERT, twin UPDATE (0 rows), pending DELETE
 *   approve twin      2  twin UPDATE (link already exists), pending DELETE
 *   approve legacy    1  UPDATE match_reason -> user_confirmed
 *   reject pending    3  suppression INSERT, pending DELETE, twin DELETE (0 rows)
 *   reject twin       3  suppression INSERT, pending DELETE, twin DELETE
 *   reject legacy     2  suppression INSERT, link DELETE
 * A two-email card in one call is 6.
 *
 * Before the fix a crash between those writes left an email linked AND still
 * queued, or rejected AND still linked (still counted by getReviewState, so the
 * Complete gate never cleared), and a two-email card could split in two.
 *
 * For each path the baseline asserts the result, the EXACT write count above,
 * the end state, one broadcast recorded OUTSIDE the transaction
 * (`db.inTransaction` = `[false]`), and that EVERY write ran inside a
 * transaction (the per-write `db.inTransaction` list is non-empty and all
 * true). That last check is the guard for "a write placed outside the
 * transaction" — `writeAtomicity.guard.test.ts` cannot see it any more (its
 * entries were removed; it stops seeing the async wrappers whether or not the
 * writes are inside, measured).
 *
 * The sweep then crashes EVERY write k = 1..N of that path, generated from the
 * path's write count (no early return), and asserts: the crash fired at exactly
 * write k; the call threw; pending / ignored / communications / transactions
 * are row-for-row unchanged; the review item id set and getReviewState count
 * are unchanged; no broadcast; and a retry completes. The same sweep runs over a
 * two-email card (writes 1..6) and through the real registered `review:approve`
 * and `review:reject` handlers (crash at write 2 -> `success: false`, nothing
 * written).
 *
 * Harness: the REAL services over a REAL better-sqlite3 handle (`setDb`) with
 * the shipped schema, run under ELECTRON_RUN_AS_NODE. Fixtures come only from
 * real writers: `queueEmailForReview` writes the pending row;
 * `linkEmailToTransaction(..., "auto", 0.5, "address_missing")` writes the
 * legacy link. Start state asserted per case. Addresses use example.com.
 *
 * FIXTURE NOTES
 *  - The TWIN (a pending row AND an address_missing link for one email) is a
 *    historical data state written by v2.29.x; no live caller produces it at
 *    this SHA (all three callers of queueEmailForReview skip emails already
 *    linked, and the reverse order is refused by the BACKLOG-2880 gate). It is
 *    built by calling the two real writers directly. resolveLegacyTwinsSync
 *    exists for exactly that persisted data. Every mutation below that reds a
 *    twin case also reds a non-twin case.
 *  - TEXT branches (a pending row with a thread and no email) are wrapped for
 *    shape but guarded by NO control here: no tagged release produces a pending
 *    TEXT row (3320 SR C3 precedent, re-checked on 2845).
 *  - Not everything inside the transaction is a write: addIgnoredCommunicationSync
 *    fires `void logService.debug("[BACKLOG-1560] addIgnoredCommunication
 *    SUCCESS")` inside the reject body, so a rolled-back reject still logs that
 *    line at debug level. Pre-existing, not changed. The "no broadcast"
 *    assertions cover the review broadcast only.
 *
 * CONTROLS — each applied by exact-string replace (asserted to match once),
 * MUTATION APPLIED printed with the mutated line, tsc clean, a non-zero test
 * count asserted, file restored and compared byte-for-byte. Counts are failed /
 * total for this suite; full output in pm_comments on BACKLOG-2845.
@@CONTROLS@@
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

/** One entry per broadcast: was the database inside a transaction at that moment? */
const mockBroadcastInTx: boolean[] = [];
const mockDbRef: { db: DatabaseType | null } = { db: null };
jest.mock("../../capabilities/windowsProvider", () => {
  const actual = jest.requireActual("../../capabilities/windowsProvider");
  return {
    ...actual,
    hostWindows: {
      broadcast: jest.fn((channel: string) => {
        if (channel === "review:queue-changed") {
          mockBroadcastInTx.push(Boolean(mockDbRef.db?.inTransaction));
        }
      }),
    },
  };
});

/** The handler's transaction lookup goes through the facade; route it to the db layer. */
jest.mock("../databaseService", () => {
  const modules = [
    jest.requireActual("../db/communicationDbService"),
    jest.requireActual("../db/transactionDbService"),
    jest.requireActual("../db/transactionContactDbService"),
  ] as Array<Record<string, unknown>>;
  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      const owner = modules.find((m) => typeof m[name] === "function");
      if (!owner) return undefined;
      const fn = owner[name] as (...a: unknown[]) => unknown;
      return async (...args: unknown[]) => fn(...args);
    },
  });
  return { __esModule: true, default: proxy };
});

// Import-graph ballast. Not called on these paths.
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logTransactionAction: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../db/core/dbConnection";
import {
  getReviewState,
  queueEmailForReview,
  approveReviewItems,
  rejectReviewItems,
} from "../reviewStateService";
import { linkEmailToTransaction } from "../autoLinkService";
import { registerReviewQueueHandlers } from "../../handlers/reviewQueueHandlers";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

// Generated per run: no fixed id can be mistaken for a live row.
const USER = crypto.randomUUID();
const TXN = crypto.randomUUID();
const TABLES = ["pending_review_communications", "ignored_communications", "communications", "transactions"] as const;

// ---------------------------------------------------------------------------
// Crash injector: wraps `run` on every write statement the handle prepares.
// ---------------------------------------------------------------------------
const INJECTED = "INJECTED CRASH";
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
let writeCount = 0;
let crashAt = 0;
/** The write index at which the injected throw actually fired (0 = never). */
let firedAt = 0;
/** `db.inTransaction` at each write, in order. */
let writeInTx: boolean[] = [];

function resetInjector(at = 0): void {
  writeCount = 0;
  crashAt = at;
  firedAt = 0;
  writeInTx = [];
}

function instrument(handle: DatabaseType): void {
  const realPrepare = handle.prepare.bind(handle);
  (handle as unknown as { prepare: (s: string) => Statement }).prepare = (source: string) => {
    const stmt = realPrepare(source);
    if (IS_WRITE.test(source)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...params: unknown[]) => {
        writeCount += 1;
        writeInTx.push(handle.inTransaction);
        if (crashAt !== 0 && writeCount === crashAt) {
          firedAt = writeCount;
          throw new Error(`${INJECTED} at write ${writeCount}`);
        }
        return realRun(...(params as never[]));
      };
    }
    return stmt;
  };
}

let db: DatabaseType;

function addEmail(id: string, threadId: string | null): void {
  db.prepare(
    `INSERT INTO emails (id,user_id,subject,sender,body_plain,sent_at,created_at,thread_id)
     VALUES (?,?,?, 'seller@example.com', 'Are you free Thursday?', '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP, ?)`,
  ).run(id, USER, `S ${id}`, threadId);
  db.prepare(
    `INSERT INTO email_participants (email_id,role,position,participant_hash,email_address)
     VALUES (?, 'from', 0, ?, 'seller@example.com')`,
  ).run(id, `h-${id}`);
}

/** Q = queued, R = rejection row, then the link rows' match_reason list. */
function stateOf(emailId: string): string {
  const q = db.prepare("SELECT 1 FROM pending_review_communications WHERE email_id = ? AND transaction_id = ?").get(emailId, TXN);
  const r = db.prepare("SELECT 1 FROM ignored_communications WHERE email_id = ? AND transaction_id = ?").get(emailId, TXN);
  const links = (db.prepare("SELECT match_reason FROM communications WHERE email_id = ? AND transaction_id = ? ORDER BY rowid").all(emailId, TXN) as { match_reason: string | null }[]).map((x) => x.match_reason);
  return `${q ? "Q" : "-"}${r ? "R" : "-"}[${links.join(",")}]`;
}

function snapshot(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return out;
}

const reviewIds = (): string[] => getReviewState(TXN).items.map((i) => i.id).sort();
const itemIdFor = (emailId: string): string => {
  const it = getReviewState(TXN).items.find((i) => i.email_id === emailId);
  if (!it) throw new Error(`no review item for ${emailId}`);
  return it.id;
};

beforeEach(() => {
  // Reset FIRST: a crash point left over from the previous case would
  // otherwise fire inside this case's fixture (plan Issue #1).
  resetInjector(0);
  handlers.clear();
  mockBroadcastInTx.length = 0;
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')").run(USER);
  db.prepare("INSERT INTO transactions (id,user_id,property_address,started_at,closed_at) VALUES (?,?,?,?,?)").run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  instrument(db);
  setDb(db);
  mockDbRef.db = db;
  registerReviewQueueHandlers();
});

afterEach(() => {
  mockDbRef.db = null;
  setDb(null as unknown as DatabaseType);
  db?.close();
});

/** Await the call, then one macrotask, so a promise escaping the call lands before we look. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> {
  let out: { ok: true; value: T } | { ok: false; err: unknown };
  try {
    out = { ok: true, value: await p };
  } catch (err) {
    out = { ok: false, err };
  }
  await new Promise((resolve) => setImmediate(resolve));
  return out;
}

type Kind = "pending" | "twin" | "legacy";
type Verb = "approve" | "reject";

/** Each fixture kind, built only by real writer functions (see FIXTURE NOTES). */
async function make(emailId: string, kind: Kind, threadId: string | null = null): Promise<void> {
  addEmail(emailId, threadId);
  if (kind === "twin" || kind === "legacy") {
    expect(await linkEmailToTransaction(emailId, TXN, "auto", 0.5, "address_missing")).toBe("linked");
  }
  if (kind === "pending" || kind === "twin") {
    expect(await queueEmailForReview(TXN, emailId, USER)).toBe(true);
  }
}

const call = (verb: Verb, ids: string[]): Promise<unknown> =>
  verb === "approve" ? approveReviewItems(ids) : rejectReviewItems(ids);
const RESULT: Record<Verb, (n: number) => unknown> = {
  approve: (n) => ({ approved: n }),
  reject: (n) => ({ rejected: n }),
};
const START: Record<Kind, string> = { pending: "Q-[]", twin: "Q-[address_missing]", legacy: "--[address_missing]" };
const DONE: Record<Verb, string> = { approve: "--[user_confirmed]", reject: "-R[]" };

const SINGLE: Array<{ verb: Verb; kind: Kind; writes: number }> = [
  { verb: "approve", kind: "pending", writes: 3 },
  { verb: "approve", kind: "twin", writes: 2 },
  { verb: "approve", kind: "legacy", writes: 1 },
  { verb: "reject", kind: "pending", writes: 3 },
  { verb: "reject", kind: "twin", writes: 3 },
  { verb: "reject", kind: "legacy", writes: 2 },
];
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe.each(SINGLE)("$verb one $kind item", ({ verb, kind, writes }) => {
  it(`baseline: ${writes} write(s), every one inside the transaction, one broadcast after commit`, async () => {
    await make("e1", kind);
    expect(stateOf("e1")).toBe(START[kind]);
    mockBroadcastInTx.length = 0;
    resetInjector(0);

    const res = await settle(call(verb, [itemIdFor("e1")]));

    expect(res).toEqual({ ok: true, value: RESULT[verb](1) });
    expect(writeCount).toBe(writes);
    expect(writeInTx).toHaveLength(writes);
    expect(writeInTx.every((inTx) => inTx === true)).toBe(true);
    expect(stateOf("e1")).toBe(DONE[verb]);
    expect(getReviewState(TXN).count).toBe(0);
    expect(mockBroadcastInTx).toEqual([false]);
  });

  it.each(range(writes))("crash at write %i of " + writes + ": nothing changes, call throws, retry completes", async (k) => {
    await make("e1", kind);
    expect(stateOf("e1")).toBe(START[kind]);
    const id = itemIdFor("e1");
    const before = snapshot();
    const idsBefore = reviewIds();
    const countBefore = getReviewState(TXN).count;
    expect(countBefore).toBe(1);
    mockBroadcastInTx.length = 0;
    resetInjector(k);

    const res = await settle(call(verb, [id]));

    expect(firedAt).toBe(k);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(String(res.err)).toContain(INJECTED);
    expect(snapshot()).toEqual(before);
    expect(reviewIds()).toEqual(idsBefore);
    expect(getReviewState(TXN).count).toBe(countBefore);
    expect(mockBroadcastInTx).toEqual([]);

    resetInjector(0);
    const retry = await settle(call(verb, [id]));
    expect(retry).toEqual({ ok: true, value: RESULT[verb](1) });
    expect(stateOf("e1")).toBe(DONE[verb]);
  });
});

// The item's own named control, verbatim: reject an email that has a legacy
// twin, crash at write 3 (after the pending DELETE, at the twin DELETE).
// Before the fix the pending row was gone, the link alive, and the item still
// counted by getReviewState: the stuck-Complete state BACKLOG-2845 describes.
it("reject with a legacy twin, crash at write 3: review count and item ids unchanged", async () => {
  await make("e1", "twin");
  expect(stateOf("e1")).toBe(START.twin);
  const id = itemIdFor("e1");
  const idsBefore = reviewIds();
  const countBefore = getReviewState(TXN).count;
  resetInjector(3);

  const res = await settle(rejectReviewItems([id]));

  expect(firedAt).toBe(3);
  expect(res.ok).toBe(false);
  expect(getReviewState(TXN).count).toBe(countBefore);
  expect(reviewIds()).toEqual(idsBefore);
  expect(stateOf("e1")).toBe(START.twin);
});

// Two emails in ONE thread, ONE call: what a two-email card or "Approve all" sends.
describe.each(["approve", "reject"] as const)("%s a two-email card in one call", (verb) => {
  const BATCH_WRITES = 6;

  it(`baseline: both done, ${BATCH_WRITES} writes all inside one transaction, one broadcast after commit`, async () => {
    await make("e1", "pending", "t1");
    await make("e2", "pending", "t1");
    const ids = [itemIdFor("e1"), itemIdFor("e2")];
    mockBroadcastInTx.length = 0;
    resetInjector(0);

    const res = await settle(call(verb, ids));

    expect(res).toEqual({ ok: true, value: RESULT[verb](2) });
    expect(writeCount).toBe(BATCH_WRITES);
    expect(writeInTx).toHaveLength(BATCH_WRITES);
    expect(writeInTx.every((inTx) => inTx === true)).toBe(true);
    expect([stateOf("e1"), stateOf("e2")]).toEqual([DONE[verb], DONE[verb]]);
    expect(mockBroadcastInTx).toEqual([false]);
  });

  it.each(range(BATCH_WRITES))("crash at write %i: neither email changes (no split card)", async (k) => {
    await make("e1", "pending", "t1");
    await make("e2", "pending", "t1");
    const ids = [itemIdFor("e1"), itemIdFor("e2")];
    const before = snapshot();
    mockBroadcastInTx.length = 0;
    resetInjector(k);

    const res = await settle(call(verb, ids));

    expect(firedAt).toBe(k);
    expect(res.ok).toBe(false);
    // Item 1 is writes 1-3 and item 2 is writes 4-6: a crash in item 2 must
    // roll item 1 back too (one transaction per call, BACKLOG-2845 D1).
    expect([stateOf("e1"), stateOf("e2")]).toEqual([START.pending, START.pending]);
    expect(snapshot()).toEqual(before);
    expect(getReviewState(TXN).count).toBe(2);
    expect(mockBroadcastInTx).toEqual([]);
  });
});

describe("through the real registered handlers", () => {
  it.each(["review:approve", "review:reject"])("%s, crash at write 2: success false, nothing written", async (channel) => {
    await make("e1", "twin");
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`${channel} handler not registered`);
    const before = snapshot();
    resetInjector(2);

    const res = await fn({}, [itemIdFor("e1")]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(firedAt).toBe(2);
    expect((res as { success?: boolean }).success).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(mockBroadcastInTx).toEqual([]);
  });
});
