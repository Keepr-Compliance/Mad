/**
 * @jest-environment node
 *
 * BACKLOG-3320 — restoring a rejected review item is all-or-nothing per card.
 *
 * ===========================================================================
 * WHAT THIS PROVES
 * ===========================================================================
 * `restoreRejectedToQueue` puts a rejected email (and every rejected email in
 * its thread) back on the review queue: per sibling, one INSERT into
 * `pending_review_communications` and one DELETE from `ignored_communications`.
 * A thread of 2 is 4 writes; a single unthreaded email is 2.
 *
 * Before the fix a crash between those writes left an email queued AND still
 * rejected (both lists at once), or a two-email card split in two — and the
 * broadcast and log never ran, but the half-state stayed.
 *
 * The sweep crashes EVERY write, one at a time, and asserts per case:
 *   - the injected crash fired at exactly that write (`firedAt === k`);
 *   - the call threw (no result returned);
 *   - the pending / ignored / communications tables are byte-for-byte unchanged;
 *   - no broadcast and no "Restored a rejected item" log;
 *   - a retry then restores every sibling.
 * The no-crash baseline asserts the returned count, the write count, exactly
 * one broadcast, and that the broadcast ran OUTSIDE the transaction
 * (`db.inTransaction` recorded as `[false]`).
 *
 * One case runs through the REAL registered `transactions:restore-removed-email`
 * handler: a crash there must fail the response and must not fall through to
 * the link-recreating restore (no `communications` row written).
 *
 * Harness: the REAL service over a REAL better-sqlite3 handle (`setDb`) with the
 * shipped schema. The injector wraps `run` on every write statement the handle
 * prepares. Fixtures come from the real producers: emails addressed by a party
 * contact -> `syncReviewQueueForTransaction` queues them -> `rejectReviewItems`
 * writes the rejection rows (asserted before every case). Addresses use
 * example.com.
 *
 * No text case: no tagged release produces a rejected TEXT row (SR plan review
 * on 3320, C3). The text branch takes the same `toRestore = [row]` path as the
 * single unthreaded email below.
 *
 * CONTROLS (mutation applied and proven each time; reds in pm_comments on 3320):
 *   V0. current code (no transaction)                                 — red
 *   V2. one transaction per ROW, with the outer transaction REMOVED   — red
 *       (thread crash@3/@4: card split). Applied on top of the outer
 *       transaction it is a savepoint and changes nothing — vacuous.
 *   V3. only the INSERT wrapped                                       — red
 *   V4. one transaction, try/catch inside the loop                    — red
 *   V5. notify moved inside the transaction                           — red
 *       (baseline: broadcast recorded inTransaction=true)
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

import logService from "../logService";
import { setDb } from "../db/core/dbConnection";
import {
  getReviewState,
  syncReviewQueueForTransaction,
  rejectReviewItems,
  restoreRejectedToQueue,
} from "../reviewStateService";
import { registerEmailLinkingHandlers } from "../../handlers/emailLinkingHandlers";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

// Generated per run: no fixed id can be mistaken for a live row.
const USER = crypto.randomUUID();
const TXN = crypto.randomUUID();
const CONTACT = crypto.randomUUID();
const THREAD = "thread-3320";
const TABLES = ["pending_review_communications", "ignored_communications", "communications"] as const;

// ---------------------------------------------------------------------------
// Crash injector
// ---------------------------------------------------------------------------
const INJECTED = "INJECTED CRASH";
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
let writeCount = 0;
let crashAt = 0;
/** The write index at which the injected throw actually fired (0 = never). */
let firedAt = 0;

function resetInjector(at = 0): void {
  writeCount = 0;
  crashAt = at;
  firedAt = 0;
}

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
          throw new Error(`${INJECTED} at write ${writeCount}`);
        }
        return realRun(...(params as never[]));
      };
    }
    return stmt;
  };
}

// ---------------------------------------------------------------------------
// Fixture (real producers)
// ---------------------------------------------------------------------------
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

/** "Q" = queued for review, "R" = a rejection row exists. */
function stateOf(emailId: string): string {
  const q = db
    .prepare("SELECT 1 FROM pending_review_communications WHERE email_id = ? AND transaction_id = ?")
    .get(emailId, TXN);
  const r = db
    .prepare("SELECT 1 FROM ignored_communications WHERE email_id = ? AND transaction_id = ?")
    .get(emailId, TXN);
  return `${q ? "Q" : "-"}${r ? "R" : "-"}`;
}

function snapshot(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return out;
}

function ignoredIdFor(emailId: string): string {
  return (
    db
      .prepare("SELECT id FROM ignored_communications WHERE email_id = ? AND transaction_id = ?")
      .get(emailId, TXN) as { id: string }
  ).id;
}

const restoredLogs = (): number =>
  (logService.debug as jest.Mock).mock.calls.filter(
    (c) => c[0] === "Restored a rejected item to the review queue",
  ).length;

beforeEach(async () => {
  handlers.clear();
  mockBroadcastInTx.length = 0;
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS i1 ON pending_review_communications(transaction_id,email_id) WHERE email_id IS NOT NULL;",
  );
  db.prepare(
    "INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')",
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id,user_id,property_address,started_at,closed_at) VALUES (?,?,?,?,?)",
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id,user_id,display_name) VALUES (?,?,?)").run(CONTACT, USER, "Seller");
  db.prepare("INSERT INTO contact_emails (id,contact_id,email) VALUES (?,?,?)").run(
    crypto.randomUUID(), CONTACT, "seller@example.com",
  );
  db.prepare("INSERT INTO transaction_contacts (id,transaction_id,contact_id) VALUES (?,?,?)").run(
    crypto.randomUUID(), TXN, CONTACT,
  );
  instrument(db);
  setDb(db);
  mockDbRef.db = db;

  addEmail("e1", THREAD);
  addEmail("e2", THREAD);
  addEmail("e3", null);
  await syncReviewQueueForTransaction({ transactionId: TXN, reason: "open" });
  await rejectReviewItems(getReviewState(TXN).items.map((i) => i.id));
  // Every email starts rejected and not queued, written by the real producers.
  expect(["e1", "e2", "e3"].map(stateOf)).toEqual(["-R", "-R", "-R"]);

  registerEmailLinkingHandlers();
  resetInjector(0);
  mockBroadcastInTx.length = 0;
  (logService.debug as jest.Mock).mockClear();
});

afterEach(() => {
  mockDbRef.db = null;
  setDb(null as unknown as DatabaseType);
  db?.close();
});

/** One macrotask after the call: an unobserved rejection fails THIS case. */
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

const CASES = [
  { name: "thread of 2", rep: "e1", emails: ["e1", "e2"], writes: 4 },
  { name: "single unthreaded email", rep: "e3", emails: ["e3"], writes: 2 },
] as const;

describe.each(CASES)("restoreRejectedToQueue — $name", ({ rep, emails, writes }) => {
  it("baseline: restores every sibling, one broadcast, after commit", async () => {
    const res = await settle(restoreRejectedToQueue(ignoredIdFor(rep)));
    expect(res).toEqual({ ok: true, value: emails.length });
    expect(writeCount).toBe(writes);
    expect(emails.map(stateOf)).toEqual(emails.map(() => "Q-"));
    expect(mockBroadcastInTx).toEqual([false]);
    expect(restoredLogs()).toBe(1);
  });

  it.each(Array.from({ length: writes }, (_, i) => i + 1))(
    "crash at write %i: throws, changes nothing, announces nothing; retry restores all",
    async (k) => {
      const id = ignoredIdFor(rep);
      const before = snapshot();
      resetInjector(k);

      const res = await settle(restoreRejectedToQueue(id));

      expect(firedAt).toBe(k);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(String(res.err)).toContain(INJECTED);
      expect(snapshot()).toEqual(before);
      expect(emails.map(stateOf)).toEqual(emails.map(() => "-R"));
      expect(mockBroadcastInTx).toEqual([]);
      expect(restoredLogs()).toBe(0);

      resetInjector(0);
      const retry = await settle(restoreRejectedToQueue(id));
      expect(retry).toEqual({ ok: true, value: emails.length });
      expect(emails.map(stateOf)).toEqual(emails.map(() => "Q-"));
    },
  );
});

describe("through the real transactions:restore-removed-email handler", () => {
  it("a crash fails the response and does not fall through to the link restore", async () => {
    const fn = handlers.get("transactions:restore-removed-email");
    if (!fn) throw new Error("handler not registered");
    const before = snapshot();
    resetInjector(3);

    const res = (await fn({}, ignoredIdFor("e1"), "e1", TXN)) as { success: boolean };
    await new Promise((resolve) => setImmediate(resolve));

    expect(firedAt).toBe(3);
    expect(res.success).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(["e1", "e2"].map(stateOf)).toEqual(["-R", "-R"]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?").get(TXN),
    ).toEqual({ n: 0 });
    expect(mockBroadcastInTx).toEqual([]);
  });

  it("without a crash, reports both emails restored to the queue", async () => {
    const fn = handlers.get("transactions:restore-removed-email");
    if (!fn) throw new Error("handler not registered");
    const res = (await fn({}, ignoredIdFor("e1"), "e1", TXN)) as {
      success: boolean;
      restoredCount?: number;
    };
    expect(res).toEqual({ success: true, restoredCount: 2 });
    expect(["e1", "e2"].map(stateOf)).toEqual(["Q-", "Q-"]);
    expect(mockBroadcastInTx).toEqual([false]);
  });
});
