/**
 * @jest-environment node
 *
 * BACKLOG-3309 / BACKLOG-3310 — removing a conversation from a transaction, and
 * putting it back, is all-or-nothing per conversation.
 *
 * ===========================================================================
 * WHAT THIS PROVES
 * ===========================================================================
 * Three user actions, each one logical write group:
 *   - unlink email (3309)     `unlinkCommunication`: per sibling, the
 *     suppression INSERT, the junction DELETE, the text_thread_count recompute
 *     the DELETE fires for a threaded row. Thread of 2 = 6 writes, a single
 *     email with no thread = 2.
 *   - restore email (3310)    `restoreRemovedEmailThread`: per sibling, the
 *     suppression DELETE, the junction INSERT, the recompute. Thread of 2 = 6.
 *   - restore text (3310)     `transactions:restore-removed-message`, through
 *     the REAL registered handler: the suppression DELETE now runs inside the
 *     LAST chunk of `linkMessages`.
 *
 * Before the fix a crash between those writes left an email LINKED AND IGNORED
 * (3309), NEITHER ignored nor linked (3310), or a conversation split in two —
 * and unlink reported success over every one of them.
 *
 * The sweep crashes EVERY write, one at a time, on every path, and asserts
 * BOTH that the call failed AND that the five tables are byte-for-byte
 * unchanged. Both halves are load-bearing: one-transaction-per-row rolls the
 * single-email path back cleanly but still reports success (SR plan review,
 * 3ebc1ae0), so a snapshot-only assertion reads that wrong fix as green.
 *
 * Harness: the REAL services and db layer over a REAL better-sqlite3 handle
 * (`setDb`) with the shipped schema and `foreign_keys = ON`. The injector wraps
 * `run` on every write statement the handle prepares; `exec` throws, because
 * it bypasses `prepare` and a write through it would be invisible here.
 * `databaseService` is redirected to the real db services through `async`
 * fakes, because every facade it stands in for is `async` (2547: a non-async
 * fake hides an un-awaited facade call inside a transaction body).
 *
 * Fixtures come from the real producers: `createEmailSync` and
 * `createCommunicationSync` for the emails and their links; the removed state
 * by running the real `unlinkCommunication` / `unlinkMessages`. Message rows
 * are transcribed from `linkQuitDeferral-3785.test.ts` (no app-side producer
 * writes `messages` outside sync). Addresses use `example.com`.
 *
 * CONTROLS (mutation applied and proven each time; reds in pm_comments on 3309):
 *   A. one transaction per ROW              — red (thread split / silent success)
 *   B. one thread transaction, try/catch inside — red (LINKED AND IGNORED)
 *   C. one statement wrapped                — red
 *   D. text un-ignore in the FIRST chunk    — red (D1, multi-chunk case)
 *   E. text un-ignore after the loop, outside any transaction — red
 *   F. `async` seam + un-awaited call inside the transaction — red
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
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
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

/**
 * Every name resolves to the real db-layer function of the same name, wrapped
 * in an `async` fake (see the header for why `async` is load-bearing).
 */
jest.mock("../databaseService", () => {
  const modules = [
    jest.requireActual("../db/communicationDbService"),
    jest.requireActual("../db/messageDbService"),
    jest.requireActual("../db/transactionDbService"),
    jest.requireActual("../db/transactionContactDbService"),
  ] as Array<Record<string, unknown>>;
  const target: Record<string | symbol, unknown> = {};
  const proxy = new Proxy(target, {
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

// The rejected-item route is BACKLOG-3320's, out of scope; these rows are
// ordinary removals, so it restores nothing.
jest.mock("../reviewStateService", () => ({
  __esModule: true,
  restoreRejectedToQueue: jest.fn().mockResolvedValue(0),
  notifyReviewStateChanged: jest.fn(),
}));

// Import-graph ballast. Not called on these paths.
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../autoLinkService", () => ({
  __esModule: true,
  autoLinkCommunicationsForContact: jest.fn(),
}));
jest.mock("../contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(),
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logTransactionAction: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
  isTextPeopleEnabled: jest.fn().mockResolvedValue(true),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../db/core/dbConnection";
import { createEmailSync } from "../db/emailDbService";
import { createCommunicationSync } from "../db/communicationDbService";
import { REMOVED_MESSAGES_SQL } from "../db/removedCommunicationSql";
import transactionService, {
  LINK_MESSAGES_CHUNK_SIZE,
} from "../transactionService/transactionService";
import { registerEmailLinkingHandlers } from "../../handlers/emailLinkingHandlers";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

// Generated per run: no fixed id can be mistaken for a live row.
const USER = crypto.randomUUID();
const TXN = crypto.randomUUID();
const THREAD_A = "thread-3309-a";
const TEXT_THREAD = "text-thread-3310";
const TABLES = [
  "emails",
  "communications",
  "ignored_communications",
  "transactions",
  "messages",
] as const;

// ---------------------------------------------------------------------------
// Crash injector
// ---------------------------------------------------------------------------
const INJECTED = "INJECTED CRASH";
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
let writeCount = 0;
let crashAt = 0;
/** The write index at which the injected throw actually fired (0 = never). */
let firedAt = 0;
let writeLog: string[] = [];

function resetInjector(at = 0): void {
  writeCount = 0;
  crashAt = at;
  firedAt = 0;
  writeLog = [];
}

function instrument(handle: DatabaseType): void {
  const realPrepare = handle.prepare.bind(handle);
  (handle as unknown as { prepare: (s: string) => Statement }).prepare = (source: string) => {
    const stmt = realPrepare(source);
    if (IS_WRITE.test(source)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...params: unknown[]) => {
        writeCount += 1;
        writeLog.push(source.trim().replace(/\s+/g, " ").slice(0, 40));
        if (crashAt !== 0 && writeCount === crashAt) {
          firedAt = writeCount;
          throw new Error(`${INJECTED} at write ${writeCount}`);
        }
        return realRun(...(params as never[]));
      };
    }
    return stmt;
  };
  (handle as unknown as { exec: (s: string) => void }).exec = () => {
    throw new Error("unexpected exec on the unlink/restore write path");
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
let db: DatabaseType;
/** communications.id for e1, e2 (THREAD_A) and e3 (no thread). */
let c1: string;
let c3: string;
let e1: string;
let e2: string;
let e3: string;

function seedEmail(n: number, threadId: string | null): string {
  return createEmailSync({
    user_id: USER,
    external_id: `ext-3309-${n}`,
    source: "gmail",
    thread_id: threadId ?? undefined,
    sender: "seller@example.com",
    recipients: "agent@example.com",
    subject: `Inspection ${n}`,
    body_plain: `Body ${n}`,
    body_html: `<p>Body ${n}</p>`,
    sent_at: `2026-01-0${n}T10:00:00.000Z`,
    participants: [
      { email_address: "seller@example.com", display_name: null, role: "from", position: 0 },
    ],
  } as never).id;
}

function linkEmail(emailId: string, threadId: string | null): string {
  return createCommunicationSync({
    user_id: USER,
    transaction_id: TXN,
    email_id: emailId,
    thread_id: threadId ?? undefined,
    communication_type: "email",
    link_source: "manual",
    link_confidence: 1.0,
    has_attachments: false,
    is_false_positive: false,
  } as never).id as string;
}

function seedMessages(count: number): string[] {
  const insert = db.prepare(
    `INSERT INTO messages (id, user_id, channel, direction, body_text, participants_flat,
                           thread_id, sent_at, transaction_id)
     VALUES (?, ?, 'sms', 'inbound', ?, '5550142', ?, '2026-01-05T10:00:00Z', NULL)`,
  );
  const ids = Array.from({ length: count }, (_, i) => `m-3310-${String(i).padStart(5, "0")}`);
  for (const id of ids) insert.run(id, USER, `body ${id}`, TEXT_THREAD);
  return ids;
}

beforeEach(() => {
  handlers.clear();
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')",
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Test St')",
  ).run(TXN, USER);
  instrument(db);
  setDb(db);

  e1 = seedEmail(1, THREAD_A);
  e2 = seedEmail(2, THREAD_A);
  e3 = seedEmail(3, null);
  c1 = linkEmail(e1, THREAD_A);
  linkEmail(e2, THREAD_A);
  c3 = linkEmail(e3, null);

  registerEmailLinkingHandlers();
  resetInjector(0);
});

afterEach(() => {
  setDb(null as unknown as DatabaseType);
  db?.close();
});

function snapshot(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return out;
}

/** "L" = a junction row links the email to TXN, "I" = a suppression row exists. */
function stateOf(emailId: string): string {
  const linked = db
    .prepare("SELECT 1 FROM communications WHERE email_id = ? AND transaction_id = ?")
    .get(emailId, TXN);
  const ignored = db
    .prepare("SELECT 1 FROM ignored_communications WHERE email_id = ? AND transaction_id = ?")
    .get(emailId, TXN);
  return `${linked ? "L" : "-"}${ignored ? "I" : "-"}`;
}

function ignoredIdFor(emailId: string): string {
  return (
    db
      .prepare("SELECT id FROM ignored_communications WHERE email_id = ? AND transaction_id = ?")
      .get(emailId, TXN) as { id: string }
  ).id;
}

/** One macrotask after the call: an unobserved rejection fails THIS case (2547 C2). */
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

const unlink = (commId: string) => settle(transactionService.unlinkCommunication(commId));
const restoreEmail = (ignoredId: string, emailId: string) =>
  settle(transactionService.restoreRemovedEmailThread(ignoredId, emailId, TXN, USER));

async function restoreText(
  ignoredId: string,
  messageIds: string[],
): Promise<{ success: boolean; error?: string }> {
  const fn = handlers.get("transactions:restore-removed-message");
  if (!fn) throw new Error("handler not registered");
  const res = (await fn({}, ignoredId, messageIds, TXN)) as { success: boolean; error?: string };
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

/** Link `count` messages and remove them again with the real producers. */
async function seedRemovedTextThread(count: number): Promise<{
  ignoredId: string;
  messageIds: string[];
  linkedCount: number;
}> {
  const ids = seedMessages(count);
  await transactionService.linkMessages(ids, TXN);
  const linkedCount = messageCount();
  await transactionService.unlinkMessages(ids, TXN);
  const rows = db.prepare(REMOVED_MESSAGES_SQL).all(TXN) as Array<{
    ignored_id: string;
    message_id: string;
  }>;
  const ignoredIds = [...new Set(rows.map((r) => r.ignored_id))];
  expect(ignoredIds).toHaveLength(1);
  return { ignoredId: ignoredIds[0], messageIds: rows.map((r) => r.message_id), linkedCount };
}

const messageCount = (): number =>
  (db.prepare("SELECT message_count FROM transactions WHERE id = ?").get(TXN) as {
    message_count: number;
  }).message_count;
const linkedMessages = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE transaction_id = ?").get(TXN) as {
    n: number;
  }).n;
const removedTextRows = (): number => db.prepare(REMOVED_MESSAGES_SQL).all(TXN).length;

const EMAIL_PATHS = {
  unlinkThread: 6,
  unlinkSingle: 2,
  restoreThread: 6,
  restoreSingle: 2,
  restoreText: 6,
} as const;

// ===========================================================================
describe("BACKLOG-3309/3310 preconditions — the instrument itself", () => {
  it("unlink thread: 6 writes, both siblings removed, both suppressed", async () => {
    const r = await unlink(c1);
    expect(r.ok).toBe(true);
    expect(writeCount).toBe(EMAIL_PATHS.unlinkThread);
    expect(firedAt).toBe(0);
    expect([stateOf(e1), stateOf(e2), stateOf(e3)]).toEqual(["-I", "-I", "L-"]);
  });

  it("unlink single (no thread): 2 writes", async () => {
    const r = await unlink(c3);
    expect(r.ok).toBe(true);
    expect(writeCount).toBe(EMAIL_PATHS.unlinkSingle);
    expect([stateOf(e1), stateOf(e2), stateOf(e3)]).toEqual(["L-", "L-", "-I"]);
  });

  it("restore thread: 6 writes, both siblings linked again, no suppression left", async () => {
    await unlink(c1);
    resetInjector(0);
    const r = await restoreEmail(ignoredIdFor(e1), e1);
    expect(r.ok && r.value).toEqual({ restoredCount: 2 });
    expect(writeCount).toBe(EMAIL_PATHS.restoreThread);
    expect([stateOf(e1), stateOf(e2), stateOf(e3)]).toEqual(["L-", "L-", "L-"]);
  });

  it("restore single: 2 writes", async () => {
    await unlink(c3);
    resetInjector(0);
    const r = await restoreEmail(ignoredIdFor(e3), e3);
    expect(r.ok && r.value).toEqual({ restoredCount: 1 });
    expect(writeCount).toBe(EMAIL_PATHS.restoreSingle);
    expect(stateOf(e3)).toBe("L-");
  });

  it("restore text (real handler): 6 writes, thread relinked, suppression gone", async () => {
    const { ignoredId, messageIds, linkedCount } = await seedRemovedTextThread(2);
    expect(messageIds).toHaveLength(2);
    resetInjector(0);
    const res = await restoreText(ignoredId, messageIds);
    expect(res).toEqual({ success: true });
    expect(writeCount).toBe(EMAIL_PATHS.restoreText);
    expect(linkedMessages()).toBe(2);
    expect(removedTextRows()).toBe(0);
    expect(messageCount()).toBe(linkedCount);
  });

  it("the injector fires: crashing write 1 of an unlink throws out of the call", async () => {
    resetInjector(1);
    const r = await unlink(c1);
    expect(firedAt).toBe(1);
    expect(r.ok).toBe(false);
    expect(String((r as { err: unknown }).err)).toContain(INJECTED);
  });
});

// ===========================================================================
describe("BACKLOG-3309/3310 crash sweep — every write, every path: call fails, nothing persists", () => {
  const sweep = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it.each(sweep(EMAIL_PATHS.unlinkThread))("unlink thread: crash at write %i", async (at) => {
    const before = snapshot();
    resetInjector(at);
    const r = await unlink(c1);
    expect(firedAt).toBe(at);
    expect(r.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it.each(sweep(EMAIL_PATHS.unlinkSingle))("unlink single: crash at write %i", async (at) => {
    const before = snapshot();
    resetInjector(at);
    const r = await unlink(c3);
    expect(firedAt).toBe(at);
    expect(r.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it.each(sweep(EMAIL_PATHS.restoreThread))("restore thread: crash at write %i", async (at) => {
    await unlink(c1);
    const ignoredId = ignoredIdFor(e1);
    const before = snapshot();
    resetInjector(at);
    const r = await restoreEmail(ignoredId, e1);
    expect(firedAt).toBe(at);
    expect(r.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it.each(sweep(EMAIL_PATHS.restoreSingle))("restore single: crash at write %i", async (at) => {
    await unlink(c3);
    const ignoredId = ignoredIdFor(e3);
    const before = snapshot();
    resetInjector(at);
    const r = await restoreEmail(ignoredId, e3);
    expect(firedAt).toBe(at);
    expect(r.ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it.each(sweep(EMAIL_PATHS.restoreText))(
    "restore text (real handler): crash at write %i",
    async (at) => {
      const { ignoredId, messageIds } = await seedRemovedTextThread(2);
      const before = snapshot();
      resetInjector(at);
      const res = await restoreText(ignoredId, messageIds);
      expect(firedAt).toBe(at);
      expect(res.success).toBe(false);
      expect(snapshot()).toEqual(before);
    },
  );
});

// ===========================================================================
describe("BACKLOG-3310 round trip — an email is always exactly one of linked / removed", () => {
  const exactlyOne = (s: string) => s === "L-" || s === "-I";

  it.each(Array.from({ length: EMAIL_PATHS.unlinkThread }, (_, i) => i + 1))(
    "unlink crash at write %i",
    async (at) => {
      resetInjector(at);
      await unlink(c1);
      expect(firedAt).toBe(at);
      for (const e of [e1, e2, e3]) expect(exactlyOne(stateOf(e))).toBe(true);
    },
  );

  it.each(Array.from({ length: EMAIL_PATHS.restoreThread }, (_, i) => i + 1))(
    "restore crash at write %i after a clean unlink",
    async (at) => {
      await unlink(c1);
      const ignoredId = ignoredIdFor(e1);
      resetInjector(at);
      await restoreEmail(ignoredId, e1);
      expect(firedAt).toBe(at);
      for (const e of [e1, e2, e3]) expect(exactlyOne(stateOf(e))).toBe(true);
      // And the retry the Removed card offers completes the conversation.
      resetInjector(0);
      const retry = await restoreEmail(ignoredId, e1);
      expect(retry.ok).toBe(true);
      expect([stateOf(e1), stateOf(e2), stateOf(e3)]).toEqual(["L-", "L-", "L-"]);
    },
  );
});

// ===========================================================================
describe("BACKLOG-3310 D1 — a text restore larger than one chunk", () => {
  // One full chunk plus one message: the last chunk is chunk 2.
  const COUNT = LINK_MESSAGES_CHUNK_SIZE + 1;

  it("a crash in the LAST chunk keeps the thread on the Removed card, and one retry completes it", async () => {
    const { ignoredId, messageIds, linkedCount } = await seedRemovedTextThread(COUNT);
    expect(messageIds).toHaveLength(COUNT);

    // Chunk 1 = one pointer UPDATE + one junction INSERT per message,
    // plus the count UPDATE. Its last write is the count UPDATE; the next write
    // is the first statement of chunk 2.
    const chunk1Writes = LINK_MESSAGES_CHUNK_SIZE * 2 + 1;
    resetInjector(chunk1Writes + 1);
    const res = await restoreText(ignoredId, messageIds);
    expect(firedAt).toBe(chunk1Writes + 1);
    expect(writeLog[chunk1Writes - 1]).toMatch(/^UPDATE transactions/);
    expect(res.success).toBe(false);

    // Chunk 1 committed (3785's own residual) ...
    expect(linkedMessages()).toBe(LINK_MESSAGES_CHUNK_SIZE);
    // ... but the suppression row survived with chunk 2's rollback, so the
    // Removed card still lists the whole thread — the user has a way back.
    expect(db.prepare("SELECT 1 FROM ignored_communications WHERE id = ?").get(ignoredId)).toBeTruthy();
    expect(removedTextRows()).toBe(COUNT);

    // The retry the card issues completes it, with an exact count.
    resetInjector(0);
    const again = (db.prepare(REMOVED_MESSAGES_SQL).all(TXN) as Array<{ message_id: string }>).map(
      (r) => r.message_id,
    );
    const retry = await restoreText(ignoredId, again);
    expect(retry).toEqual({ success: true });
    expect(linkedMessages()).toBe(COUNT);
    expect(removedTextRows()).toBe(0);
    expect(db.prepare("SELECT 1 FROM ignored_communications WHERE id = ?").get(ignoredId)).toBeUndefined();
    expect(messageCount()).toBe(linkedCount);
  });

  it("a crash in the FIRST chunk changes nothing", async () => {
    const { ignoredId, messageIds } = await seedRemovedTextThread(COUNT);
    const before = snapshot();
    resetInjector(1);
    const res = await restoreText(ignoredId, messageIds);
    expect(firedAt).toBe(1);
    expect(res.success).toBe(false);
    expect(snapshot()).toEqual(before);
  });
});
