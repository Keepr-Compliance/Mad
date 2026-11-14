/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-2 review round: turn-off during an in-flight call (B1), other
 * users' marks (B2), restore of an older copy (B3), the timer after turn-off,
 * the epoch check, "last saved", parked deals and a failing pass.
 * Same fake server and harness as cloudSyncEngine-4243.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, dirty, dirtyCount, enableUser, freshDb, insertDeal, PROJECT, USER_A, USER_B } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { prepareRestoredFile } from "../../db/cloudSyncTriggers";
import type { RpcTransport } from "../cloudClient";

function stateRows(db: TestDb) {
  return db.prepare("SELECT owner_user_id, local_id, cloud_id, content_hash, last_status FROM cloud_sync_state ORDER BY local_id").all() as Array<{
    owner_user_id: string;
    local_id: string;
    cloud_id: string | null;
    content_hash: string | null;
    last_status: string | null;
  }>;
}

function setTransport(e: Engine, t: RpcTransport): void {
  (e.service as unknown as { deps: { client: { transport: RpcTransport } } }).deps.client.transport = t;
}

const tick = () => new Promise((r) => setImmediate(r));

function onWithDeal(): { db: TestDb; e: Engine; id: string } {
  const db = freshDb();
  enableUser(db);
  const id = dealId();
  insertDeal(db, id);
  return { db, e: makeEngine(db), id };
}

describe(`Keepr Cloud review fixes [${DRIVER}]`, () => {
  describe("B1: turn-off while a call is in flight", () => {
    it("B1a: once turnOff resolves, no sync state is left for the user, even though the in-flight mark-synced returned ok", async () => {
      const { db, e } = onWithDeal();
      const real = e.server.transport;
      let held = false;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      setTransport(e, async (f, a, s) => {
        if (f === "cloud_mark_deal_synced" && !held) {
          held = true;
          await gate;
        }
        return real(f, a, s);
      });
      e.service.refreshSchedule();
      for (let i = 0; i < 50 && !held; i++) await tick();
      expect(held).toBe(true);
      const off = e.service.turnOff();
      await tick();
      release();
      expect(await off).toEqual({ success: true });
      expect(e.server.callsTo("cloud_mark_deal_synced")).toHaveLength(1);
      expect(stateRows(db)).toEqual([]);
    });

    it("B1b: turning on again never trusts an earlier 'synced' record: the deal is uploaded", async () => {
      const { db, e } = onWithDeal();
      await startAndPass(e);
      expect(stateRows(db)).toMatchObject([{ last_status: "synced" }]);
      // A stale record survived a turn-off that deleted the online copy.
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      e.service.refreshSchedule();
      e.server.enabled = false;
      e.server.deals = [];
      expect((await e.service.turnOn(1)).success).toBe(true);
      await e.service.runner!.whenIdle();
      expect(e.server.deals).toHaveLength(1);
      expect(stateRows(db)).toMatchObject([{ last_status: "synced", cloud_id: e.server.deals[0].id }]);
    });
  });

  describe("B2: another user's marks", () => {
    it("B2a: 205 older marks of user B do not stop user A's deal; B's marks are untouched", async () => {
      const db = freshDb();
      enableUser(db, USER_B);
      for (let i = 0; i < 205; i++) insertDeal(db, `deal-b-${i}`, USER_B);
      enableUser(db, USER_A);
      const a = dealId();
      insertDeal(db, a, USER_A);
      expect(dirtyCount(db)).toBe(206);
      const e = makeEngine(db);
      await startAndPass(e);
      expect(e.server.callsTo("cloud_upsert_deal").map((c) => (c.args.p_deal as Record<string, unknown>).local_id)).toEqual([a]);
      expect(dirtyCount(db)).toBe(205);
      expect(dirty(db).every((d) => d.transaction_id.startsWith("deal-b-") && d.attempts === 0 && d.next_attempt_at === null)).toBe(true);
    });

    it("B2b: a write to the deal of a user who never turned Keepr Cloud on is not marked", () => {
      const db = freshDb();
      enableUser(db, USER_A);
      insertDeal(db, "deal-b-only", USER_B);
      db.prepare("UPDATE transactions SET property_city = 'X' WHERE id = 'deal-b-only'").run();
      db.prepare("DELETE FROM transactions WHERE id = 'deal-b-only'").run();
      expect(dirtyCount(db)).toBe(0);
    });

    it("B2c: a deleted deal that user B uploaded is left for B; a deleted deal only A uploaded is handled by A", async () => {
      const db = freshDb();
      enableUser(db, USER_A);
      enableUser(db, USER_B);
      db.prepare(
        "INSERT INTO cloud_sync_state (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, updated_at) VALUES (?, ?, 'deal', 'gone-b', 'gone-b', 'cloud-gone-b', 'x')",
      ).run(PROJECT, USER_B);
      db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) VALUES ('gone-b', 1, 'a'), ('gone-none', 1, 'b')").run();
      const e = makeEngine(db);
      await startAndPass(e);
      expect(dirty(db).map((d) => d.transaction_id)).toEqual(["gone-b"]);
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(0);
    });
  });

  describe("B3: restore of an older copy", () => {
    it("B3a: after a restore, a deal whose recorded hash matches the restored content is uploaded again", async () => {
      const { db, e, id } = onWithDeal();
      await startAndPass(e);
      const [h1] = stateRows(db);
      db.prepare("UPDATE transactions SET property_city = 'Later' WHERE id = ?").run(id);
      await pass(e);
      const h2 = e.server.deals[0].hash;
      expect(h2).not.toBe(h1.content_hash);
      // The restored file: the old content and the old "synced" record, no marks.
      db.prepare("UPDATE transactions SET property_city = 'Springfield' WHERE id = ?").run(id);
      db.prepare("UPDATE cloud_sync_state SET content_hash = ?, last_status = 'synced'").run(h1.content_hash);
      db.exec("DELETE FROM cloud_sync_dirty");
      expect(prepareRestoredFile(db)).toBe(true);
      expect(stateRows(db)).toMatchObject([{ cloud_id: h1.cloud_id, content_hash: null, last_status: null }]);
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
      expect(e.server.deals[0].hash).toBe(h1.content_hash);
      expect(stateRows(db)).toMatchObject([{ last_status: "synced", content_hash: h1.content_hash }]);
    });

    it("B3b: the reset is a no-op on a file without the Keepr Cloud tables, and never throws", () => {
      const db = freshDb();
      db.exec("DROP TABLE cloud_sync_state");
      expect(prepareRestoredFile(db)).toBe(false);
      const broken = {
        exec: () => {
          throw new Error("x");
        },
        prepare: () => {
          throw new Error("x");
        },
        transaction: () => () => {
          throw new Error("x");
        },
      };
      expect(() => prepareRestoredFile(broken)).not.toThrow();
    });
  });

  describe("guards the original suite did not cover", () => {
    it("W2: turn-off clears the pass timer; firing the old timer afterwards sends nothing", async () => {
      const { e } = onWithDeal();
      await startAndPass(e);
      expect(e.timers).toHaveLength(1);
      await e.service.turnOff();
      expect(e.timers[0].cleared).toBe(true);
      const before = e.server.calls.length;
      e.timers[0].fn();
      await e.service.runner!.whenIdle();
      await tick();
      expect(e.server.calls.length).toBe(before);
    });

    it("W3: the session file changes user while the SDK still reports the pinned user → the pass stops at the next call", async () => {
      const { db, e } = onWithDeal();
      insertDeal(db, dealId());
      const real = e.server.transport;
      let switched = false;
      setTransport(e, async (f, a, s) => {
        const r = await real(f, a, s);
        if (f === "cloud_upsert_deal" && !switched) {
          switched = true;
          e.session.userId = USER_B;
          e.emit("saved", USER_B);
        }
        return r;
      });
      const s = await startAndPass(e);
      expect(s?.outcome).toBe("stopped");
      expect(e.server.writeCalls().map((c) => c.fn)).toEqual(["cloud_upsert_deal"]);
      expect(stateRows(db).filter((r) => r.last_status === "synced")).toHaveLength(0);
    });
  });

  describe("status honesty and failures", () => {
    it("N2: 'last saved' does not move on a pass that sent nothing", async () => {
      const { db, e } = onWithDeal();
      await startAndPass(e);
      const first = (await e.service.getView()).lastSavedAt;
      expect(first).toBe("2026-11-14T12:00:00.000Z");
      e.clock.now = new Date("2026-11-14T13:00:00.000Z");
      db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) SELECT id, 1, 'x' FROM transactions").run();
      await pass(e);
      expect(e.server.writeCalls()).toHaveLength(2);
      expect((await e.service.getView()).lastSavedAt).toBe(first);
    });

    it("N1: a parked deal is counted as not saved, not as saving", async () => {
      const { e } = onWithDeal();
      e.server.override = (fn) => (fn === "cloud_upsert_deal" ? { data: { ok: false, error: "zz_future_error" }, error: null } : undefined);
      await startAndPass(e);
      e.server.override = null;
      expect(await e.service.getView()).toMatchObject({ status: "on", pendingDeals: 0, notSavedDeals: 1 });
    });

    it("N3: a pass that throws resolves kick() with null and logs the code only", async () => {
      const { e } = onWithDeal();
      await startAndPass(e);
      (e.service.runner as unknown as { deps: { db: () => never } }).deps.db = () => {
        throw Object.assign(new Error("database is locked: secret detail"), { code: "SQLITE_BUSY" });
      };
      await expect(e.service.kick()).resolves.toBeNull();
      const warn = e.logs.filter((l) => l.message.includes("Pass failed"));
      expect(warn).toHaveLength(1);
      expect(warn[0].meta).toEqual({ code: "SQLITE_BUSY" });
      expect(JSON.stringify(e.logs)).not.toContain("secret detail");
    });
  });
});
