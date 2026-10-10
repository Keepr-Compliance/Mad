/**
 * @jest-environment node
 *
 * BACKLOG-3868: the attached-thread expansion and the targeted identity read must stay on
 * the indexes that make them targeted. Production never runs ANALYZE, so with no table
 * statistics SQLite chooses by heuristics — and for `user_id = ? AND thread_id = ?` it
 * chose idx_messages_user_sent: every message of the user, once per attached thread
 * (5.5 s of main-thread stall for 5 attached threads, encrypted 671k-message store, Mac).
 *
 * Plans are read from the REAL schema.sql with no statistics (the production regime).
 * Real driver: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <file>
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";
import { UNLINKED_SIBLINGS_IN_THREAD_SQL, unlinkedMessagesInThreadsSql } from "../autoLinkSql";
import { readThreadIdentitiesOn, readThreadIdsWithRowsAfterOn, readTargetedThreadIdentityOn, MAX_MESSAGE_ROWID_SQL } from "../threadIdentityTargetedDb";

const DRIVER = path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3868] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

maybe("BACKLOG-3868 query plans on the real schema, no statistics", () => {
  let db: DatabaseType;
  beforeAll(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    db.exec(readFileSync(path.join(__dirname, "../../../database/schema.sql"), "utf8"));
  });
  afterAll(() => db.close());

  function plan(sqlText: string): string {
    const n = (sqlText.match(/\?/g) ?? []).length;
    return (db.prepare(`EXPLAIN QUERY PLAN ${sqlText}`).all(...Array(n).fill("x")) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");
  }

  /** The statements the identity helpers issue, captured from the helpers themselves. */
  function captured(run: (runner: { prepare(s: string): { all(...p: unknown[]): unknown[] } }) => void): string[] {
    const texts: string[] = [];
    run({
      prepare: (s: string) => {
        texts.push(s);
        return {
          all: () =>
            s.includes("SELECT DISTINCT thread_id")
              ? [{ thread_id: "t2" }]
              : [{ thread_id: "t1", direction: "inbound", participants: '{"from":"+12065550103","to":["me"]}' }],
        };
      },
    });
    return texts;
  }

  it("sibling read: one thread through idx_messages_thread_id", () => {
    expect(plan(UNLINKED_SIBLINGS_IN_THREAD_SQL)).toMatch(/^SEARCH m USING INDEX idx_messages_thread_id \(thread_id=\?\)$/);
  });

  it("cross-thread read: the listed threads through idx_messages_thread_id", () => {
    expect(plan(unlinkedMessagesInThreadsSql(3))).toMatch(/^SEARCH m USING INDEX idx_messages_thread_id \(thread_id=\?\)$/);
  });

  it("thread rows for identity: idx_messages_thread_id", () => {
    const [threadRows] = captured((r) => readThreadIdentitiesOn(r, "u", ["a", "b"]));
    expect(plan(threadRows)).toMatch(/^SEARCH messages USING INDEX idx_messages_thread_id \(thread_id=\?\)$/);
  });

  it("rows added since a rowid: a rowid range on idx_messages_user_id", () => {
    const [since] = captured((r) => readThreadIdsWithRowsAfterOn(r, "u", 1));
    expect(plan(since)).toMatch(/^SEARCH messages USING INDEX idx_messages_user_id \(user_id=\? AND rowid>\?\)/);
  });

  it("newest rowid: an index seek on idx_messages_user_id (no table read)", () => {
    expect(plan(MAX_MESSAGE_ROWID_SQL)).toMatch(/^SEARCH messages USING COVERING INDEX idx_messages_user_id \(user_id=\?\)$/);
  });

  it("targeted read: attached and found threads by thread index; the superset filter is the only scan", () => {
    const texts = captured((r) => readTargetedThreadIdentityOn(r, "u", ["t1"]));
    expect(texts).toHaveLength(3);
    expect(plan(texts[0])).toMatch(/idx_messages_thread_id \(thread_id=\?\)/);
    expect(plan(texts[2])).toMatch(/idx_messages_thread_id \(thread_id=\?\)/);
    // the superset filter reads the user's rows once, inside SQLite
    expect(plan(texts[1])).toMatch(/^SEARCH messages USING INDEX idx_messages_user_(sent|id) \(user_id=\?\)/);
  });
});
