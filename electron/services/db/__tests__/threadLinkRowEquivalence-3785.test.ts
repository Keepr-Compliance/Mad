/**
 * @jest-environment node
 */
/**
 * BACKLOG-3785: the thread-link join was rewritten from `m.user_id = c.user_id` to
 * `+m.user_id = c.user_id` (a planner hint, not a semantic change). This pins that
 * the two SQL texts return identical rows, in identical order, for
 * getCommunicationsWithMessages and getTransactionAllAttachments — with and without
 * sqlite_stat1, with audit-date windows, including content-duplicate ties and a
 * second user's messages in the same threads.
 *
 * Control: a third SQL text with the user filter DROPPED must differ (u2's copies
 * leak into u1's thread links), so equality above cannot be vacuous.
 */
import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let realDb: TestDb | null = null;
type Variant = "shipped" | "oldSql" | "noUserFilter";
let variant: Variant = "shipped";
let rewrites = 0;
const fix = (s: string) => {
  if (variant === "shipped") return s;
  if (s.includes("+m.user_id")) rewrites++;
  if (variant === "oldSql") return s.split("+m.user_id").join("m.user_id");
  return s.replace(/AND \+m\.user_id = c\.user_id/g, "AND 1 = 1");
};
const recording = {
  prepare: (s: string) => realDb!.prepare(fix(s)),
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
  getDbPath: () => "/fake", getEncryptionKey: () => "k",
}));
jest.mock("../../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
import { getCommunicationsWithMessages } from "../communicationDbService";
import { getTransactionAllAttachments } from "../attachmentDbService";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const T = "tx1";
function seed(db: TestDb) {
  db.exec(readFileSync(SCHEMA, "utf8"));
  for (const u of ["u1", "u2"]) db.prepare(`INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,?,?)`).run(u, u + "@x.test", "google", u);
  db.prepare(`INSERT INTO transactions (id,user_id,property_address) VALUES (?,?,?)`).run(T, "u1", "1 Test St");
  const insM = db.prepare(`INSERT INTO messages (id,user_id,channel,direction,thread_id,sent_at,body_text,external_id) VALUES (?,?,?,?,?,?,?,?)`);
  const insC = db.prepare(`INSERT INTO communications (id,user_id,transaction_id,message_id,thread_id,link_source) VALUES (?,?,?,?,?,?)`);
  const insA = db.prepare(`INSERT INTO attachments (id,message_id,filename) VALUES (?,?,?)`);
  // filler so u1/u2 have many messages
  for (let i = 0; i < 3000; i++) insM.run(`f${i}`, i % 2 ? "u1" : "u2", "imessage", "inbound", `ft${i % 50}`, `2026-0${1 + (i % 9)}-1${i % 9}T10:00:00.000Z`, `filler ${i}`, `fx${i}`);
  // thread-linked threads, shared across users, with duplicate-content ties
  for (let t = 0; t < 8; t++) {
    const th = `th${t}`;
    for (let k = 0; k < 12; k++) {
      const sent = `2026-0${1 + (k % 6)}-0${1 + (t % 9)}T12:00:00.000Z`;
      for (const u of ["u1", "u2"]) {
        insM.run(`m${t}_${k}_${u}`, u, "imessage", k % 2 ? "outbound" : "inbound", th, sent, `body ${t}-${k % 4}`, `e${t}_${k}_${u}`);
        if (k % 3 === 0) insA.run(`a${t}_${k}_${u}`, `m${t}_${k}_${u}`, `f${k}.jpg`);
        // a second copy (dup content, same sent_at, different id) for u1
        if (u === "u1" && k % 4 === 0) insM.run(`d${t}_${k}`, "u1", "imessage", "inbound", th, sent, `body ${t}-${k % 4}`, `de${t}_${k}`);
      }
    }
    // thread link made by u1 (t even) or u2 (t odd)
    insC.run(`c_th${t}`, t % 2 ? "u2" : "u1", T, null, th, "manual");
  }
  // direct message links
  for (let k = 0; k < 12; k += 2) insC.run(`c_m${k}`, "u1", T, `m${k % 8}_${k}_u1`, null, "manual");
  for (let i = 0; i < 40; i++) insC.run(`c_f${i}`, "u1", T, `f${i * 7}`, null, "manual");
}
const windows: Array<[Date | null, Date | null]> = [
  [null, null],
  [new Date("2026-02-01T00:00:00Z"), null],
  [null, new Date("2026-04-01T00:00:00Z")],
  [new Date("2026-02-01T00:00:00Z"), new Date("2026-05-02T00:00:00Z")],
];
async function snapshot() {
  const texts = await getCommunicationsWithMessages(T, "text");
  const all = await getCommunicationsWithMessages(T);
  const atts = windows.map(([s, e]) => getTransactionAllAttachments(T, s, e));
  return { texts, all, atts };
}
async function under(v: Variant) {
  variant = v;
  rewrites = 0;
  try {
    return await snapshot();
  } finally {
    variant = "shipped";
  }
}
for (const stats of [false, true]) {
  describe(`stats=${stats}`, () => {
    beforeAll(() => { realDb = openTestDb(); seed(realDb); if (stats) realDb.exec("ANALYZE"); });
    afterAll(() => realDb?.close());
    it("old vs new SQL identical (order + ids + every column)", async () => {
      const fresh = await under("shipped");
      const old = await under("oldSql");
      expect(rewrites).toBeGreaterThan(0);
      expect(fresh.texts.length).toBeGreaterThan(20);
      expect(fresh.atts[0].length).toBeGreaterThan(5);
      // window actually narrows
      expect(fresh.atts[3].length).toBeLessThan(fresh.atts[0].length);
      // u2's copies never leak into a u1 thread link
      expect(fresh.texts.some((r: any) => String(r.id).startsWith("m0_") && String(r.id).endsWith("_u2"))).toBe(false);
      expect(old).toEqual(fresh);
    });
    it("control: dropping the user filter changes the rows", async () => {
      const fresh = await under("shipped");
      const dropped = await under("noUserFilter");
      expect(rewrites).toBeGreaterThan(0);
      expect(dropped).not.toEqual(fresh);
    });
  });
}
