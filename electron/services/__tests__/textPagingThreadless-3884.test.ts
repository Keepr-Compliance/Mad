/**
 * @jest-environment node
 *
 * BACKLOG-3884 (SR delta 75e0873c) — a page of one person's thread-less texts is
 * bounded. Thread-less texts have no index to page on; the reader used to build the
 * FULL row (recipients json_each, hidden-text EXISTS) of every thread-less text of the
 * deal, several times per page, on main (SR: 4.5 s per page at 20k). Now one cheap read
 * (link id, message id, sent_at, participants) per request is grouped per person in
 * memory, and full rows are built only for the page.
 *
 * Gate (counts, not timings — the #2915 rule): every page request makes ONE cheap read
 * of the thread-less texts, builds full rows for at most one page (cap + the rest of a
 * same-timestamp group) in one statement, and walking every page returns each of the
 * person's ids exactly once. Timings are printed.
 *
 * Fixture: KEEPR_3884_THREADLESS (default 20000) thread-less texts, linked per message
 * the way the iPhone importer leaves them when chatId is missing
 * (iPhoneSyncStorageService: thread_id NULL), across two people, in one deal; plus a
 * few named-thread texts. Real encrypted DB from schema.sql. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3884tl"), isPackaged: true } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  MAX_SAME_TIMESTAMP_GROUP,
  MAX_TEXT_PAGE_ROWS,
  lastTextPageBuiltRowsForTests,
  readTransactionTextPage,
  type TextPageCursor,
} from "../db/transactionTextPagingDb";
import { threadlessTextKey } from "../db/threadlessTextKey";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const N = Number(process.env.KEEPR_3884_THREADLESS ?? 20000);
const USER = "u-3884tl";
const TXN = "t-3884tl";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require(DRIVER);
  new Database(":memory:").close();
} catch {
  Database = null;
}

(Database ? describe : describe.skip)("BACKLOG-3884 a page of a person's thread-less texts is bounded", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const people = ["+12065550111", "+12065550112"];
  const expected = new Map<string, Set<string>>();
  let fullRowStatements = 0;
  let threadlessReads = 0;

  beforeAll(() => {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3884tl-"));
    db = new Database(nodePath.join(dir, "mad.db"));
    db.pragma(`key = "x'${"3884".repeat(16)}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 't@example.test', 'google', 'o-t')").run(USER);
    db.prepare(
      "INSERT INTO transactions (id, user_id, property_address, transaction_type, status, started_at, closed_at) VALUES (?, ?, '3 Test St', 'purchase', 'active', '2026-03-01', '2026-06-30')",
    ).run(TXN, USER);
    const insMsg = db.prepare(
      `INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at, received_at, thread_id, participants, external_id)
       VALUES (?, ?, 'sms', 'inbound', ?, ?, ?, ?, ?, ?)`,
    );
    const insComm = db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id, thread_id, link_source) VALUES (?, ?, ?, ?, ?, 'auto')");
    const base = Date.parse("2018-01-01T00:00:00.000Z");
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const from = people[i % 2];
        const p = JSON.stringify({ from, to: ["me"] });
        // Bursts sharing one sent_at, so pages end inside same-timestamp groups.
        const iso = new Date(base + Math.floor(i / 3) * 60_000).toISOString();
        const id = `tl${i}`;
        insMsg.run(id, USER, `threadless ${i} ${"y".repeat(40 + (i % 300))}`, iso, iso, null, p, `ext-${id}`);
        insComm.run(`c-${id}`, USER, TXN, id, null);
        const key = threadlessTextKey(p, id);
        if (!expected.has(key)) expected.set(key, new Set());
        expected.get(key)!.add(id);
      }
      // A named thread too, so the request path is the real one.
      for (let i = 0; i < 50; i++) {
        const p = JSON.stringify({ from: people[0], to: ["me"] });
        const iso = new Date(base + i * 3_600_000).toISOString();
        insMsg.run(`nt${i}`, USER, `named ${i}`, iso, iso, "thr-named", p, `ext-nt${i}`);
      }
      insComm.run("c-thr-named", USER, TXN, null, "thr-named");
    })();
    const realPrepare = db.prepare.bind(db);
    db.prepare = (s: string) => {
      if (s.includes("json_each(json_extract(m.participants, '$.to'))")) fullRowStatements += 1;
      if (s.includes("m.sent_at AS sk, m.participants AS participants")) threadlessReads += 1;
      return realPrepare(s);
    };
  });

  afterAll(() => db?.close());

  it("builds full rows for at most one page per request, and pages every id once", () => {
    const key = threadlessTextKey(JSON.stringify({ from: people[0], to: ["me"] }), "x");
    const want = expected.get(key)!;
    expect(want.size).toBeGreaterThan(MAX_TEXT_PAGE_ROWS);
    const seen: string[] = [];
    let cursor: TextPageCursor | null = null;
    let pages = 0;
    let worstMs = 0;
    let firstMs = 0;
    let maxBuilt = 0;
    let maxStatements = 0;
    let maxThreadlessReads = 0;
    do {
      fullRowStatements = 0;
      threadlessReads = 0;
      const t = Date.now();
      const page = readTransactionTextPage(db, TXN, [key], null, cursor, MAX_TEXT_PAGE_ROWS);
      const ms = Date.now() - t;
      if (pages === 0) firstMs = ms;
      worstMs = Math.max(worstMs, ms);
      maxBuilt = Math.max(maxBuilt, lastTextPageBuiltRowsForTests());
      maxStatements = Math.max(maxStatements, fullRowStatements);
      maxThreadlessReads = Math.max(maxThreadlessReads, threadlessReads);
      for (const r of page.rows) seen.push(r.id as string);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 10_000) throw new Error("runaway paging");
    } while (cursor);
    process.stderr.write(
      `[3884] thread-less: ${N} on the deal, ${want.size} for one person; first page ${firstMs} ms, worst page ${worstMs} ms, ` +
        `${pages} pages, max full rows built per request ${maxBuilt}\n`,
    );
    expect(maxBuilt).toBeGreaterThan(0);
    expect(maxBuilt).toBeLessThanOrEqual(MAX_TEXT_PAGE_ROWS + MAX_SAME_TIMESTAMP_GROUP);
    expect(maxStatements).toBe(1);
    // One cheap read of the deal's thread-less texts per request, grouped once.
    expect(maxThreadlessReads).toBe(1);
    expect(seen.length).toBe(want.size);
    expect(new Set(seen)).toEqual(want);
  });
});
