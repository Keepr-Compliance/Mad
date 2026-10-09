/**
 * @jest-environment node
 *
 * BACKLOG-3785 — the thread-link join must not be driven by user_id.
 *
 * Two readers join `communications` to `messages` with
 *   (c.message_id = m.id) OR (c.thread_id = m.thread_id AND m.user_id = c.user_id)
 * With no `sqlite_stat1` — the normal state of a user's database, because
 * ANALYZE runs only from the maintenance reindex — SQLite planned the second
 * branch as `SEARCH m USING INDEX idx_messages_user_sent (user_id=?)`: a scan of
 * every message the user has, once per communications row. On a 670k-message
 * profile with stats removed, 175 link rows took 51.8 s (texts reader) and
 * 12.1 s (attachments reader) on the main process. Writing the term as
 * `+m.user_id` keeps the filter and moves the branch onto idx_messages_thread_id
 * (7 ms / 21 ms, same rows).
 *
 * This suite captures the SQL each reader actually prepares and asks SQLite,
 * on the real schema with NO ANALYZE, how it would run it.
 */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let realDb: TestDb | null = null;
const prepared: string[] = [];

const recording = {
  prepare(sql: string) {
    prepared.push(sql);
    return realDb!.prepare(sql);
  },
  exec: (sql: string) => realDb!.exec(sql),
  transaction: <T,>(fn: () => T) => realDb!.transaction(fn),
};

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => recording,
  dbAll: (sql: string, params: unknown[] = []) => recording.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) => recording.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = recording.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbTransaction: <T,>(fn: () => T): T => recording.transaction(fn)(),
  dbExec: (sql: string) => recording.exec(sql),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

import { getCommunicationsWithMessages } from "../communicationDbService";
import { getTransactionAllAttachments } from "../attachmentDbService";

const SCHEMA_PATH = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const TX = "tx-3785-plan";

beforeAll(() => {
  realDb = openTestDb();
  realDb.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // Deliberately NO `ANALYZE`: that is the state the planner bug needs.
});
afterAll(() => {
  realDb?.close();
  realDb = null;
});
beforeEach(() => {
  prepared.length = 0;
});

function threadJoinPlan(): string[] {
  const statements = prepared.filter((s) => /c\.thread_id\s*=\s*m\.thread_id/.test(s));
  expect(statements.length).toBeGreaterThan(0);
  return statements.flatMap((sqlText) => {
    // `?` also appears inside SQL comments, so find the bound-parameter count
    // by asking the engine (too many and too few both throw).
    const stmt = realDb!.prepare(`EXPLAIN QUERY PLAN ${sqlText}`);
    for (let n = (sqlText.match(/\?/g) ?? []).length; n >= 0; n--) {
      try {
        return (stmt.all(...new Array(n).fill("x")) as Array<{ detail: string }>).map((r) => r.detail);
      } catch {
        /* wrong parameter count — try one fewer */
      }
    }
    throw new Error("could not EXPLAIN the captured statement");
  });
}

describe("thread-link join plan without sqlite_stat1 (BACKLOG-3785)", () => {
  it("there are no planner statistics in this database", () => {
    const stat = realDb!
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'")
      .get() as { n: number };
    expect(stat.n).toBe(0);
  });

  it("the texts reader searches messages by thread, never by user", async () => {
    await getCommunicationsWithMessages(TX, "text");
    const plan = threadJoinPlan();
    expect(plan.some((d) => d.includes("idx_messages_thread_id"))).toBe(true);
    expect(plan.filter((d) => /SEARCH m USING INDEX \w+ \(user_id=\?/.test(d))).toEqual([]);
  });

  it("the attachments reader searches messages by thread, never by user", () => {
    getTransactionAllAttachments(TX);
    const plan = threadJoinPlan();
    expect(plan.some((d) => d.includes("idx_messages_thread_id"))).toBe(true);
    expect(plan.filter((d) => /SEARCH m USING INDEX \w+ \(user_id=\?/.test(d))).toEqual([]);
  });
});
