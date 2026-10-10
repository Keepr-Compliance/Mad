/**
 * @jest-environment node
 *
 * BACKLOG-3884 — the Texts tab of a deal whose linked threads carry a whole phone
 * history read every linked text in one reply (PC: 183,043 rows, ~152 MB, 15 s).
 * It now reads a conversation list and pages. This suite runs the REAL readers on a
 * REAL encrypted database built from schema.sql (fixture: helpers/textPagingFixture3884).
 *
 * Gates (each was made to fail on purpose; see the BACKLOG-3884 pm_comments):
 *  - every page reply is bounded (rows and bytes), whatever limit is asked for;
 *  - walking the pages returns every expected id exactly once (ID sets, all history
 *    and audit window), at several page sizes so page boundaries land inside
 *    same-timestamp groups and duplicate pairs;
 *  - the export reader (getCommunicationsWithMessages, unchanged) returns the
 *    expected set and includes every in-window id the pages show;
 *  - the oldest in-window message of the biggest thread is reachable (no silent cap);
 *  - the conversation counts equal what the pages return.
 * Timings and sizes are printed, not asserted (runner speed varies — the #2915 rule).
 *
 * Size: KEEPR_3884_ROWS (default 20000; the PC deal is ~183000). Real driver: run under
 * Electron —
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the binary cannot load and the suite is skipped.
 */
import * as nodePath from "path";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3884"), isPackaged: true } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { setDb } from "../db/core/dbConnection";
import { getCommunicationsWithMessages } from "../db/communicationDbService";
import {
  MAX_SAME_TIMESTAMP_GROUP,
  MAX_TEXT_PAGE_ROWS,
  readTransactionTextPage,
  readTransactionTextThreadsOn,
  type TextPageCursor,
  type TextWindow,
} from "../db/transactionTextPagingDb";
import { buildTextPagingFixture, TXN, WINDOW_END_ISO, WINDOW_START_ISO, type TextPagingFixture } from "./helpers/textPagingFixture3884";
import { resolveExportPlan } from "../exportPlan";
import { build } from "esbuild";
import { initializePool, isPoolReady, setContactWorkerPathForTests, shutdownPool } from "../../workers/contactWorkerPool";
import { getTransactionTextThreads } from "../transactionTextThreadsService";
import { transactionTextThreadsSql } from "../db/transactionTextPagingDb";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const ROWS = Number(process.env.KEEPR_3884_ROWS ?? 20000);
const REPLY_BOUND_BYTES = 2 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require(DRIVER);
  new Database(":memory:").close();
} catch {
  Database = null;
}

const WINDOW: TextWindow = { startMs: Date.parse(WINDOW_START_ISO), endMs: Date.parse(WINDOW_END_ISO) };
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
const isReaction = (r: { associated_message_type?: number | null }): boolean =>
  typeof r.associated_message_type === "number" && r.associated_message_type >= 2000 && r.associated_message_type <= 3005;

interface Walk {
  ids: string[];
  pages: number;
  maxRows: number;
  maxBytes: number;
  firstPageMs: number;
  firstPageBytes: number;
  totalMs: number;
}

function walk(f: TextPagingFixture, threads: string[], w: TextWindow | null, limit: number): Walk {
  const ids: string[] = [];
  let cursor: TextPageCursor | null = null;
  let pages = 0;
  let maxRows = 0;
  let maxBytes = 0;
  let firstPageMs = 0;
  let firstPageBytes = 0;
  const t0 = Date.now();
  for (;;) {
    const t = Date.now();
    const page = readTransactionTextPage(f.db, TXN, threads, w, cursor, limit);
    const ms = Date.now() - t;
    const b = bytes(page);
    if (pages === 0) {
      firstPageMs = ms;
      firstPageBytes = b;
    }
    pages += 1;
    maxRows = Math.max(maxRows, page.rows.length);
    maxBytes = Math.max(maxBytes, b);
    for (const r of page.rows) ids.push(r.id as string);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    if (pages > 100000) throw new Error("runaway paging");
  }
  return { ids, pages, maxRows, maxBytes, firstPageMs, firstPageBytes, totalMs: Date.now() - t0 };
}

function expectSameSet(actual: string[], expected: Set<string>, label: string): void {
  const dupes = actual.length - new Set(actual).size;
  expect({ label, dupes }).toEqual({ label, dupes: 0 });
  const a = new Set(actual);
  const missing = [...expected].filter((id) => !a.has(id));
  const extra = [...a].filter((id) => !expected.has(id));
  expect({ label, missing: missing.slice(0, 5), missingCount: missing.length }).toEqual({ label, missing: [], missingCount: 0 });
  expect({ label, extra: extra.slice(0, 5), extraCount: extra.length }).toEqual({ label, extra: [], extraCount: 0 });
  expect(a.size).toBeGreaterThan(0);
}

(Database ? describe : describe.skip)("BACKLOG-3884 Texts tab: conversation list + pages", () => {
  let f: TextPagingFixture;

  beforeAll(() => {
    f = buildTextPagingFixture(Database, ROWS);
    setDb(f.db);
  });

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    f?.db.close();
  });

  it("measures the old full read against the new list + first page", async () => {
    const t0 = Date.now();
    const full = await getCommunicationsWithMessages(TXN, "text");
    const fullMs = Date.now() - t0;
    const fullBytes = bytes({ success: true, transaction: { communications: full } });

    const t1 = Date.now();
    const threads = readTransactionTextThreadsOn(f.db, TXN, WINDOW);
    const listMs = Date.now() - t1;
    const listBytes = bytes(threads);

    const big = walk(f, [f.bigThread], WINDOW, MAX_TEXT_PAGE_ROWS);
    const t2 = Date.now();
    const histFirst = readTransactionTextPage(f.db, TXN, [f.bigThread], null, null, MAX_TEXT_PAGE_ROWS);
    const histMs = Date.now() - t2;
    process.stderr.write(
      `[3884] rows=${f.rows} BEFORE get-communications(text): ms=${fullMs} rows=${full.length} bytes=${fullBytes}\n` +
        `[3884] AFTER get-text-threads: ms=${listMs} threads=${threads.length} bytes=${listBytes}\n` +
        `[3884] AFTER first page of ${f.bigThread} (window): ms=${big.firstPageMs} bytes=${big.firstPageBytes}; ` +
        `all ${big.pages} window pages: ms=${big.totalMs} rows=${big.ids.length} maxPageBytes=${big.maxBytes}\n` +
        `[3884] AFTER first page of ${f.bigThread} (all history): ms=${histMs} rows=${histFirst.rows.length} bytes=${bytes(histFirst)}\n`,
    );
    // The one-time cost of the new index on an existing database (schema.sql's exec).
    f.db.exec("DROP INDEX idx_messages_thread_sent");
    const t3 = Date.now();
    f.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_thread_sent ON messages(thread_id, sent_at)");
    process.stderr.write(`[3884] CREATE INDEX idx_messages_thread_sent over ${f.rows} messages: ms=${Date.now() - t3}\n`);
    expect(full.length).toBeGreaterThan(0);
    expect(threads.length).toBeGreaterThan(0);
  });

  it("C1 bounds every reply, whatever limit is asked for", () => {
    for (const t of [...f.threadIds, "__unthreaded__"]) {
      const huge = walk(f, [t], null, 1_000_000);
      expect(huge.maxRows).toBeLessThanOrEqual(MAX_TEXT_PAGE_ROWS + MAX_SAME_TIMESTAMP_GROUP);
      expect(huge.maxBytes).toBeLessThanOrEqual(REPLY_BOUND_BYTES);
    }
    const one = readTransactionTextPage(f.db, TXN, [f.bigThread], null, null, 1_000_000);
    // A page is the cap plus, at most, the rest of its last same-timestamp group.
    expect(one.rows.length).toBeGreaterThan(0);
    expect(one.rows.length).toBeLessThan(MAX_TEXT_PAGE_ROWS + 10);
    const list = readTransactionTextThreadsOn(f.db, TXN, WINDOW);
    expect(bytes(list)).toBeLessThanOrEqual(REPLY_BOUND_BYTES);
  });

  it("C2 pages return every expected id exactly once (all history and window, several page sizes)", () => {
    // All history: every row of every thread, at two page sizes (a walk costs one
    // read of the thread per page, so the small sizes run on the window below).
    for (const limit of [13, MAX_TEXT_PAGE_ROWS]) {
      const all: string[] = [];
      for (const t of [...f.threadIds, "__unthreaded__"]) {
        const a = walk(f, [t], null, limit);
        expectSameSet(a.ids, f.expectedByThread.get(t)!, `thread ${t} limit ${limit}`);
        all.push(...a.ids);
      }
      expectSameSet(all, f.expectedAll, `all history limit ${limit}`);
    }
    for (const limit of [2, 3, 7, 50, MAX_TEXT_PAGE_ROWS]) {
      const win: string[] = [];
      for (const t of [...f.threadIds, "__unthreaded__"]) win.push(...walk(f, [t], WINDOW, limit).ids);
      expectSameSet(win, f.expectedInWindow, `window limit ${limit}`);
    }
  });

  it("C2b a merged card (several threads in one request) pages every id once", () => {
    const pair = [f.threadIds[1], f.threadIds[2]];
    const expected = new Set([...f.expectedByThread.get(pair[0])!, ...f.expectedByThread.get(pair[1])!]);
    expectSameSet(walk(f, pair, null, 7).ids, expected, "merged pair");
  });

  it("C3 the export reader is unchanged and includes every in-window id the pages show", async () => {
    const full = await getCommunicationsWithMessages(TXN, "text");
    expectSameSet(full.map((r) => r.id as string), f.expectedAll, "export reader (text)");
    const plan = resolveExportPlan(
      { format: "folder", contentType: "texts", attachmentType: "none", emailMode: "thread", startDate: null, endDate: null },
      await getCommunicationsWithMessages(TXN),
    );
    const exported = new Set(plan.communications.map((r) => r.id as string));
    const shown: string[] = [];
    for (const t of [...f.threadIds, "__unthreaded__"]) shown.push(...walk(f, [t], WINDOW, MAX_TEXT_PAGE_ROWS).ids);
    const hiddenOrReaction = new Set(
      full.filter((r) => (r as { hidden_from_export?: number }).hidden_from_export || isReaction(r as never)).map((r) => r.id as string),
    );
    const missingFromExport = shown.filter((id) => !hiddenOrReaction.has(id) && !exported.has(id));
    expect({ missingFromExport: missingFromExport.slice(0, 5), n: missingFromExport.length }).toEqual({ missingFromExport: [], n: 0 });
    expect(shown.length).toBeGreaterThan(0);
  });

  it("C5 the oldest in-window message of the biggest thread is reachable by paging", () => {
    expect(f.bigThreadOldestInWindowId).not.toBe("");
    const w = walk(f, [f.bigThread], WINDOW, 10);
    expect(w.pages).toBeGreaterThan(1);
    expect(w.ids).toContain(f.bigThreadOldestInWindowId);
    const real = f.realCounts.get(f.bigThread)!.inWindow;
    expect(real).toBeGreaterThan(10);
  });

  it("conversation counts equal what the pages return", () => {
    const list = readTransactionTextThreadsOn(f.db, TXN, WINDOW);
    const keys = new Set(list.map((t) => t.threadId));
    expect(keys).toEqual(new Set([...f.threadIds, "__unthreaded__"]));
    for (const t of list) {
      expect({ t: t.threadId, total: t.totalCount, inWindow: t.inWindowCount }).toEqual({
        t: t.threadId,
        total: f.realCounts.get(t.threadId)!.total,
        inWindow: f.realCounts.get(t.threadId)!.inWindow,
      });
      expect(t.samples.length).toBeGreaterThan(0);
      expect(t.samples.every((s) => (s as { body_text?: unknown }).body_text === undefined)).toBe(true);
    }
  });
  it("the conversation list is read on a dedicated worker (real worker), equal to the main read, never prepared on main", async () => {
    const workerScript = nodePath.join(f.dir, "contactQueryWorker.js");
    await build({
      entryPoints: [nodePath.join(__dirname, "..", "..", "workers", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerScript,
      plugins: [
        {
          name: "driver-from-repo",
          setup(b) {
            b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: DRIVER, external: true }));
          },
        },
      ],
      logLevel: "silent",
    });
    setContactWorkerPathForTests(workerScript);
    await initializePool(nodePath.join(f.dir, "mad.db"), "3884".repeat(16));
    for (let i = 0; i < 200 && !isPoolReady(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(isPoolReady()).toBe(true);

    const listSql = transactionTextThreadsSql();
    let preparedOnMain = 0;
    const realPrepare = f.db.prepare.bind(f.db);
    f.db.prepare = (q: string) => {
      if (q === listSql) preparedOnMain += 1;
      return realPrepare(q);
    };
    try {
      const fromWorker = await getTransactionTextThreads(TXN, WINDOW);
      expect(preparedOnMain).toBe(0);
      const onMain = readTransactionTextThreadsOn(f.db, TXN, WINDOW);
      expect(fromWorker.length).toBeGreaterThan(0);
      expect(fromWorker).toEqual(onMain);
    } finally {
      f.db.prepare = realPrepare;
    }
  }, 300_000);
});
