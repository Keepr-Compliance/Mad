/**
 * BACKLOG-4263 P0: the todo outbox watcher (plan §11.8, todo part only).
 *
 * TRACE: every checklist write the user can make, run with its real statement against the real schema and
 * capture triggers: does it queue a `cloud_sync_todo_outbox` row, and with which time columns.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, USER_A, USER_B } from "./helpers/fixtures";
import { makeEngine, startAndPass, pass, type Engine } from "./helpers/engine";
import { FakeServer } from "./helpers/fakeServer";
import { TodoOutboxWatcher } from "../todoOutboxWatcher";
import { OUTBOX_TOP_SQL } from "../../db/cloudSyncTodoSql";
import type { PassOutcome } from "../runner";
import type { JsonValue } from "../jcs";
import { enableForUser } from "../../db/cloudSyncDbService";
import { CloudTodoScreens } from "../todoScreens";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  DELETE_CHECKLIST_IN_TRANSACTION_SQL,
  DELETE_PRIVATE_ITEM_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_LINK_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  RENAME_PRIVATE_ITEM_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_DUE_DATE_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  SET_ITEM_SORT_ORDER_SQL,
} from "../../db/checklistSql";

type Row = Record<string, unknown>;
const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const INSTALL = fid(98, 4263);
const CL = fid(3, 1);
const MY = fid(3, 2);
const I1 = fid(4, 1);
const I2 = fid(4, 2);

const outbox = (db: TestDb) =>
  db.prepare("SELECT entity, local_id, part, edited_at, edit_seq FROM cloud_sync_todo_outbox ORDER BY local_id, part").all() as Row[];

function profile(enable = true): { db: TestDb; deal: string } {
  const db = freshDb();
  db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, NULL, '2026-11-01T00:00:00.000Z')").run(PROJECT, INSTALL);
  const deal = dealId();
  insertDeal(db, deal, USER_A);
  db.prepare(INSERT_CHECKLIST_SQL).run(CL, deal, "tpl-1", "Purchase", 0);
  db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(MY, deal, MY_ITEMS_TEMPLATE_ID, "My items", 1);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I1, CL, "Inspection", null, 1, "inspection", 0);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I2, MY, "Call lender", null, 0, null, 0);
  if (enable) enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
  return { db, deal };
}

/** The rows one write queued: the outbox is emptied first, so only this write's rows are left. */
function queuedBy(db: TestDb, write: () => void): Row[] {
  db.prepare("DELETE FROM cloud_sync_todo_outbox").run();
  write();
  return outbox(db);
}

/** The design's numbers, written out (not imported) so a changed constant cannot move the expectations with it. */
const LOOK_MS = 5_000;
const GAP_MS = 10_000;

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe(`Keepr Cloud todo watcher [${DRIVER}]`, () => {
  describe("TRACE: which checklist writes queue an outbox row", () => {
    const cases: Array<{ name: string; write: (db: TestDb, deal: string) => void; parts: string[] }> = [
      { name: "tick", write: (db) => db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I1), parts: ["item:done"] },
      { name: "untick", write: (db) => {
        db.prepare("UPDATE transaction_checklist_items SET is_checked = 1, checked_at = '2026-11-01 00:00:00' WHERE id = ?").run(I1);
        db.prepare("DELETE FROM cloud_sync_todo_outbox").run();
        db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(0, 0, I1);
      }, parts: ["item:done"] },
      { name: "note", write: (db) => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("call back", I1), parts: ["item:note"] },
      { name: "name (My item rename)", write: (db, deal) => db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Call the lender", I2, deal, MY_ITEMS_TEMPLATE_ID), parts: ["item:title"] },
      { name: "due date", write: (db) => db.prepare(SET_CHECKLIST_ITEM_DUE_DATE_SQL).run("2026-12-01", I1, "2026-12-01"), parts: ["item:due"] },
      { name: "add a My item", write: (db) => db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 9), MY, "New", null, 1, null, 1), parts: ["item:create"] },
      {
        name: "add a checklist (template, with one item)",
        write: (db, deal) => {
          db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 9), deal, "tpl-2", "Listing", 2);
          db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 8), fid(3, 9), "Photos", null, 1, null, 0);
        },
        parts: ["checklist:create", "item:create"],
      },
      { name: "remove a My item", write: (db, deal) => db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I2, deal, MY_ITEMS_TEMPLATE_ID), parts: ["item:removed"] },
      { name: "remove a checklist (its items go by cascade, one op)", write: (db, deal) => db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL, deal), parts: ["checklist:removed"] },
      { name: "reorder My items", write: (db) => db.prepare(SET_ITEM_SORT_ORDER_SQL).run(5, I2, MY), parts: ["item:order"] },
    ];
    for (const c of cases) {
      it(`${c.name}: queues ${c.parts.join(" + ")} with edited_at (ms) and edit_seq set`, () => {
        const { db, deal } = profile();
        const rows = queuedBy(db, () => c.write(db, deal));
        expect(rows.map((r) => `${r.entity}:${r.part}`).sort()).toEqual([...c.parts].sort());
        for (const r of rows) {
          expect(r.edited_at).toMatch(ISO_MS);
          expect(typeof r.edit_seq).toBe("number");
        }
      });
    }

    it("a re-edit of a part still waiting moves both edited_at and edit_seq on the same row", () => {
      const { db } = profile();
      const first = queuedBy(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("a", I1))[0];
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("b", I1);
      const second = outbox(db);
      expect(second).toHaveLength(1);
      expect(second[0].edit_seq as number).toBeGreaterThan(first.edit_seq as number);
      expect(String(second[0].edited_at) >= String(first.edited_at)).toBe(true);
    });

    it("queues nothing: evidence links (no capture trigger on the link tables), a Cloud-off owner", () => {
      const { db } = profile();
      const targets = (db.prepare("SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%INSERT INTO cloud_sync_todo_outbox%' ORDER BY tbl_name").all() as Row[]).map((r) => r.tbl_name);
      expect(targets).toEqual(["transaction_checklist_items", "transaction_checklists"]);
      expect(queuedBy(db, () => db.prepare(INSERT_CHECKLIST_LINK_SQL).run(fid(5, 1), I1, "attachment", "doc.pdf", 0, 0))).toEqual([]);
      const off = profile(false);
      expect(queuedBy(off.db, () => off.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", I1))).toEqual([]);
    });

    it("queues nothing: restore from Recently removed (server first, then the pull writes under the apply guard)", async () => {
      const { db, deal } = profile();
      const e = makeEngine(db);
      Object.defineProperty(e.clock, "now", { get: () => new Date(), set: () => undefined, configurable: true });
      e.server.serverNow = () => Date.now();
      await startAndPass(e);
      const s = new CloudTodoScreens({
        db: () => db,
        dbReady: () => true,
        client: e.client,
        projectRef: PROJECT,
        sessionUser: () => e.service.sessionUser(),
        localSessionUser: () => e.service.localSessionUser(),
        isOnline: () => e.online.value,
        installId: () => e.service.installIdForScreens(),
        archivedDealIds: async () => new Set((await e.service.listRemovedDeals()).map((d) => d.transactionId)),
        onlineDealLocalIds: () => e.service.onlineDealLocalIds(),
        kick: () => e.service.kick(),
      });
      db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I2, deal, MY_ITEMS_TEMPLATE_ID);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      const cloudId = e.server.todos.find((t) => t.entity === "item" && t.localId === I2)!.id;
      expect(await s.restoreTodo(deal, "item", cloudId)).toEqual({ success: true });
      expect(db.prepare("SELECT id FROM transaction_checklist_items WHERE id = ?").get(I2)).toBeTruthy();
      expect(outbox(db)).toEqual([]);
    });
  });

  // ================================================================ the watcher, on the engine with a fake clock
  //
  // The pass timer and the watcher's 5 s interval are the engine's injected timers; `advance` moves the fake
  // clock and fires the watcher at each 5 s boundary. No real wait anywhere.

  describe("W-6: an own todo edit is sent by a pass within 5-15 s", () => {
    it("edit at every second 0..19 s after the last pass start: one kick, at the first look >= max(edit, start + 10 s), and the edit is online", async () => {
      for (let d = 0; d < 20; d++) {
        const h = await setup();
        await h.advanceTo(h.t0 + d * 1000 + 200);
        const editAt = h.clock.t;
        h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`edit ${d}`, I1);
        await h.advanceTo(h.t0 + 60_000 - 1);
        const due = Math.max(editAt, h.t0 + GAP_MS);
        const expected = h.t0 + Math.ceil((due - h.t0) / LOOK_MS) * LOOK_MS;
        expect({ d, kicks: h.watchKicks() }).toEqual({ d, kicks: [expected] });
        expect(h.watchKicks()[0] - editAt).toBeLessThanOrEqual(15_000);
        expect(onlineNote(h.e, I1)).toBe(`edit ${d}`);
        expect(outbox(h.db)).toEqual([]);
      }
    });
  });

  describe("W-6 worst case: a pass started off the 5 s look grid (the 60 s timer, a restore, power resume)", () => {
    it("pass start at +20.1..24 s, edit right after it: kicked at the first look >= start + 10 s, at most 15 s after the edit", async () => {
      const delays: number[] = [];
      for (const off of [20_100, 21_000, 22_000, 23_000, 24_000, 24_900]) {
        const h = await setup();
        await h.advanceTo(h.t0 + off);
        h.fireTimer();
        await h.settle();
        expect(h.timerKicks()).toEqual([h.t0 + off]);
        h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`off ${off}`, I1);
        await h.advanceTo(h.t0 + 60_000 - 1);
        const expected = h.t0 + Math.ceil((off + GAP_MS) / LOOK_MS) * LOOK_MS;
        expect({ off, kicks: h.watchKicks() }).toEqual({ off, kicks: [expected] });
        delays.push(h.watchKicks()[0] - (h.t0 + off));
        expect(onlineNote(h.e, I1)).toBe(`off ${off}`);
      }
      expect(Math.max(...delays)).toBe(14_900);
    });
  });

  describe("BURST: ten edits in 3 s", () => {
    it("inside one 5 s window: one pass sends all ten", async () => {
      const h = await setup();
      await h.advanceTo(h.t0 + 20_000);
      const pushes = h.pushes();
      for (let i = 0; i < 10; i++) {
        await h.advanceTo(h.t0 + 20_100 + i * 300);
        h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`b${i}`, i % 2 === 0 ? I1 : I2);
      }
      await h.advanceTo(h.t0 + 80_000);
      expect(h.watchKicks()).toEqual([h.t0 + 25_000]);
      expect(h.pushes()).toBe(pushes + 1);
      expect([onlineNote(h.e, I1), onlineNote(h.e, I2)]).toEqual(["b8", "b9"]);
    });

    it("every phase against the 5 s look (0..4.5 s): at most two passes, at least 10 s apart, and every edit is online", async () => {
      for (let phase = 0; phase < 5000; phase += 500) {
        const h = await setup();
        const start = h.t0 + 20_000 + phase;
        for (let i = 0; i < 10; i++) {
          await h.advanceTo(start + i * 300);
          h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`p${phase}-${i}`, I1);
        }
        await h.advanceTo(h.t0 + 80_000);
        const k = h.watchKicks();
        expect({ phase, n: k.length <= 2 && k.length >= 1 }).toEqual({ phase, n: true });
        for (let i = 1; i < k.length; i++) expect(k[i] - k[i - 1]).toBeGreaterThanOrEqual(GAP_MS);
        expect(onlineNote(h.e, I1)).toBe(`p${phase}-9`);
      }
    });
  });

  describe("W-1: offline", () => {
    it("no kick while offline; the same edit is kicked on the first look after it is back online", async () => {
      const h = await setup();
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("offline edit", I1);
      h.e.online.value = false;
      await h.advanceTo(h.t0 + 30_000);
      expect(h.watchKicks()).toEqual([]);
      h.e.online.value = true;
      await h.advanceTo(h.t0 + 35_000);
      expect(h.watchKicks()).toEqual([h.t0 + 35_000]);
    });
  });

  describe("W-2: signed out, and the 5 s timer after sign-out", () => {
    it("no kick while the SDK has no user; kicked once it has one again", async () => {
      const h = await setup();
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("no user", I1);
      h.e.authUser.id = null;
      await h.advanceTo(h.t0 + 30_000);
      expect(h.watchKicks()).toEqual([]);
      h.e.authUser.id = USER_A;
      await h.advanceTo(h.t0 + 35_000);
      expect(h.watchKicks()).toEqual([h.t0 + 35_000]);
    });

    it("sign-out clears the 5 s timer and the schedule refresh that follows it does not start it again; sign-in starts it and an edit is kicked", async () => {
      const h = await setup();
      expect(h.activeWatchTimers()).toBe(1);
      h.e.session.userId = null;
      h.e.emit("cleared", null);
      expect(h.activeWatchTimers()).toBe(0); // cleared by the sign-out itself
      h.e.service.refreshSchedule(); // what main does on every session event (cloudSyncHandlers.ts onSessionChanged)
      expect(h.e.watchTimers.every((w) => w.cleared)).toBe(true);
      expect(h.activeWatchTimers()).toBe(0);
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("while signed out", I1);
      await h.advanceTo(h.t0 + 30_000);
      expect(h.watchKicks()).toEqual([]);
      h.e.session.userId = USER_A;
      h.e.emit("saved", USER_A);
      h.e.service.refreshSchedule();
      expect(h.activeWatchTimers()).toBe(1);
      h.fireTimer(); // the next 60 s pass (at +30 s): the watcher only kicks after a pass that ended done
      await h.settle();
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("signed in again", I1);
      await h.advanceTo(h.t0 + 45_000);
      expect(h.watchKicks()).toEqual([h.t0 + 40_000]);
    });

    it("a different user signing in gets no watcher kick before their own first pass ends done (sign-out forgets the last outcome and mark)", async () => {
      const h = await setup();
      // User B on this computer with Keepr Cloud on and one My item of their own.
      const dealB = dealId();
      insertDeal(h.db, dealB, USER_B);
      h.db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(fid(3, 7), dealB, MY_ITEMS_TEMPLATE_ID, "My items", 0);
      h.db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 7), fid(3, 7), "B's item", null, 1, null, 0);
      enableForUser(h.db, PROJECT, USER_B, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      h.db.prepare("DELETE FROM cloud_sync_todo_outbox WHERE owner_user_id = ?").run(USER_B);
      // A's pass ended done (setup). A signs out, B signs in.
      h.e.session.userId = null;
      h.e.authUser.id = null;
      h.e.emit("cleared", null);
      h.e.service.refreshSchedule();
      h.e.session.userId = USER_B;
      h.e.authUser.id = USER_B;
      h.e.server.tokenUser = USER_B;
      h.e.emit("saved", USER_B);
      h.e.service.refreshSchedule();
      expect(h.activeWatchTimers()).toBe(1);
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("B's note", fid(4, 7));
      expect(outbox(h.db).length).toBeGreaterThan(0);
      await h.advanceTo(h.t0 + 60_000);
      expect(h.watchKicks()).toEqual([]);
      // Positive twin: B's own pass (the 60 s timer) ends done; B's next edit is kicked by the watcher.
      h.fireTimer();
      await h.settle();
      expect(h.e.service.runner!.lastSummary!.outcome).toBe("done");
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("B's second note", fid(4, 7));
      await h.advanceTo(h.t0 + 75_000);
      expect(h.watchKicks()).toEqual([h.t0 + 70_000]);
    });

    it("listeners in the reverse order (refresh before the identity hears the event): the watcher only stays off; never on while signed out", async () => {
      const h = await setup();
      h.e.service.refreshSchedule(); // sign-out, reversed: the refresh runs first
      h.e.session.userId = null;
      h.e.emit("cleared", null);
      expect(h.activeWatchTimers()).toBe(0);
      h.e.session.userId = USER_A;
      h.e.service.refreshSchedule(); // sign-in, reversed: the refresh runs before the epoch moves
      h.e.emit("saved", USER_A);
      expect(h.activeWatchTimers()).toBe(0);
      h.e.service.refreshSchedule(); // the next refresh (any session event) starts it
      expect(h.activeWatchTimers()).toBe(1);
    });

    it("stop() clears the 5 s timer", async () => {
      const h = await setup();
      h.e.service.stop();
      expect(h.activeWatchTimers()).toBe(0);
    });
  });

  describe("OFF: the watcher runs only while Keepr Cloud is on here", () => {
    it("never turned on: no 5 s timer", () => {
      const { db } = profile(false);
      const e = makeEngine(db);
      e.service.refreshSchedule();
      expect(e.watchTimers).toEqual([]);
    });

    it("turned off here: the 5 s timer is cleared", async () => {
      const h = await setup();
      expect((await h.e.service.turnOff()).success).toBe(true);
      expect(h.activeWatchTimers()).toBe(0);
    });

    // Green today because a turn-off empties this user's outbox and the triggers queue nothing while enabled = 0;
    // the turn-off-owed check itself is not observed (dropping it stays green). Its control comes with the next PR.
    it("a turn-off owed (push of the turn-off failed): no kick, because the outbox is empty after a turn-off", async () => {
      const h = await setup();
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("before off", I1);
      h.e.server.override = (fn) => (fn === "set_my_cloud_autosave" ? new Error("network") : undefined);
      expect((await h.e.service.turnOff()).pendingOnline).toBe(true);
      expect(h.activeWatchTimers()).toBe(1);
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("after off", I1);
      await h.advanceTo(h.t0 + 60_000);
      expect(h.watchKicks()).toEqual([]);
    });
  });

  describe("W-3 / W-4: the last pass did not end done", () => {
    it("W-3 paused (the server's state is not entitled): no kick; after a pass that ends done, an edit is kicked", async () => {
      const h = await setup();
      h.e.server.reason = "zz_future_reason";
      h.fireTimer();
      await h.settle();
      expect(h.e.service.runner!.lastSummary!.outcome).toBe("paused");
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("while paused", I1);
      await h.advanceTo(h.t0 + 60_000);
      expect(h.watchKicks()).toEqual([]);
      h.e.server.reason = undefined;
      h.fireTimer();
      await h.settle();
      expect(h.e.service.runner!.lastSummary!.outcome).toBe("done");
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("resumed", I1);
      await h.advanceTo(h.t0 + 75_000);
      expect(h.watchKicks()).toEqual([h.t0 + 70_000]); // the timer's pass started at +60 s
    });

    it("W-4 refused today (install_removed: this computer's online copy was removed): no kick", async () => {
      const h = await setup();
      const install = (h.db.prepare("SELECT install_id FROM cloud_sync_install").get() as { install_id: string }).install_id;
      h.e.server.removedInstalls.add(`${USER_A}|${install}`);
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("refused", I1);
      h.fireTimer();
      await h.settle();
      expect(h.e.service.runner!.lastSummary!.outcome).toBe("install_removed");
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("refused again", I1);
      await h.advanceTo(h.t0 + 120_000);
      expect(h.watchKicks()).toEqual([]);
    });

    it("W-4 sweep: of every pass outcome that exists today, only done lets the watcher kick (a thrown pass does not)", () => {
      const expected: Record<PassOutcome, number> = {
        done: 1,
        queued: 0,
        idle: 0,
        signed_out: 0,
        identity_mismatch: 0,
        wrong_account: 0,
        needs_confirmation: 0,
        not_enabled: 0,
        paused: 0,
        offline: 0,
        other_project: 0,
        blocked: 0,
        unknown_state: 0,
        stopped: 0,
        install_removed: 0,
        // BACKLOG-4263 P2: a computer that is not the account's active one.
        other_computer: 0,
      };
      const got: Record<string, number> = {};
      for (const outcome of [...Object.keys(expected), "threw"] as Array<PassOutcome | "threw">) {
        const u = unit();
        u.w.passStarting();
        u.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`after ${outcome}`, I1);
        u.w.passEnded(outcome === "threw" ? null : { outcome, done: 0, failed: 0 });
        u.clock.t += GAP_MS;
        u.w.tick();
        got[outcome] = u.kicks.n;
      }
      expect(got).toEqual({ ...expected, threw: 0 });
    });
  });

  describe("W-5: back-off after failed passes (the todo push does not go through)", () => {
    it("with an edit after each failed pass: kicks 10 s, 20 s, 40 s after each failed pass start, then none; a pass that ends done resets it", async () => {
      const h = await setup();
      h.e.server.override = (fn) => (fn === "cloud_todo_push" ? new Error("network") : undefined);
      let n = 0;
      const editNow = () => h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`try ${n++}`, I1);
      editNow();
      // Each failed pass is followed at once by a fresh edit; look at every 5 s for 5 minutes.
      for (let t = h.t0 + 5_000; t <= h.t0 + 300_000; t += 5_000) {
        const before = h.watchKicks().length;
        await h.advanceTo(t);
        if (h.watchKicks().length > before) editNow();
      }
      // The edit's own kick at +10 s, then one kick 10 s, 20 s and 40 s after each of the three failed passes;
      // the fourth failed pass (at +80 s) is followed by none for the remaining 220 s.
      const k = h.watchKicks();
      expect(k.map((x) => x - h.t0)).toEqual([10_000, 20_000, 40_000, 80_000]);
      expect(k.slice(1).map((x, i) => x - k[i])).toEqual([10_000, 20_000, 40_000]);
      // The 60 s timer still runs a pass; once one ends done (push through again), the watcher kicks 10 s later.
      h.e.server.override = null;
      h.fireTimer();
      await h.settle();
      expect(h.e.service.runner!.lastSummary!.todos!.outcome).toBe("done");
      editNow();
      const at = h.clock.t;
      await h.advanceTo(at + 15_000);
      expect(h.watchKicks()).toHaveLength(5);
      expect(h.watchKicks()[4] - at).toBeLessThanOrEqual(15_000);
    });
  });

  describe("DURING: a pass running", () => {
    it("no kick while a pass runs; an edit made during it is kicked after it ends, not lost", async () => {
      const hold = holdingServer();
      const h = await setup(hold.server);
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("first", I1);
      const reached = hold.on();
      await h.advanceTo(h.t0 + 10_000, { idle: false }); // the watcher's kick starts a pass, which waits at its push
      await reached;
      expect(h.watchKicks()).toEqual([h.t0 + 10_000]);
      expect(h.e.service.runner!.isRunning()).toBe(true);
      h.db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Renamed during the pass", I2, h.deal, MY_ITEMS_TEMPLATE_ID);
      await h.advanceTo(h.t0 + 25_000, { idle: false });
      expect(h.watchKicks()).toEqual([h.t0 + 10_000]);
      hold.release();
      await h.settle();
      expect(onlineNote(h.e, I1)).toBe("first");
      expect(onlineTitle(h.e, I2)).toBe("Call lender");
      await h.advanceTo(h.t0 + 30_000);
      expect(h.watchKicks()).toEqual([h.t0 + 10_000, h.t0 + 30_000]);
      expect(onlineTitle(h.e, I2)).toBe("Renamed during the pass");
      expect(outbox(h.db)).toEqual([]);
    });
  });

  describe("STORM: rows that stay in the outbox ask once, not every 10 s", () => {
    it("every op answered not_found (kept and retried): one kick for the edit, none in the next 5 minutes", async () => {
      const h = await setup();
      h.e.server.override = (fn, args) =>
        fn === "cloud_todo_push"
          ? { data: { ok: true, results: (args.p_ops as Array<Record<string, JsonValue>>).map((op) => ({ op_id: op.op_id, entity: "item", status: "not_found" })) }, error: null, status: 200 }
          : undefined;
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("kept", I1);
      await h.advanceTo(h.t0 + 300_000);
      expect(h.watchKicks()).toEqual([h.t0 + 10_000]);
      expect(outbox(h.db)).toHaveLength(1);
    });

    it("a deal locked here (held op sent after the pull, answered not_found and kept): at most one follow-up kick in 5 minutes", async () => {
      const h = await setup();
      h.e.server.override = (fn, args) =>
        fn === "cloud_todo_push"
          ? { data: { ok: true, results: (args.p_ops as Array<Record<string, JsonValue>>).map((op) => ({ op_id: op.op_id, entity: "item", status: "not_found" })) }, error: null, status: 200 }
          : undefined;
      h.db.prepare("UPDATE transactions SET submission_status = 'submitted' WHERE id = ?").run(h.deal);
      h.e.server.aiSet(h.e.server.todos.find((t) => t.entity === "item" && t.localId === I1)!, "note", "ai during review");
      h.fireTimer();
      await h.settle();
      expect(h.e.service.runner!.lastSummary!.pull!.held).toBeGreaterThan(0);
      expect(outbox(h.db).length).toBeGreaterThan(0);
      await h.advanceTo(h.t0 + 300_000);
      expect(h.watchKicks().length).toBeLessThanOrEqual(1);
    });

    it("a full pull whose scan queues ops the server keeps answering not_found: at most one follow-up kick in 5 minutes", async () => {
      const h = await setup();
      // A local value the shadow does not know, written under the apply guard (no op), then a full pull owed:
      // the pass's scan queues the op itself (edited_at from the JS clock, edit_seq from the counter).
      h.db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, '2026-11-14T12:00:00.000Z')").run();
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("scan finds me", I1);
      h.db.prepare("DELETE FROM cloud_sync_applying").run();
      expect(outbox(h.db)).toEqual([]);
      h.db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1").run();
      h.e.server.override = (fn, args) =>
        fn === "cloud_todo_push"
          ? { data: { ok: true, results: (args.p_ops as Array<Record<string, JsonValue>>).map((op) => ({ op_id: op.op_id, entity: "item", status: "not_found" })) }, error: null, status: 200 }
          : undefined;
      h.fireTimer();
      await h.settle();
      expect(outbox(h.db).length).toBeGreaterThan(0);
      await h.advanceTo(h.t0 + 300_000);
      expect(h.watchKicks().length).toBeLessThanOrEqual(1);
    });
  });

  describe("W-7: no loop with the cloud-todos:changed event", () => {
    it("own edit -> kick -> the pass confirms it and fires the event -> the screen's reads -> no further kick in 2 minutes", async () => {
      const h = await setup();
      const s = screensOf(h.e, h.db);
      const base = h.e.todosChanged.count;
      let seen = base;
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("mine", I1);
      for (let t = h.t0 + 5_000; t <= h.t0 + 130_000; t += 5_000) {
        await h.advanceTo(t);
        while (seen < h.e.todosChanged.count) {
          seen++;
          // What the renderer asks on the event: the provider's forDeal, Recently removed, an open History.
          await s.forDeal(h.deal);
          await s.listRemovedTodos(h.deal);
          await s.history(I1);
          if (HANDLER_WRITES) h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`handler ${seen}`, I1);
        }
      }
      expect(h.e.todosChanged.count).toBe(base + 1);
      expect(h.watchKicks()).toEqual([h.t0 + 10_000]);
      expect(outbox(h.db)).toEqual([]);
    });
  });

  describe("WATCHER: reads only, and the database gate", () => {
    it("every statement the watcher prepares is a SELECT (a look that kicks, a look that does not, a pass start)", () => {
      const u = unit({ record: true });
      u.w.passStarting();
      u.w.passEnded({ outcome: "done", done: 0, failed: 0 });
      u.clock.t += GAP_MS;
      u.w.tick();
      u.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", I1);
      u.w.tick();
      expect(u.kicks.n).toBe(1);
      // BACKLOG-4263 P2 removed the look's settings read (see todoOutboxWatcher.ts): pass start, two outbox reads.
      expect(u.prepared.length).toBeGreaterThanOrEqual(3);
      for (const sql of u.prepared) expect(sql.trimStart().slice(0, 6).toUpperCase()).toBe("SELECT");
    });

    it("signed out: the look reads nothing and does not kick", () => {
      const u = unit({ record: true });
      u.w.passStarting();
      u.w.passEnded({ outcome: "done", done: 0, failed: 0 });
      u.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", I1);
      u.clock.t += GAP_MS;
      u.user.id = null;
      const n = u.prepared.length;
      u.w.tick();
      expect(u.prepared.length).toBe(n);
      expect(u.kicks.n).toBe(0);
      u.user.id = USER_A;
      u.w.tick();
      expect(u.kicks.n).toBe(1);
    });

    it("a row stamped before the wall clock stepped back does not hide a new edit (edit_seq still rises)", async () => {
      const h = await setup();
      h.e.server.override = (fn, args) =>
        fn === "cloud_todo_push"
          ? { data: { ok: true, results: (args.p_ops as Array<Record<string, JsonValue>>).map((op) => ({ op_id: op.op_id, entity: "item", status: "not_found" })) }, error: null, status: 200 }
          : undefined;
      h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("kept", I1);
      // The state a backward step leaves: the kept row carries a time the clock now reads as the future.
      h.db.prepare("UPDATE cloud_sync_todo_outbox SET edited_at = '2099-01-01T00:00:00.000Z'").run();
      await h.advanceTo(h.t0 + 30_000);
      expect(h.watchKicks()).toEqual([h.t0 + 10_000]);
      h.db.prepare(RENAME_PRIVATE_ITEM_SQL).run("After the step", I2, h.deal, MY_ITEMS_TEMPLATE_ID);
      await h.advanceTo(h.t0 + 35_000);
      expect(h.watchKicks()).toEqual([h.t0 + 10_000, h.t0 + 35_000]);
    });

    it("a thrown pass counts as a failed pass for the back-off: thrown, then done with a failure -> 20 s, not 10 s", () => {
      const u = unit();
      u.w.passStarting();
      u.w.passEnded(null);
      u.w.passStarting();
      u.w.passEnded({ outcome: "done", done: 0, failed: 1 });
      u.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("after a throw", I1);
      u.clock.t += 10_000;
      u.w.tick();
      expect(u.kicks.n).toBe(0);
      u.clock.t += 10_000;
      u.w.tick();
      expect(u.kicks.n).toBe(1);
    });

    it("database not ready: the look reads nothing and does not kick", () => {
      const u = unit({ record: true });
      u.w.passStarting();
      u.w.passEnded({ outcome: "done", done: 0, failed: 0 });
      u.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", I1);
      u.clock.t += GAP_MS;
      u.ready.v = false;
      const n = u.prepared.length;
      u.w.tick();
      expect(u.prepared.length).toBe(n);
      expect(u.kicks.n).toBe(0);
      u.ready.v = true;
      u.w.tick();
      expect(u.kicks.n).toBe(1);
    });

    it("the poll's read uses the outbox primary key (project_ref prefix)", () => {
      const { db } = profile();
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${OUTBOX_TOP_SQL}`).all(PROJECT) as Row[]).map((r) => String(r.detail));
      expect(plan.join(" | ")).toMatch(/SEARCH cloud_sync_todo_outbox USING (COVERING )?INDEX sqlite_autoindex_cloud_sync_todo_outbox_1 \(project_ref=\?\)/);
    });
  });
});

// ---------------------------------------------------------------- harness

/** Mutation switch for W-7: a screen that writes a todo when it handles the event. */
const HANDLER_WRITES = false;

const onlineNote = (e: Engine, local: string) =>
  (e.server.todos.find((t) => t.entity === "item" && t.localId === local)!.parts.note?.value ?? null) as JsonValue;
const onlineTitle = (e: Engine, local: string) =>
  (e.server.todos.find((t) => t.entity === "item" && t.localId === local)!.parts.title?.value ?? null) as JsonValue;

function screensOf(e: Engine, db: TestDb): CloudTodoScreens {
  return new CloudTodoScreens({
    db: () => db,
    dbReady: () => true,
    client: e.client,
    projectRef: PROJECT,
    sessionUser: () => e.service.sessionUser(),
    localSessionUser: () => e.service.localSessionUser(),
    isOnline: () => e.online.value,
    installId: () => e.service.installIdForScreens(),
    archivedDealIds: async () => new Set((await e.service.listRemovedDeals()).map((d) => d.transactionId)),
    onlineDealLocalIds: () => e.service.onlineDealLocalIds(),
    kick: () => e.service.kick(),
  });
}

/** A fake server whose todo push can be held open (a pass in flight). */
function holdingServer() {
  const server = new FakeServer(USER_A);
  const real = server.transport;
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  let arrived: () => void = () => undefined;
  server.transport = async (fn, args, signal) => {
    if (fn === "cloud_todo_push" && gate) {
      arrived();
      await gate;
    }
    return real(fn, args, signal);
  };
  return {
    server,
    /** Holds the next todo push; resolves when a push is waiting at the gate. */
    on: (): Promise<void> => {
      gate = new Promise<void>((r) => (open = r));
      return new Promise<void>((r) => (arrived = r));
    },
    release: () => {
      gate = null;
      open();
    },
  };
}

async function flush(): Promise<void> {
  // Microtasks only (no timer): lets a kick's continuation after its pass run.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** The engine after its first pass (done), with a fake clock and the watcher's 5 s looks driven by hand. */
async function setup(server?: FakeServer) {
  const { db, deal } = profile();
  const e = makeEngine(db, { server });
  const t0 = Date.parse("2026-11-14T12:00:00.000Z");
  const clock = { t: t0 };
  Object.defineProperty(e.clock, "now", { get: () => new Date(clock.t), set: () => undefined, configurable: true });
  e.server.serverNow = () => clock.t;
  let source: "watch" | "timer" | "other" = "other";
  const kicks: Array<{ t: number; source: string }> = [];
  const realKick = e.service.kick.bind(e.service);
  e.service.kick = () => {
    kicks.push({ t: clock.t, source });
    return realKick();
  };
  await startAndPass(e);
  await flush();
  expect(e.service.runner!.lastSummary!.outcome).toBe("done");
  expect(outbox(db)).toEqual([]);
  expect(e.watchTimers.map((w) => w.ms)).toEqual([LOOK_MS]);
  let nextLook = t0 + LOOK_MS;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await e.service.runner!.whenIdle();
      await flush();
    }
  };
  return {
    db,
    deal,
    e,
    t0,
    clock,
    settle,
    pushes: () => e.server.callsTo("cloud_todo_push").length,
    watchKicks: () => kicks.filter((k) => k.source === "watch").map((k) => k.t),
    timerKicks: () => kicks.filter((k) => k.source === "timer").map((k) => k.t),
    activeWatchTimers: () => e.watchTimers.filter((w) => !w.cleared).length,
    fireTimer: () => {
      source = "timer";
      for (const t of e.timers) if (!t.cleared) t.fn();
      source = "other";
    },
    /** Moves the clock to `end`, firing the watcher's live 5 s timers at each boundary on the way. */
    advanceTo: async (end: number, opts: { idle?: boolean } = {}) => {
      while (nextLook <= end) {
        clock.t = nextLook;
        nextLook += LOOK_MS;
        source = "watch";
        for (const w of e.watchTimers) if (!w.cleared) w.fn();
        source = "other";
        if (opts.idle === false) await flush();
        else await settle();
      }
      clock.t = Math.max(clock.t, end);
    },
  };
}

/** The watcher alone over a real database (Keepr Cloud on), with fake deps. */
function unit(opts: { record?: boolean } = {}) {
  const { db } = profile();
  const prepared: string[] = [];
  const watched: TestDb = opts.record
    ? ({ ...db, prepare: (sql: string) => (prepared.push(sql), db.prepare(sql)) } as TestDb)
    : db;
  const clock = { t: Date.parse("2026-11-14T12:00:00.000Z") };
  const kicks = { n: 0 };
  const ready = { v: true };
  const user = { id: USER_A as string | null };
  const w = new TodoOutboxWatcher({
    db: () => watched,
    dbReady: () => ready.v,
    projectRef: PROJECT,
    isOnline: () => true,
    getAuthUserId: () => user.id,
    passRunning: () => false,
    kick: () => {
      kicks.n++;
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
    now: () => new Date(clock.t),
  });
  return { db, w, clock, kicks, ready, user, prepared };
}
