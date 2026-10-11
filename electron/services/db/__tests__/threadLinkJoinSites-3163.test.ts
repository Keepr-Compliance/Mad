/**
 * @jest-environment node
 */
/**
 * BACKLOG-3163 S1 — every thread-link join must search `messages` (or
 * `communications`) by THREAD, never by user.
 *
 * The join `c.thread_id = m.thread_id AND m.user_id = c.user_id` lets SQLite
 * drive `messages` by idx_messages_user_sent (user_id=?): every text the user
 * has, read once per thread link. Writing the user term with a unary plus
 * (`+m.user_id`) keeps the filter and takes that index off the table, so the
 * planner uses idx_messages_thread_id / idx_messages_thread_sent. Same rows —
 * the plus is a planner hint, not a semantic change (BACKLOG-3785 idiom).
 *
 * Two parts, each run in BOTH production planner states (BACKLOG-3163 SR D4):
 * no sqlite_stat1 (the normal state) and after ANALYZE (what Settings →
 * "Optimize database" leaves behind, maintenanceDbService.ts).
 *
 * 1. Plan: EXPLAIN QUERY PLAN for each site's real SQL must not search the
 *    thread-joined table by user_id, and must search it by thread.
 * 2. Oracle: each site returns the same rows with the plus removed (the SQL
 *    as it was), on a fixture with two users sharing threads, removed and
 *    hidden texts and several links. Non-vacuity: dropping the user term
 *    altogether changes the result for every site, so equality is not free.
 */
import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { ALL_TEXT_IDS } from "../../__tests__/helpers/selectedTextIds";

let realDb: TestDb | null = null;
type Variant = "shipped" | "oldSql" | "noUserFilter";
let variant: Variant = "shipped";

/** The SQL as it was before BACKLOG-3163 / 3785: no unary plus on a user_id. */
const toOldSql = (s: string): string => s.replace(/\+(\w+)\.user_id/g, "$1.user_id");
/** Drop the thread arm's user scope entirely (non-vacuity control). */
const toNoUserFilter = (s: string): string =>
  s.replace(
    /(\w+)\.thread_id = (\w+)\.thread_id(\s+)AND \+?(\w+)\.user_id = \+?(\w+)\.user_id/g,
    (whole, a: string, b: string, ws: string) =>
      // thread-NAME joins (tn) are keyed by user too, but they are not thread links.
      a === "tn" || b === "tn" ? whole : `${a}.thread_id = ${b}.thread_id${ws}AND 1 = 1`,
  );
const fix = (s: string): string =>
  variant === "shipped" ? s : variant === "oldSql" ? toOldSql(s) : toNoUserFilter(s);

const prepared: string[] = [];
const recording = {
  prepare(s: string) {
    prepared.push(s);
    return realDb!.prepare(fix(s));
  },
  exec: (s: string) => realDb!.exec(s),
  transaction: <T,>(fn: () => T) => realDb!.transaction(fn),
};
jest.mock("../core/dbConnection", () => ({
  ensureDb: () => recording,
  dbAll: (s: string, p: unknown[] = []) => recording.prepare(s).all(...(p as never[])),
  dbGet: (s: string, p: unknown[] = []) => recording.prepare(s).get(...(p as never[])),
  dbRun: (s: string, p: unknown[] = []) => recording.prepare(s).run(...(p as never[])),
  dbTransaction: <T,>(fn: () => T): T => recording.transaction(fn)(),
  dbExec: (s: string) => recording.exec(s),
  getDbPath: () => "/fake",
  getEncryptionKey: () => "k",
}));
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { getTransactionMessages } from "../submissionDbService";
import {
  buildTextQuery,
  buildTextThreadNameQuery,
  buildThreadNameAttributionQuery,
  buildGlobalTextQuery,
  buildGlobalTextThreadNameQuery,
  buildUnattachedTextThreadNameQuery,
  buildUnattachedTextQuery,
} from "../transactionSearchDbService";
import { prepareTextAttachmentCount } from "../attachmentAuditStatsSql";
import { GET_CHECKLIST_LINK_MEMBERS_SQL, targetsInTransactionSql } from "../checklistSql";
import { HIDE_TEXT_FROM_EXPORT_SQL } from "../hiddenTextSql";
import { REMOVED_MESSAGES_SQL } from "../removedCommunicationSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");

// ---------------------------------------------------------------------------
// Fixture: two users who both hold copies of the same provider threads.
// ---------------------------------------------------------------------------
const TX = "tx0";
const THREADS = 20;
/** Group-chat participants: the thread-NAME searches only match group threads. */
const GROUP = JSON.stringify({ from: "+15550001", to: ["+15550002", "+15550003"], chat_members: ["+15550002", "+15550003"] });
function seed(db: TestDb): void {
  db.exec(readFileSync(SCHEMA, "utf8"));
  for (const u of ["u1", "u2"]) {
    db.prepare(`INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,?,?)`).run(u, `${u}@x.test`, "google", u);
  }
  const insT = db.prepare(`INSERT INTO transactions (id,user_id,property_address) VALUES (?,?,?)`);
  for (let t = 0; t < 4; t++) insT.run(`tx${t}`, "u1", `${t} Test St`);
  const insM = db.prepare(
    `INSERT INTO messages (id,user_id,channel,direction,thread_id,sent_at,body_text,participants_flat,external_id,participants)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const insC = db.prepare(
    `INSERT INTO communications (id,user_id,transaction_id,message_id,thread_id,link_source) VALUES (?,?,?,?,?,?)`,
  );
  const insA = db.prepare(
    `INSERT INTO attachments (id,message_id,filename,storage_path,file_size_bytes,external_message_id) VALUES (?,?,?,?,?,?)`,
  );
  // Filler: many unlinked texts per user, so a by-user search is visibly wide.
  for (let i = 0; i < 4000; i++) {
    insM.run(`f${i}`, i % 2 ? "u1" : "u2", i % 3 ? "imessage" : "sms", "inbound", `ft${i % 200}`,
      // Distinct times, as real texts have: the PC-scale generator's spacing
      // (stall-audit gen.js). With repeated times ANALYZE makes sent_at look
      // unselective and the after-ANALYZE plans stop resembling production.
      new Date(Date.UTC(2026, 0, 1) + (i % 300) * 86400000 + i * 1000).toISOString(), `filler hello ${i}`, `555000${i % 97}`, `fx${i}`,
      i % 200 < 40 ? GROUP : null);
  }
  // Linked threads: both users hold a copy of every message.
  for (let t = 0; t < THREADS; t++) {
    const th = `th${t}`;
    for (let k = 0; k < 10; k++) {
      const sent = `2026-0${1 + (k % 6)}-0${1 + (t % 9)}T12:00:00.000Z`;
      for (const u of ["u1", "u2"]) {
        const id = `m${t}_${k}_${u}`;
        insM.run(id, u, k % 2 ? "sms" : "imessage", k % 2 ? "outbound" : "inbound", th, sent,
          `deal hello ${t}-${k}`, `5551${t}`, `e${t}_${k}`, GROUP);
        if (k % 3 === 0) insA.run(`a${t}_${k}_${u}`, id, `f${k}.jpg`, `/p/${id}`, 100 + k, null);
      }
    }
    // A text only one user has in this chat: the user scope decides whether it shows.
    insM.run(`only_${t}`, t % 2 ? "u1" : "u2", "imessage", "inbound", th,
      `2026-07-0${1 + (t % 9)}T09:00:00.000Z`, `only-other-user hello ${t}`, `5551${t}`, `oe${t}`, GROUP);
    insA.run(`aonly_${t}`, `only_${t}`, "only.jpg", `/p/only_${t}`, 7, null);
    // Thread link made by u1 (t even) or u2 (t odd), spread across the deals.
    insC.run(`c_th${t}`, t % 2 ? "u2" : "u1", `tx${t % 4}`, null, th, t % 3 ? "manual" : "auto");
  }
  // Direct message links.
  for (let k = 0; k < 10; k += 2) insC.run(`c_m${k}`, "u1", TX, `m${k}_${k}_u1`, null, "manual");
  // Removed texts: whole threads removed by each user, plus single texts.
  const insI = db.prepare(
    `INSERT INTO ignored_communications (id,user_id,transaction_id,thread_id,original_communication_id,reason,ignored_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let t = 0; t < 6; t++) insI.run(`ic_th${t}`, t % 2 ? "u2" : "u1", TX, `th${t + 10}`, null, "removed", `2026-08-0${1 + t}`);
  for (let k = 0; k < 4; k++) insI.run(`ic_m${k}`, "u1", TX, null, `f${k * 2 + 1}`, "removed", `2026-08-1${k}`);
  // Thread names for both users.
  const insN = db.prepare(`INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES (?,?,?)`);
  for (let t = 0; t < THREADS; t++) for (const u of ["u1", "u2"]) insN.run(u, `th${t}`, `Deal hello group ${t} ${u}`);
  for (let f = 0; f < 40; f++) for (const u of ["u1", "u2"]) insN.run(u, `ft${f}`, `Filler hello group ${f}`);
  // Hidden texts.
  db.prepare(`INSERT INTO transaction_hidden_texts (transaction_id,message_id,message_external_id,hidden_by) VALUES (?,?,?,?)`)
    .run(TX, "m0_1_u1", "e0_1", "u1");
  // Checklist: one link with attachment members across both users' copies.
  db.prepare(`INSERT INTO transaction_checklists (id,transaction_id,template_id,template_name) VALUES ('cl0',?, 'tpl','T')`).run(TX);
  db.prepare(`INSERT INTO transaction_checklist_items (id,checklist_id,title) VALUES ('i0','cl0','Item')`).run();
  db.prepare(`INSERT INTO transaction_checklist_links (id,item_id,kind,label) VALUES ('l0','i0','attachment','L')`).run();
  const insMem = db.prepare(`INSERT INTO transaction_checklist_link_members (id,link_id,kind,attachment_id) VALUES (?,?,?,?)`);
  let n = 0;
  for (let t = 0; t < THREADS; t += 4) {
    for (const u of ["u1", "u2"]) insMem.run(`mem${n++}`, "l0", "attachment", `a${t}_0_${u}`);
    insMem.run(`mem${n++}`, "l0", "attachment", `aonly_${t}`);
  }
}

// ---------------------------------------------------------------------------
// The sites. `table` is the alias of the side the thread term joins INTO; that
// alias must be searched by thread. `run` executes the site's SQL as shipped
// (or as the variant) and returns a comparable result.
// ---------------------------------------------------------------------------
interface Site {
  name: string;
  alias: string;
  /** Thread index the alias must be searched by — only where the thread term drives it. */
  threadIndex?: RegExp;
  sql: () => string;
  run: () => unknown;
}
const MSG_THREAD = /idx_messages_thread_(id|sent) \(thread_id=/;
const COMM_THREAD = /idx_(comm_thread_txn|communications_thread_id) \(thread_id=/;
const all = (s: string, p: unknown[]) => realDb!.prepare(fix(s)).all(...(p as never[]));
const ATTACH_IDS = (): string[] => {
  const ids: string[] = [];
  for (let t = 0; t < THREADS; t++) for (const u of ["u1", "u2"]) ids.push(`a${t}_0_${u}`, `a${t}_3_${u}`);
  for (let t = 0; t < THREADS; t++) ids.push(`aonly_${t}`);
  return ids;
};
function captureSubmissionSql(): string {
  prepared.length = 0;
  getTransactionMessages(TX, null, null, ALL_TEXT_IDS);
  const s = prepared.find((x) => /c\.thread_id = m\.thread_id/.test(x));
  if (!s) throw new Error("submission SQL not captured");
  return s;
}

const SITES: Site[] = [
  {
    name: "submissionDbService getTransactionMessages",
    alias: "m",
    threadIndex: MSG_THREAD,
    sql: captureSubmissionSql,
    run: () => getTransactionMessages(TX, new Date("2026-01-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"), ALL_TEXT_IDS).map((m) => m.id),
  },
  {
    name: "transactionSearch buildTextQuery (deal search)",
    alias: "m2",
    threadIndex: MSG_THREAD,
    sql: () => buildTextQuery(TX, "hello", 500).sql,
    run: () => { const q = buildTextQuery(TX, "hello", 500); return all(q.sql, q.params); },
  },
  {
    name: "transactionSearch buildTextThreadNameQuery (deal search)",
    alias: "m2",
    threadIndex: MSG_THREAD,
    sql: () => buildTextThreadNameQuery(TX, "hello").sql,
    run: () => { const q = buildTextThreadNameQuery(TX, "hello"); return all(q.sql, q.params); },
  },
  {
    name: "transactionSearch buildThreadNameAttributionQuery",
    alias: "comm3",
    threadIndex: COMM_THREAD,
    sql: () => buildThreadNameAttributionQuery("m1_1_u2").sql,
    run: () => {
      const out: unknown[] = [];
      for (let t = 0; t < THREADS; t++) for (const u of ["u1", "u2"]) {
        const q = buildThreadNameAttributionQuery(`m${t}_1_${u}`);
        out.push(all(q.sql, q.params));
      }
      return out;
    },
  },
  {
    name: "transactionSearch buildGlobalTextQuery (global search)",
    alias: "m3",
    threadIndex: MSG_THREAD,
    sql: () => buildGlobalTextQuery("u1", "hello", 5000).sql,
    run: () => ["u1", "u2"].map((u) => { const q = buildGlobalTextQuery(u, "hello", 5000); return all(q.sql, q.params); }),
  },
  {
    name: "transactionSearch buildGlobalTextThreadNameQuery (look-alike)",
    alias: "comm3",
    threadIndex: COMM_THREAD,
    sql: () => buildGlobalTextThreadNameQuery("u1", "hello").sql,
    run: () => ["u1", "u2"].map((u) => { const q = buildGlobalTextThreadNameQuery(u, "hello"); return all(q.sql, q.params); }),
  },
  {
    name: "transactionSearch buildUnattachedTextThreadNameQuery (look-alike)",
    alias: "comm3",
    threadIndex: COMM_THREAD,
    sql: () => buildUnattachedTextThreadNameQuery("u1", "hello").sql,
    run: () => ["u1", "u2"].map((u) => { const q = buildUnattachedTextThreadNameQuery(u, "hello"); return all(q.sql, q.params); }),
  },
  {
    name: "transactionSearch buildUnattachedTextQuery (look-alike)",
    alias: "comm3",
    threadIndex: COMM_THREAD,
    sql: () => buildUnattachedTextQuery("u1", "hello", 5000).sql,
    run: () => ["u1", "u2"].map((u) => { const q = buildUnattachedTextQuery(u, "hello", 5000); return all(q.sql, q.params); }),
  },
  {
    name: "attachmentAuditStatsSql text attachment count",
    alias: "m",
    threadIndex: MSG_THREAD,
    sql: () => { let t = ""; prepareTextAttachmentCount({ prepare: (x: string) => { t = x; return null as never; } } as never, { hasStart: true, hasEnd: true }); return t; },
    run: () => {
      const db = { prepare: (x: string) => realDb!.prepare(fix(x)) };
      return [0, 1, 2, 3].map((t) =>
        (prepareTextAttachmentCount(db as never, { hasStart: true, hasEnd: true }) as unknown as { get: (...a: unknown[]) => unknown })
          .get(`tx${t}`, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"));
    },
  },
  {
    name: "checklistSql GET_CHECKLIST_LINK_MEMBERS_SQL",
    // messages found by the attachment's id / external_id, never by thread or user
    alias: "msg",
    sql: () => GET_CHECKLIST_LINK_MEMBERS_SQL,
    run: () => all(GET_CHECKLIST_LINK_MEMBERS_SQL, ["cl0", "cl0"]),
  },
  {
    name: "checklistSql targetsInTransactionSql(attachment)",
    // messages found by the attachment's id / external_id, never by thread or user
    alias: "m",
    sql: () => targetsInTransactionSql("attachment", 3),
    run: () => {
      const ids = ATTACH_IDS();
      return [0, 1, 2, 3].map((t) => all(targetsInTransactionSql("attachment", ids.length), [...ids, `tx${t}`, `tx${t}`]));
    },
  },
  {
    name: "hiddenTextSql HIDE_TEXT_FROM_EXPORT_SQL",
    alias: "c",
    threadIndex: COMM_THREAD,
    sql: () => HIDE_TEXT_FROM_EXPORT_SQL,
    run: () => {
      const out: number[] = [];
      realDb!.exec("SAVEPOINT hide_oracle");
      try {
        for (let t = 0; t < THREADS; t++) for (const u of ["u1", "u2"]) for (const tx of ["tx0", "tx1"]) {
          out.push(realDb!.prepare(fix(HIDE_TEXT_FROM_EXPORT_SQL)).run("u1", `m${t}_2_${u}`, tx).changes);
        }
        for (let t = 0; t < THREADS; t++) out.push(realDb!.prepare(fix(HIDE_TEXT_FROM_EXPORT_SQL)).run("u1", `only_${t}`, `tx${t % 4}`).changes);
      } finally {
        realDb!.exec("ROLLBACK TO hide_oracle");
        realDb!.exec("RELEASE hide_oracle");
      }
      return out;
    },
  },
  {
    name: "removedCommunicationSql REMOVED_MESSAGES_SQL",
    alias: "m",
    threadIndex: MSG_THREAD,
    sql: () => REMOVED_MESSAGES_SQL,
    run: () => all(REMOVED_MESSAGES_SQL, [TX]),
  },
];

function explain(sqlText: string): string[] {
  // `?` also appears in SQL comments; find the bound-parameter count by asking the engine.
  const stmt = realDb!.prepare(`EXPLAIN QUERY PLAN ${sqlText}`);
  for (let n = (sqlText.match(/\?/g) ?? []).length; n >= 0; n--) {
    try {
      return (stmt.all(...new Array(n).fill("x")) as Array<{ detail: string }>).map((r) => r.detail);
    } catch {
      /* wrong parameter count — try one fewer */
    }
  }
  throw new Error("could not EXPLAIN the statement");
}

const userSearchOn = (alias: string) => new RegExp(`^SEARCH ${alias} USING (COVERING )?INDEX \\S+ \\(user_id=`);
const threadSearchOn = (alias: string, idx: RegExp) =>
  (d: string) => new RegExp(`^SEARCH ${alias} USING (COVERING )?INDEX `).test(d) && idx.test(d);

describe.each([
  ["no sqlite_stat1", false],
  ["after ANALYZE (sqlite_stat1 present)", true],
])("thread-link join sites — %s (BACKLOG-3163)", (_label, analyze) => {
  beforeAll(() => {
    realDb = openTestDb();
    seed(realDb);
    if (analyze) realDb.exec("ANALYZE");
  });
  afterAll(() => {
    realDb?.close();
    realDb = null;
  });
  beforeEach(() => {
    variant = "shipped";
  });

  it("the planner-statistics state is the one this block claims", () => {
    const n = (realDb!.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get() as { n: number }).n;
    expect(n).toBe(analyze ? 1 : 0);
  });

  it.each(SITES.map((s) => [s.name, s] as const))("%s: plan searches by thread, never by user", (_n, site) => {
    const plan = explain(site.sql());
    expect(plan.filter((d) => userSearchOn(site.alias).test(d))).toEqual([]);
    if (site.threadIndex) expect(plan.some(threadSearchOn(site.alias, site.threadIndex))).toBe(true);
  });

  it.each(SITES.map((s) => [s.name, s] as const))("%s: same result as the SQL without the plus", (_n, site) => {
    variant = "shipped";
    const shipped = site.run();
    variant = "oldSql";
    const old = site.run();
    variant = "shipped";
    expect(JSON.stringify(shipped).length).toBeGreaterThan(2);
    expect(shipped).toEqual(old);
  });

  it.each(SITES.map((s) => [s.name, s] as const))("%s: dropping the user term changes the result (non-vacuity)", (_n, site) => {
    variant = "noUserFilter";
    const loose = site.run();
    variant = "shipped";
    expect(loose).not.toEqual(site.run());
  });
});
