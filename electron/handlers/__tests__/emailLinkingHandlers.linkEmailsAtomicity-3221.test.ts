/**
 * @jest-environment node
 *
 * BACKLOG-3221 — attaching emails to a transaction is all-or-nothing per email.
 *
 * ===========================================================================
 * WHAT THIS PROVES
 * ===========================================================================
 * `transactions:link-emails` writes, per email:
 *   - local-id path:   junction row, thread-count update                 (2)
 *   - gmail / outlook: email row, participant rows, junction row,
 *                      thread-count update                               (5 with
 *                      this fixture's two participants)
 * Before the fix a crash between those writes left half of them committed:
 * an email row with no link (crash at the junction), or a link whose count
 * update was lost while the handler reported linked 0. Each path now runs its
 * writes in one `dbTransaction`.
 *
 * The sweep crashes EVERY write, one at a time, on EVERY path, and asserts the
 * full contents of the four tables touched are unchanged. The write guard
 * cannot prove this: it clears a unit when any transaction appears anywhere in
 * it, so a transaction around the link write alone (or around one path of
 * three) reads green there. Only this sweep separates them.
 *
 * Harness: the REAL registered handler, the REAL db services, a REAL
 * better-sqlite3 handle with the shipped schema and `foreign_keys = ON`. The
 * crash injector wraps `run` on every write statement the handle prepares —
 * including the participant statement `createEmailSync` prepares on the raw
 * handle — so no write can escape the sweep. `exec` throws: it bypasses
 * `prepare`, so any write through it would be invisible to the injector.
 *
 * Provider fixtures are shaped from the producers' own `ParsedEmail` builders
 * (`gmailFetchService.ts` participants from RFC 5322 headers;
 * `outlookFetchService.ts` participants from Graph recipients): one `from` at
 * position 0, one `to` at position 0. Addresses use `example.com`.
 *
 * CONTROLS (mutation applied and proven each time; reds in the PR / pm_comments):
 *   - current code (no transaction): uuid crash 2, gmail/outlook crash 4 and 5 red
 *   - transaction around the link write only: gmail/outlook crash 4 and 5 red
 *   - `async` seam + un-awaited call inside the transaction: red
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

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: jest.fn() },
}));
jest.mock("../../services/gmailFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), getEmailById: jest.fn() },
}));
jest.mock("../../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), getEmailById: jest.fn() },
}));
jest.mock("../../services/emailSyncService", () => ({ __esModule: true, default: {} }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../../services/db/core/dbConnection";
import { createEmailSync } from "../../services/db/emailDbService";
import transactionService from "../../services/transactionService";
import gmailFetchService from "../../services/gmailFetchService";
import outlookFetchService from "../../services/outlookFetchService";
import logService from "../../services/logService";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "..", "database", "schema.sql"),
  "utf8",
);

// Generated per run: no fixed id can be mistaken for a live row.
const USER = crypto.randomUUID();
const TXN = crypto.randomUUID();
const GMAIL_MSG = "gmail-msg-0001";
const OUTLOOK_MSG = "outlook-msg-0001";
const TABLES = ["emails", "email_participants", "communications", "transactions"] as const;

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

/** Wraps `run` on every write statement the handle prepares, in place. */
function instrument(db: DatabaseType): void {
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (s: string) => Statement }).prepare = (source: string) => {
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
  (db as unknown as { exec: (s: string) => void }).exec = () => {
    throw new Error("unexpected exec on the link-emails write path");
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
let db: DatabaseType;
let localEmailId: string;

function providerEmail(id: string, threadId: string) {
  return {
    id,
    threadId,
    subject: "Inspection report",
    from: "Seller <seller@example.com>",
    to: "Agent <agent@example.com>",
    cc: null,
    bcc: null,
    date: new Date("2026-01-05T10:00:00.000Z"),
    sentDate: new Date("2026-01-05T10:00:00.000Z"),
    body: "<p>Report attached</p>",
    bodyPlain: "Report attached",
    snippet: "Report attached",
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    labels: [],
    messageIdHeader: `<${id}@example.com>`,
    inReplyTo: null,
    references: null,
    receivedAt: new Date("2026-01-05T10:00:00.000Z"),
    bulkMailHeaders: null,
    contentHash: `hash-${id}`,
    participants: [
      { email_address: "seller@example.com", display_name: "Seller", role: "from", position: 0 },
      { email_address: "agent@example.com", display_name: "Agent", role: "to", position: 0 },
    ],
  };
}

function seed(): void {
  db.exec(SCHEMA);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')",
  ).run(USER);
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, '1 Test St')",
  ).run(TXN, USER);
}

function snapshot(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return out;
}

/**
 * Run the handler. The `setImmediate` turn is load-bearing (2547 C2): a
 * rejection nobody awaited is delivered after the microtask queue drains, and
 * waiting one macrotask makes it fail THIS case by name.
 */
async function link(ids: string[]): Promise<{ success: boolean; linkedCount?: number }> {
  const fn = handlers.get("transactions:link-emails");
  if (!fn) throw new Error("handler not registered");
  const res = (await fn({}, ids, TXN)) as { success: boolean; linkedCount?: number };
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const PATHS = [
  { name: "local id", ids: () => [localEmailId], writes: 2 },
  { name: "gmail", ids: () => [`gmail:${GMAIL_MSG}`], writes: 5 },
  { name: "outlook", ids: () => [`outlook:${OUTLOOK_MSG}`], writes: 5 },
] as const;

beforeEach(() => {
  handlers.clear();
  jest.clearAllMocks();
  db = new Database(":memory:") as unknown as DatabaseType;
  seed();
  instrument(db);
  setDb(db);
  // The local email is written by the real producer, so its row shape is one
  // the app emits. It carries a body (no provider fetch) and a thread id.
  localEmailId = createEmailSync({
    user_id: USER,
    external_id: "local-ext-0001",
    source: "gmail",
    thread_id: "thread-local",
    sender: "seller@example.com",
    recipients: "agent@example.com",
    subject: "Offer",
    body_plain: "Offer attached",
    body_html: "<p>Offer attached</p>",
    sent_at: "2026-01-04T10:00:00.000Z",
    participants: [
      { email_address: "seller@example.com", display_name: null, role: "from", position: 0 },
    ],
  }).id;

  (transactionService.getTransactionDetails as jest.Mock).mockResolvedValue({
    id: TXN,
    user_id: USER,
  });
  (gmailFetchService.initialize as jest.Mock).mockResolvedValue(true);
  (gmailFetchService.getEmailById as jest.Mock).mockResolvedValue(
    providerEmail(GMAIL_MSG, "thread-gmail"),
  );
  (outlookFetchService.initialize as jest.Mock).mockResolvedValue(true);
  (outlookFetchService.getEmailById as jest.Mock).mockResolvedValue(
    providerEmail(OUTLOOK_MSG, "thread-outlook"),
  );

  registerEmailLinkingHandlers();
  resetInjector(0);
});

afterEach(() => {
  setDb(null as unknown as DatabaseType);
  db?.close();
});

// ===========================================================================
describe("BACKLOG-3221 preconditions — the instrument itself", () => {
  it.each(PATHS)("$name: fires exactly $writes writes and links 1", async ({ ids, writes }) => {
    const res = await link(ids());
    expect(res).toEqual({ success: true, linkedCount: 1 });
    expect(writeLog).toHaveLength(writes);
    expect(writeCount).toBe(writes);
    expect(firedAt).toBe(0);
  });

  it("the injector fires: crashing write 1 on the local-id path throws inside the handler", async () => {
    resetInjector(1);
    const res = await link([localEmailId]);
    expect(firedAt).toBe(1);
    expect(res.linkedCount).toBe(0);
    expect(
      (logService.warn as jest.Mock).mock.calls.some((c) =>
        JSON.stringify(c).includes(INJECTED),
      ),
    ).toBe(true);
  });
});

// ===========================================================================
describe("BACKLOG-3221 happy path — what a successful attach writes", () => {
  it("local id: one manual junction row for that email; no email row added", async () => {
    const before = snapshot();
    await link([localEmailId]);
    const after = snapshot();
    expect(after.emails).toEqual(before.emails);
    expect(
      db
        .prepare("SELECT transaction_id, email_id, link_source FROM communications")
        .all(),
    ).toEqual([{ transaction_id: TXN, email_id: localEmailId, link_source: "manual" }]);
  });

  it.each([
    { name: "gmail", id: `gmail:${GMAIL_MSG}`, ext: GMAIL_MSG, source: "gmail" },
    { name: "outlook", id: `outlook:${OUTLOOK_MSG}`, ext: OUTLOOK_MSG, source: "outlook" },
  ])("$name: email row, both participants and a manual junction row", async ({ id, ext, source }) => {
    await link([id]);
    const email = db
      .prepare("SELECT id, source FROM emails WHERE external_id = ?")
      .get(ext) as { id: string; source: string };
    expect(email.source).toBe(source);
    expect(
      db
        .prepare(
          "SELECT role, email_address FROM email_participants WHERE email_id = ? ORDER BY role",
        )
        .all(email.id),
    ).toEqual([
      { role: "from", email_address: "seller@example.com" },
      { role: "to", email_address: "agent@example.com" },
    ]);
    expect(
      db
        .prepare("SELECT transaction_id, email_id, link_source FROM communications")
        .all(),
    ).toEqual([{ transaction_id: TXN, email_id: email.id, link_source: "manual" }]);
  });
});

// ===========================================================================
describe("BACKLOG-3221 crash sweep — every write, every path, nothing persists", () => {
  const cases = PATHS.flatMap((p) =>
    Array.from({ length: p.writes }, (_, i) => ({ ...p, at: i + 1 })),
  );

  it.each(cases)("$name: crash at write $at leaves all four tables unchanged", async ({ ids, at }) => {
    const before = snapshot();
    resetInjector(at);

    const res = await link(ids());

    // C5: the injected throw actually happened at this write.
    expect(firedAt).toBe(at);
    expect(res).toEqual({ success: true, linkedCount: 0 });
    expect(snapshot()).toEqual(before);
  });
});
