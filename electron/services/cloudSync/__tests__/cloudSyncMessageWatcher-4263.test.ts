/**
 * @jest-environment node
 *
 * BACKLOG-4263 P5: the P0 watcher also watches deal marks (cloud_sync_dirty.marked_at) and asks for a pass after one
 * that used up its email and text budget with work left. Fake clock, real schema and triggers.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, enableUser, freshDb, insertDeal, PROJECT, USER_A } from "./helpers/fixtures";
import { TodoOutboxWatcher } from "../todoOutboxWatcher";
import type { PassSummary } from "../runner";
import { addEmail, fz, linkEmail, unlink } from "./helpers/messageFixtures";

function rig() {
  const db: TestDb = freshDb();
  enableUser(db);
  const deal = dealId();
  insertDeal(db, deal);
  addEmail(db, fz(1, 1));
  linkEmail(db, fz(2, 1), deal, fz(1, 1));
  db.prepare("DELETE FROM cloud_sync_dirty").run();
  const clock = { t: Date.parse("2026-11-14T12:00:00.000Z") };
  let kicks = 0;
  const w = new TodoOutboxWatcher({
    db: () => db,
    dbReady: () => true,
    projectRef: PROJECT,
    isOnline: () => true,
    getAuthUserId: () => USER_A,
    passRunning: () => false,
    kick: () => void kicks++,
    setInterval: () => 1,
    clearInterval: () => undefined,
    now: () => new Date(clock.t),
  });
  const done = (extra: Partial<PassSummary> = {}): PassSummary => ({ outcome: "done", done: 0, failed: 0, ...extra });
  const passCycle = (extra: Partial<PassSummary> = {}) => {
    w.passStarting();
    w.passEnded(done(extra));
  };
  const look = (ms: number) => {
    clock.t += ms;
    w.tick();
  };
  return { db, deal, w, passCycle, look, kicks: () => kicks };
}

describe(`Keepr Cloud watcher: deal marks and continuation [${DRIVER}]`, () => {
  it("C-5g: an unlink (a new deal mark) asks for a pass within 15 s", () => {
    const r = rig();
    r.passCycle();
    // marked_at has one-second resolution: the mark lands in a later second than the pass start's top
    r.db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) VALUES ('seed', 1, '2026-11-14 11:59:00')").run();
    r.passCycle();
    unlink(r.db, fz(2, 1));
    r.db.prepare("UPDATE cloud_sync_dirty SET marked_at = '2026-11-14 12:00:09' WHERE transaction_id = ?").run(r.deal);
    r.look(5_000);
    expect(r.kicks()).toBe(0);
    r.look(5_000);
    expect(r.kicks()).toBe(1);
  });

  it("W-x: the pass's own clears never ask for a pass", () => {
    const r = rig();
    r.db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) VALUES (?, 1, '2026-11-14 11:59:00')").run(r.deal);
    r.passCycle();
    r.db.prepare("DELETE FROM cloud_sync_dirty").run();
    for (let i = 0; i < 12; i++) r.look(5_000);
    expect(r.kicks()).toBe(0);
  });

  it("P-k1: a pass that drained its work makes no continuation request", () => {
    const r = rig();
    r.passCycle({ budgetExhausted: false });
    for (let i = 0; i < 12; i++) r.look(5_000);
    expect(r.kicks()).toBe(0);
  });

  it("P-k2: a pass that used up its budget with work left asks for exactly one pass, after the 10 s floor", () => {
    const r = rig();
    r.passCycle({ budgetExhausted: true });
    r.look(5_000);
    expect(r.kicks()).toBe(0);
    r.look(5_000);
    expect(r.kicks()).toBe(1);
    r.passCycle({ budgetExhausted: false });
    for (let i = 0; i < 12; i++) r.look(5_000);
    expect(r.kicks()).toBe(1);
  });

  it("W-y: over five minutes, passes that mark (reconcile, adopt) and clear stay bounded: at most one follow-up each", () => {
    const r = rig();
    let passes = 0;
    let second = 0;
    const runOne = (marks: boolean) => {
      passes++;
      r.w.passStarting();
      if (marks) {
        second++;
        r.db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) VALUES (?, 1, ?) ON CONFLICT (transaction_id) DO UPDATE SET marked_at = excluded.marked_at").run(`m${second}`, `2026-11-14 12:${String(10 + second).padStart(2, "0")}:00`);
      }
      r.w.passEnded({ outcome: "done", done: 0, failed: 0 });
    };
    runOne(true);
    const before = r.kicks();
    for (let i = 0; i < 60; i++) {
      r.look(5_000);
      if (r.kicks() > before + passes) break;
      if (r.kicks() > passes - 1) runOne(false);
    }
    expect(r.kicks()).toBeLessThanOrEqual(1);
  });
});
