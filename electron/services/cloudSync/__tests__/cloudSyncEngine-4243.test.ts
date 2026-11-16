/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-1 + PR-2 — the Keepr Cloud engine over the real schema.sql
 * and a fake server whose envelopes are transcribed from the contract SQL
 * (helpers/fakeServer.ts). No network, no Electron.
 */
import { DRIVER } from "./helpers/sqlite";
import { dealId, dirty, dirtyCount, enableUser, freshDb, insertDeal, OTHER_PROJECT, PROJECT, USER_A, USER_B } from "./helpers/fixtures";
import { DEVICE_1, DEVICE_2, makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { FakeServer } from "./helpers/fakeServer";
import { machineHash, PARKED_UNTIL } from "../../db/cloudSyncDbService";
import { devGuardReason } from "../environment";
import { portalUrl, portalOrigin } from "../../../utils/portalUrl";
import type { TestDb } from "./helpers/sqlite";

function stateRows(db: TestDb) {
  return db.prepare("SELECT owner_user_id, local_id, cloud_id, content_hash, last_status FROM cloud_sync_state ORDER BY local_id").all() as Array<{
    owner_user_id: string;
    local_id: string;
    cloud_id: string;
    content_hash: string;
    last_status: string;
  }>;
}

function settingsRow(db: TestDb, user = USER_A, project = PROJECT) {
  return db.prepare("SELECT * FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(project, user) as
    | { enabled: number; local_confirmed_at: string | null; turn_off_owed_at: string | null; accepted_at: string | null }
    | undefined;
}

/** An enabled, confirmed user with one dirty deal, the install bound to DEVICE_1. */
function onWithDeal(): { db: TestDb; e: Engine; id: string } {
  const db = freshDb();
  enableUser(db);
  const id = dealId();
  insertDeal(db, id);
  const e = makeEngine(db);
  return { db, e, id };
}

describe(`Keepr Cloud engine [${DRIVER}]`, () => {
  // ------------------------------------------------------------ isolation
  describe("off by default: a user who never turned it on", () => {
    it("ISO-1: no timer, no server call, no dirty growth, and Settings hidden without a server call", async () => {
      const db = freshDb();
      const e = makeEngine(db);
      e.feature.allowed = false;
      e.service.refreshSchedule();
      for (let i = 0; i < 3; i++) insertDeal(db, dealId());
      db.prepare("UPDATE transactions SET property_city = 'Q'").run();
      const any = (db.prepare("SELECT id FROM transactions LIMIT 1").get() as { id: string }).id;
      db.prepare("INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('iso-c', ?, 't', 'List')").run(any);
      db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('iso-i', 'iso-c', 'One')").run();
      expect(e.timers).toHaveLength(0);
      expect(await e.service.kick()).toBeNull();
      const view = await e.service.getView();
      expect(view.status).toBe("hidden");
      expect(e.server.calls).toHaveLength(0);
      expect(dirtyCount(db)).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_install").get()).toEqual({ n: 0 });
    });

    it("ISO-2 positive: once on, the schedule starts a timer and a pass calls the server", async () => {
      const { e } = onWithDeal();
      await startAndPass(e);
      expect(e.timers).toHaveLength(1);
      expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------ PR-1: settings
  describe("Settings (C1.x)", () => {
    it("C1.1: state read throw / error / null → hidden when never enabled here; licensed:false → hidden; entitled+on → on", async () => {
      const db = freshDb();
      const e = makeEngine(db);
      e.server.override = () => new Error("boom");
      expect((await e.service.getView()).status).toBe("hidden");
      e.server.override = () => ({ data: null, error: { code: "PGRST301" }, status: 401 });
      expect((await e.service.getView()).status).toBe("hidden");
      e.server.override = () => ({ data: null, error: null, status: 200 });
      expect((await e.service.getView()).status).toBe("hidden");
      e.server.override = null;
      e.server.licensed = false;
      e.server.enabled = false;
      expect((await e.service.getView()).status).toBe("hidden");
      e.server.licensed = true;
      e.server.enabled = true;
      enableUser(db);
      expect((await e.service.getView()).status).toBe("on");
    });

    it("C1.1b: licensed but off here → off with the notice version", async () => {
      const db = freshDb();
      const e = makeEngine(db);
      e.server.enabled = false;
      expect(await e.service.getView()).toMatchObject({ status: "off", noticeVersion: 1, engineInstalled: true });
    });

    it("C1.2: turn-on sends the state's current_notice_version and marks every eligible deal", async () => {
      const db = freshDb();
      const ids = [dealId(), dealId()];
      ids.forEach((id) => insertDeal(db, id));
      const e = makeEngine(db);
      e.server.enabled = false;
      const r = await e.service.turnOn(1);
      expect(r).toEqual({ success: true });
      const set = e.server.callsTo("set_my_cloud_autosave");
      expect(set).toHaveLength(1);
      expect(set[0].args).toEqual({ p_expected_user_id: USER_A, p_enabled: true, p_notice_version: 1 });
      expect(settingsRow(db)).toMatchObject({ enabled: 1, accepted_at: "2026-11-14T10:00:00.000Z" });
      expect(dirty(db).map((d) => d.transaction_id).sort()).toEqual(ids.sort());
    });

    it("C1.3: turn-off works when the state read throws; the section stays visible because it is on here", async () => {
      const { db, e } = onWithDeal();
      e.server.override = (fn) => (fn === "get_my_cloud_autosave_state" ? new Error("down") : undefined);
      expect(await e.service.getView()).toMatchObject({ status: "paused", pausedReason: "unknown" });
      const r = await e.service.turnOff();
      expect(r.success).toBe(true);
      expect(e.server.callsTo("set_my_cloud_autosave")[0].args).toEqual({ p_expected_user_id: USER_A, p_enabled: false, p_notice_version: null });
      expect(settingsRow(db)).toMatchObject({ enabled: 0, turn_off_owed_at: null });
      expect(dirtyCount(db)).toBe(0);
    });

    it("C1.3b: turn-off offline is local at once and owed; the next pass makes the call", async () => {
      const { db, e } = onWithDeal();
      e.server.override = (fn) => (fn === "set_my_cloud_autosave" ? new Error("offline") : undefined);
      expect(await e.service.turnOff()).toEqual({ success: true, pendingOnline: true });
      expect(settingsRow(db)?.enabled).toBe(0);
      expect(settingsRow(db)?.turn_off_owed_at).not.toBeNull();
      e.server.override = null;
      e.service.refreshSchedule();
      await e.service.runner!.whenIdle();
      expect(e.server.callsTo("set_my_cloud_autosave")).toHaveLength(2);
      expect(settingsRow(db)?.turn_off_owed_at).toBeNull();
      expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(0);
    });

    it("C1.4: actions refuse with no validated session user even when the SDK has a user", async () => {
      const db = freshDb();
      const e = makeEngine(db);
      e.server.enabled = false;
      e.session.lastActivity = null;
      expect(await e.service.turnOn(1)).toEqual({ success: false, error: "signed_out" });
      expect(await e.service.turnOff()).toEqual({ success: false, error: "signed_out" });
      expect(await e.service.confirmComputer()).toEqual({ success: false, error: "signed_out" });
      expect(e.server.calls).toHaveLength(0);
      e.session.lastActivity = 1;
      e.emit("saved", USER_A);
      expect((await e.service.turnOn(1)).success).toBe(true);
    });

    it("C1.5: AI apps opens exactly the portal origin + /dashboard/account/ai-apps; a look-alike host opens nothing", () => {
      expect(portalUrl("aiApps", "https://app.keeprcompliance.com")).toBe("https://app.keeprcompliance.com/dashboard/account/ai-apps");
      expect(portalUrl("aiApps", "http://localhost:3000")).toBe("http://localhost:3000/dashboard/account/ai-apps");
      expect(portalUrl("aiApps", "https://evilkeeprcompliance.com")).toBeNull();
      expect(portalOrigin("https://evilkeeprcompliance.com")).toBeNull();
    });

    it("C1.8: current_notice_version 2 with texts {1} → update needed and no set_my_cloud_autosave call", async () => {
      const db = freshDb();
      const e = makeEngine(db);
      e.server.enabled = false;
      e.server.currentNoticeVersion = 2;
      expect((await e.service.getView()).status).toBe("update_needed");
      expect(await e.service.turnOn(2)).toEqual({ success: false, error: "update_needed" });
      expect(await e.service.turnOn(1)).toEqual({ success: false, error: "update_needed" });
      expect(e.server.callsTo("set_my_cloud_autosave")).toHaveLength(0);
    });

    it("needs confirmation: on for the account, not confirmed here → nothing uploads until confirmed", async () => {
      const db = freshDb();
      const id = dealId();
      insertDeal(db, id);
      const e = makeEngine(db);
      expect((await e.service.getView()).status).toBe("needs_confirmation");
      e.service.refreshSchedule();
      expect(e.timers).toHaveLength(0);
      expect((await e.service.confirmComputer()).success).toBe(true);
      await e.service.runner!.whenIdle();
      expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(1);
      expect(stateRows(db)).toMatchObject([{ local_id: id, last_status: "synced" }]);
    });
  });

  // ------------------------------------------------------------ identity
  describe("identity (C2.1–C2.4, R1)", () => {
    it("C2.1: restart with a validated session and no saved event → one pass runs", async () => {
      const { e } = onWithDeal();
      const s = await startAndPass(e);
      expect(s?.outcome).toBe("done");
      expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(1);
    });

    it("C2.1: expired session file → zero RPC; not validated (getLastActivity null) → zero RPC", async () => {
      const a = onWithDeal();
      a.e.session.expired = true;
      expect((await startAndPass(a.e))?.outcome).toBe("signed_out");
      expect(a.e.server.calls).toHaveLength(0);
      const b = onWithDeal();
      b.e.session.lastActivity = null;
      expect((await startAndPass(b.e))?.outcome).toBe("signed_out");
      expect(b.e.server.calls).toHaveLength(0);
    });

    it("C2.2: the SDK user switches between the state read and the send → zero writes for that deal", async () => {
      const { db, e } = onWithDeal();
      // pass start check A, then the guard before the upsert sees B.
      e.authUser.sequence = [USER_A, USER_B];
      e.authUser.id = USER_B;
      const s = await startAndPass(e);
      expect(s?.outcome).toBe("identity_mismatch");
      expect(e.server.writeCalls()).toHaveLength(0);
      expect(stateRows(db)).toHaveLength(0);
      expect(dirtyCount(db)).toBe(1);
    });

    it("C2.3: wrong_account → pass stops, nothing saved, no retry until a session event", async () => {
      const { db, e } = onWithDeal();
      e.server.override = (fn) => (fn === "cloud_upsert_deal" ? { data: { ok: false, error: "wrong_account" }, error: null } : undefined);
      expect((await startAndPass(e))?.outcome).toBe("wrong_account");
      expect(stateRows(db)).toHaveLength(0);
      expect(dirty(db)).toMatchObject([{ attempts: 0, next_attempt_at: null }]);
      expect(e.reports).toEqual(["wrong_account"]);
      const before = e.server.calls.length;
      expect((await pass(e)).outcome).toBe("signed_out");
      expect(e.server.calls.length).toBe(before);
      e.server.override = null;
      e.emit("saved", USER_A);
      expect((await pass(e)).outcome).toBe("done");
      expect(stateRows(db)).toHaveLength(1);
    });

    it("C2.4: each of the three id comparisons blocks every write", async () => {
      const fileVsSdk = onWithDeal();
      fileVsSdk.e.authUser.id = USER_B;
      expect((await startAndPass(fileVsSdk.e))?.outcome).toBe("identity_mismatch");
      expect(fileVsSdk.e.server.calls).toHaveLength(0);

      const stateVsUser = onWithDeal();
      stateVsUser.e.server.tokenUser = USER_B;
      expect((await startAndPass(stateVsUser.e))?.outcome).toBe("identity_mismatch");
      expect(stateVsUser.e.server.writeCalls()).toHaveLength(0);

      // SDK vs deal owner: user A's pass never sends user B's deal.
      const owner = onWithDeal();
      const bDeal = dealId();
      enableUser(owner.db, USER_B);
      insertDeal(owner.db, bDeal, USER_B);
      await startAndPass(owner.e);
      const sent = owner.e.server.callsTo("cloud_upsert_deal").map((c) => (c.args.p_deal as Record<string, unknown>).local_id);
      expect(sent).toEqual([owner.id]);
      expect(dirty(owner.db).map((d) => d.transaction_id)).toEqual([bDeal]);
    });

    it("R1: the live user changes mid-pass; every call carries the pinned id and nothing is recorded as saved", async () => {
      const { db, e } = onWithDeal();
      const id2 = dealId();
      insertDeal(db, id2);
      // The SDK keeps reporting A to every check, but the server's token is B from the first write on.
      e.server.override = (fn) => {
        if (fn !== "get_my_cloud_autosave_state") e.server.tokenUser = USER_B;
        return undefined;
      };
      // The SDK reports A to the three reads a correct pass makes before its first write
      // (pass start, loop guard, call guard), then B: the token switched to B right after the guard.
      e.authUser.sequence = [USER_A, USER_A, USER_A];
      e.authUser.id = USER_B;
      const s = await startAndPass(e);
      const writes = e.server.writeCalls();
      expect(writes.length).toBeGreaterThan(0);
      for (const c of writes) expect(c.args.p_expected_user_id).toBe(USER_A);
      expect(s?.outcome).not.toBe("done");
      expect(stateRows(db)).toHaveLength(0);
      expect(dirtyCount(db)).toBe(2);
    });
  });

  // ------------------------------------------------------------ install, project guard
  describe("install and project (C2.5, C2.6, C2.27, C2.30, C2.31)", () => {
    it("C2.5: install id created once per project; another project gets another id", async () => {
      const { db, e } = onWithDeal();
      await startAndPass(e);
      const first = e.server.callsTo("cloud_upsert_deal")[0].args.p_deal as Record<string, unknown>;
      db.prepare("UPDATE transactions SET property_city = 'Other'").run();
      await pass(e);
      const second = e.server.callsTo("cloud_upsert_deal")[1].args.p_deal as Record<string, unknown>;
      expect(second.source_install_id).toBe(first.source_install_id);
      const other = makeEngine(db, { projectRef: OTHER_PROJECT });
      (other.service as unknown as { ensureInstallId: () => string }).ensureInstallId();
      const ids = db.prepare("SELECT project_ref, install_id FROM cloud_sync_install ORDER BY project_ref").all() as Array<{ install_id: string }>;
      expect(ids).toHaveLength(2);
      expect(ids[0].install_id).not.toBe(ids[1].install_id);
    });

    it("C2.6: an enabled row under another project → no pass, 'different Keepr Cloud'; same project → pass", async () => {
      const db = freshDb();
      enableUser(db, USER_A, OTHER_PROJECT);
      enableUser(db, USER_A, PROJECT);
      insertDeal(db, dealId());
      const e = makeEngine(db);
      expect((await startAndPass(e))?.outcome).toBe("other_project");
      expect(await e.service.getView()).toMatchObject({ status: "paused", pausedReason: "other_project" });
      expect(e.server.calls).toHaveLength(0);
      const same = onWithDeal();
      expect((await startAndPass(same.e))?.outcome).toBe("done");
    });

    it("C2.31: forget the other project → its rows gone, no call to either cloud, the next pass runs", async () => {
      const db = freshDb();
      enableUser(db, USER_A, OTHER_PROJECT);
      db.prepare("INSERT INTO cloud_sync_state (project_ref, owner_user_id, entity, local_id, transaction_id, updated_at) VALUES (?, ?, 'deal', 'x', 'x', 'now')").run(OTHER_PROJECT, USER_A);
      enableUser(db, USER_A, PROJECT);
      insertDeal(db, dealId());
      const e = makeEngine(db);
      e.online.value = false; // any pass the action schedules stops before a call
      expect((await e.service.forgetOtherProject()).success).toBe(true);
      await e.service.runner!.whenIdle();
      expect(e.server.calls).toHaveLength(0);
      e.online.value = true;
      expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_settings WHERE project_ref = ?").get(OTHER_PROJECT)).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_state WHERE project_ref = ?").get(OTHER_PROJECT)).toEqual({ n: 0 });
      expect(dirtyCount(db)).toBe(1);
      expect((await pass(e)).outcome).toBe("done");
    });

    it("C2.27: dev guard — unpackaged + production project refused, test project allowed, override allowed", () => {
      const prodEnv = "SUPABASE_URL=https://prodref.supabase.co\nOTHER=1\n";
      expect(devGuardReason({ isPackaged: false, configuredUrl: "https://prodref.supabase.co", productionEnvText: prodEnv, devOverride: undefined })).toBe("dev_production");
      expect(devGuardReason({ isPackaged: false, configuredUrl: "https://testref.supabase.co", productionEnvText: prodEnv, devOverride: undefined })).toBeNull();
      expect(devGuardReason({ isPackaged: false, configuredUrl: "https://prodref.supabase.co", productionEnvText: prodEnv, devOverride: "1" })).toBeNull();
      expect(devGuardReason({ isPackaged: false, configuredUrl: "https://testref.supabase.co", productionEnvText: null, devOverride: undefined })).toBe("dev_unknown_project");
      expect(devGuardReason({ isPackaged: true, configuredUrl: "https://prodref.supabase.co", productionEnvText: null, devOverride: undefined })).toBeNull();
    });

    it("C2.27b: a blocked engine makes no call", async () => {
      const { e } = onWithDeal();
      e.blocked.reason = "dev_production";
      expect((await startAndPass(e))?.outcome).toBe("blocked");
      expect(e.server.calls).toHaveLength(0);
    });

    it("C2.30: a cloned database on another machine mints a new install id, clears state and marks, and waits for confirmation", async () => {
      const { db, e } = onWithDeal();
      await startAndPass(e);
      const oldId = (db.prepare("SELECT install_id FROM cloud_sync_install").get() as { install_id: string }).install_id;
      expect(stateRows(db)).toHaveLength(1);
      // Same database, other machine.
      const e2 = makeEngine(db);
      e2.device.id = DEVICE_2;
      e2.service.refreshSchedule();
      await e2.service.runner?.whenIdle();
      const row = db.prepare("SELECT install_id, machine_hash FROM cloud_sync_install").get() as { install_id: string; machine_hash: string };
      expect(row.install_id).not.toBe(oldId);
      expect(row.machine_hash).toBe(machineHash(DEVICE_2));
      expect(stateRows(db)).toHaveLength(0);
      expect(dirtyCount(db)).toBe(0);
      expect(settingsRow(db)).toMatchObject({ enabled: 0, local_confirmed_at: null });
      expect(e2.server.calls).toHaveLength(0);
      expect((await e2.service.confirmComputer()).success).toBe(true);
      await e2.service.runner!.whenIdle();
      const sent = e2.server.callsTo("cloud_upsert_deal")[0].args.p_deal as Record<string, unknown>;
      expect(sent.source_install_id).toBe(row.install_id);
    });

    it("C2.30: same device keeps; a fallback id keeps; unbound then real binds without reset", async () => {
      const { db, e } = onWithDeal();
      await startAndPass(e);
      const id0 = (db.prepare("SELECT install_id FROM cloud_sync_install").get() as { install_id: string }).install_id;
      const same = makeEngine(db);
      same.service.refreshSchedule();
      await same.service.runner!.whenIdle();
      const fb = makeEngine(db);
      fb.device.id = "host-darwin-fallback";
      fb.service.refreshSchedule();
      await fb.service.runner!.whenIdle();
      expect((db.prepare("SELECT install_id FROM cloud_sync_install").get() as { install_id: string }).install_id).toBe(id0);
      expect(settingsRow(db)?.enabled).toBe(1);

      const db2 = freshDb();
      enableUser(db2);
      insertDeal(db2, dealId());
      const u = makeEngine(db2);
      u.device.id = "host-darwin-fallback";
      await startAndPass(u);
      expect(db2.prepare("SELECT machine_hash FROM cloud_sync_install").get()).toEqual({ machine_hash: null });
      const idU = (db2.prepare("SELECT install_id FROM cloud_sync_install").get() as { install_id: string }).install_id;
      const r = makeEngine(db2);
      r.service.refreshSchedule();
      await r.service.runner!.whenIdle();
      expect(db2.prepare("SELECT install_id, machine_hash FROM cloud_sync_install").get()).toEqual({ install_id: idU, machine_hash: machineHash(DEVICE_1) });
      expect(settingsRow(db2)?.enabled).toBe(1);
      expect(stateRows(db2)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------ upload
  describe("upload (C2.7, C2.20, C2.22–C2.26, R2, R3)", () => {
    it("C2.7: an unchanged deal makes zero RPC on the second pass (state read only)", async () => {
      const db = freshDb();
      enableUser(db);
      insertDeal(db, dealId(), USER_A, { updated_at: "2026-01-01 00:00:00" });
      const e = makeEngine(db);
      await startAndPass(e);
      expect(stateRows(db)).toMatchObject([{ last_status: "synced" }]);
      const n = e.server.writeCalls().length;
      // A write to a column outside the projection: updated_at moves (update_transactions_timestamp).
      db.prepare("UPDATE transactions SET message_count = 9").run();
      expect((db.prepare("SELECT updated_at FROM transactions").get() as { updated_at: string }).updated_at).not.toBe("2026-01-01 00:00:00");
      db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) SELECT id, 1, 'x' FROM transactions").run();
      await pass(e);
      expect(e.server.writeCalls().length).toBe(n);
      expect(dirtyCount(db)).toBe(0);
    });

    it("R2/R3: a header is saved only on applied/unchanged with the matching hash; then mark-synced; then the mark clears", async () => {
      const { db, e, id } = onWithDeal();
      await startAndPass(e);
      expect(e.server.writeCalls().map((c) => c.fn)).toEqual(["cloud_upsert_deal", "cloud_mark_deal_synced"]);
      expect(e.server.deals[0].fullSyncAt).not.toBeNull();
      const [st] = stateRows(db);
      expect(st).toMatchObject({ local_id: id, cloud_id: e.server.deals[0].id, content_hash: e.server.deals[0].hash, last_status: "synced" });
      expect(dirtyCount(db)).toBe(0);
      expect(await e.service.getView()).toMatchObject({ status: "on", pendingDeals: 0, lastSavedAt: "2026-11-14T12:00:00.000Z" });
    });

    it("R2: a returned hash that differs from the sent hash is not saved and no mark-synced is sent", async () => {
      const { db, e } = onWithDeal();
      e.server.override = (fn, args) =>
        fn === "cloud_upsert_deal"
          ? { data: { ok: true, results: [{ local_id: (args.p_deal as Record<string, unknown>).local_id, cloud_id: "cloud-deal-mismatch-4243", version: 1, content_hash: "0".repeat(64), status: "applied" }] }, error: null }
          : undefined;
      await startAndPass(e);
      expect(stateRows(db)).toHaveLength(0);
      expect(e.server.callsTo("cloud_mark_deal_synced")).toHaveLength(0);
      expect(dirtyCount(db)).toBe(1);
    });

    it("C2.20: a server error with a sentinel address in its message never reaches logs; the code does", async () => {
      const { e } = onWithDeal();
      const SENTINEL = "77 Sentinel Lane";
      e.server.override = (fn) =>
        fn === "cloud_upsert_deal" ? { data: null, error: { code: "23514", message: `Failing row contains (${SENTINEL})` } as never, status: 400 } : undefined;
      await startAndPass(e);
      const text = JSON.stringify(e.logs) + JSON.stringify(e.reports);
      expect(text).not.toContain(SENTINEL);
      expect(text).toContain("23514");
      expect(text).not.toContain("Springfield");
    });

    it("C2.22: accepted_at changed on the server → this user's state dropped and every eligible deal marked", async () => {
      const { db, e } = onWithDeal();
      const id2 = dealId();
      insertDeal(db, id2);
      await startAndPass(e);
      expect(stateRows(db)).toHaveLength(2);
      e.server.acceptedAt = "2026-12-01T00:00:00.000Z";
      e.server.deals = [];
      const before = e.server.callsTo("cloud_upsert_deal").length;
      await pass(e);
      expect(e.server.callsTo("cloud_upsert_deal").length - before).toBe(2);
      expect(e.server.deals).toHaveLength(2);
      expect(settingsRow(db)?.accepted_at).toBe("2026-12-01T00:00:00.000Z");
    });

    it("C2.23: not_found from mark-synced (deleted elsewhere) → header re-upserted, deal completes", async () => {
      const { db, e } = onWithDeal();
      await startAndPass(e);
      // Header saved here, not yet marked synced; meanwhile deleted by another computer.
      db.prepare("UPDATE cloud_sync_state SET last_status = 'saved'").run();
      db.prepare("INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) SELECT id, 1, 'x' FROM transactions").run();
      e.server.deals = [];
      const ups = e.server.callsTo("cloud_upsert_deal").length;
      await pass(e);
      expect(e.server.callsTo("cloud_mark_deal_synced").length).toBe(3);
      expect(e.server.callsTo("cloud_upsert_deal").length).toBe(ups + 1);
      expect(e.server.deals).toHaveLength(1);
      expect(stateRows(db)).toMatchObject([{ last_status: "synced", cloud_id: e.server.deals[0].id }]);
      expect(dirtyCount(db)).toBe(0);
    });

    it("C2.24: pending and rejected deals are not sent; a deal turned rejected after upload is deleted online", async () => {
      const { db, e, id } = onWithDeal();
      insertDeal(db, dealId(), USER_A, { detection_status: "pending" });
      insertDeal(db, dealId(), USER_A, { status: "rejected" });
      await startAndPass(e);
      expect(e.server.callsTo("cloud_upsert_deal").map((c) => (c.args.p_deal as Record<string, unknown>).local_id)).toEqual([id]);
      db.prepare("UPDATE transactions SET status = 'rejected' WHERE id = ?").run(id);
      await pass(e);
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(1);
      expect(e.server.deals).toHaveLength(0);
      expect(stateRows(db)).toHaveLength(0);
    });

    it("C2.25: a deleted local deal → cloud_delete_deal; its state survives until the answer", async () => {
      const { db, e, id } = onWithDeal();
      await startAndPass(e);
      db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
      e.server.override = (fn) => (fn === "cloud_delete_deal" ? new Error("network") : undefined);
      await pass(e);
      expect(stateRows(db)).toHaveLength(1);
      expect(dirty(db)).toMatchObject([{ attempts: 1, last_error_code: "network" }]);
      e.server.override = null;
      db.prepare("UPDATE cloud_sync_dirty SET next_attempt_at = NULL").run();
      await pass(e);
      expect(e.server.deals).toHaveLength(0);
      expect(stateRows(db)).toHaveLength(0);
      expect(dirtyCount(db)).toBe(0);
    });

    it("C2.26 / R7: transport failures back off 1 → 2 → 5 minutes; an HTTP error with a code is retryable too", async () => {
      const { db, e } = onWithDeal();
      e.server.override = (fn) => (fn === "cloud_upsert_deal" ? { data: null, error: { code: "57014" }, status: 500 } : undefined);
      await startAndPass(e);
      const at = () => dirty(db)[0].next_attempt_at;
      expect(at()).toBe("2026-11-14T12:01:00.000Z");
      for (const expected of ["2026-11-14T12:02:00.000Z", "2026-11-14T12:05:00.000Z"]) {
        db.prepare("UPDATE cloud_sync_dirty SET next_attempt_at = NULL").run();
        await pass(e);
        expect(at()).toBe(expected);
      }
      expect(dirty(db)[0]).toMatchObject({ attempts: 3, last_error_code: "57014" });
    });

    it("R6: a call that never answers is cut at the client timeout and treated as unknown (retry later)", async () => {
      jest.useFakeTimers();
      try {
        const { CloudClient } = await import("../cloudClient");
        const client = new CloudClient((_fn, _a, signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), 1000);
        const p = client.upsertDeal(USER_A, {});
        jest.advanceTimersByTime(1000);
        await expect(p).resolves.toEqual({ kind: "transport", code: "timeout" });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ------------------------------------------------------------ tolerance (C2.32)
  describe("contract tolerance (C2.32)", () => {
    function twoDeals() {
      const db = freshDb();
      enableUser(db);
      const a = dealId(9001);
      const b = dealId(9002);
      insertDeal(db, a);
      insertDeal(db, b);
      return { db, a, b, e: makeEngine(db) };
    }
    const upsertsFor = (e: Engine, id: string) =>
      e.server.callsTo("cloud_upsert_deal").filter((c) => (c.args.p_deal as Record<string, unknown>).local_id === id);

    it("(a) unknown envelope error on A: B uploads; A keeps its generation, code recorded, parked; one call across three more passes", async () => {
      const { db, a, b, e } = twoDeals();
      e.server.override = (fn, args) =>
        fn === "cloud_upsert_deal" && (args.p_deal as Record<string, unknown>).local_id === a
          ? { data: { ok: false, error: "zz_future_error" }, error: null }
          : undefined;
      await startAndPass(e);
      expect(stateRows(db).map((s) => s.local_id)).toEqual([b]);
      const [row] = dirty(db);
      expect(row).toMatchObject({ transaction_id: a, generation: 1, last_error_code: "zz_future_error" });
      expect(row.next_attempt_at).toBe(`${PARKED_UNTIL}#1`);
      for (let i = 0; i < 3; i++) await pass(e);
      expect(upsertsFor(e, a)).toHaveLength(1);
      expect(e.logs.filter((l) => l.level === "warn").map((l) => l.meta?.code)).toContain("zz_future_error");
      // A new change makes it due again.
      db.prepare("UPDATE transactions SET property_city = 'New' WHERE id = ?").run(a);
      await pass(e);
      expect(upsertsFor(e, a)).toHaveLength(2);
    });

    it("(b) unknown row status on A: not saved, mark kept, B continues", async () => {
      const { db, a, b, e } = twoDeals();
      e.server.override = (fn, args) => {
        const p = args.p_deal as Record<string, unknown> | undefined;
        return fn === "cloud_upsert_deal" && p?.local_id === a
          ? { data: { ok: true, results: [{ local_id: a, cloud_id: "cloud-deal-unknown-status-4243", version: 1, content_hash: p.content_hash, status: "zz_future_status" }] }, error: null }
          : undefined;
      };
      await startAndPass(e);
      expect(stateRows(db).map((s) => s.local_id)).toEqual([b]);
      expect(dirty(db).map((d) => d.transaction_id)).toEqual([a]);
    });

    it("(c) unknown keys in the envelope and the row: treated as applied", async () => {
      const { db, a, e } = twoDeals();
      e.server.override = (fn, args) => {
        const p = args.p_deal as Record<string, unknown> | undefined;
        if (fn !== "cloud_upsert_deal" || p?.local_id !== a) return undefined;
        const real = e.server.respond(fn, args) as { ok: boolean; results: Array<Record<string, unknown>> };
        return { data: { ...real, zz_top: 1, results: [{ ...real.results[0], zz_row: { x: 1 } }] }, error: null };
      };
      await startAndPass(e);
      expect(stateRows(db).map((s) => s.local_id)).toContain(a);
      expect(dirty(db).map((d) => d.transaction_id)).not.toContain(a);
    });

    it("(d) unknown state reason: paused, no upload, enabled stays 1, state and marks kept", async () => {
      const { db, a, e } = twoDeals();
      await startAndPass(e);
      db.prepare("UPDATE transactions SET property_city = 'Later' WHERE id = ?").run(a);
      e.server.reason = "zz_future_reason";
      const n = e.server.writeCalls().length;
      expect((await pass(e)).outcome).toBe("paused");
      expect(e.server.writeCalls().length).toBe(n);
      expect(settingsRow(db)?.enabled).toBe(1);
      expect(stateRows(db)).toHaveLength(2);
      expect(dirtyCount(db)).toBe(1);
    });

    it("not_enabled (turned off elsewhere) is the one reason that turns off here and clears state", async () => {
      const { db, e } = twoDeals();
      await startAndPass(e);
      e.server.enabled = false;
      expect((await pass(e)).outcome).toBe("not_enabled");
      expect(settingsRow(db)).toMatchObject({ enabled: 0 });
      expect(stateRows(db)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ ACID
  describe("ACID", () => {
    it("R5: one pass at a time — a second trigger queues; calls of two passes never interleave", async () => {
      const { db, e } = onWithDeal();
      insertDeal(db, dealId());
      let inFlight = 0;
      let maxInFlight = 0;
      const realT = e.server.transport;
      (e.service as unknown as { deps: { client: { transport: unknown } } }).deps.client.transport = async (
        fn: string,
        args: Record<string, never>,
        s: AbortSignal,
      ) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        try {
          return await realT(fn, args, s);
        } finally {
          inFlight--;
        }
      };
      e.service.refreshSchedule();
      const q = await e.service.runner!.runPass();
      expect(q.outcome).toBe("queued");
      await e.service.runner!.whenIdle();
      expect(maxInFlight).toBe(1);
      expect(e.server.deals).toHaveLength(2);
    });

    // Failure points: each await of a pass, the process dies there (the call rejects / the pass
    // throws), then a fresh engine runs a fresh pass on the same database.
    const KILLS: Array<{ name: string; fn: string; when: "before" | "after" }> = [
      { name: "K1 state read never answers", fn: "get_my_cloud_autosave_state", when: "before" },
      { name: "K2 upsert sent, server did not commit", fn: "cloud_upsert_deal", when: "before" },
      { name: "K3 upsert committed, process dies before local state", fn: "cloud_upsert_deal", when: "after" },
      { name: "K4 mark-synced sent, server did not commit", fn: "cloud_mark_deal_synced", when: "before" },
      { name: "K5 mark-synced committed, process dies before local 'synced'", fn: "cloud_mark_deal_synced", when: "after" },
    ];
    it.each(KILLS)("$name → the next pass repairs it: one online row, synced, no mark", async ({ fn, when }) => {
      const { db, e, id } = onWithDeal();
      const server = e.server;
      const real = server.transport;
      let killed = false;
      const killing = async (f: string, a: Record<string, never>, s: AbortSignal) => {
        if (!killed && f === fn) {
          killed = true;
          if (when === "after") await real(f, a, s);
          throw new Error("process died");
        }
        return real(f, a, s);
      };
      (e.service as unknown as { deps: { client: { transport: unknown } } }).deps.client.transport = killing;
      e.service.refreshSchedule();
      await e.service.runner!.whenIdle();
      expect(killed).toBe(true);
      // Nothing is recorded as synced and the mark remains.
      expect(stateRows(db).filter((s) => s.last_status === "synced")).toHaveLength(0);
      expect(dirtyCount(db)).toBe(1);
      // Fresh process.
      db.prepare("UPDATE cloud_sync_dirty SET next_attempt_at = NULL").run();
      const e2 = makeEngine(db, { server });
      await startAndPass(e2);
      expect(server.deals).toHaveLength(1);
      expect(server.deals[0].fullSyncAt).not.toBeNull();
      expect(stateRows(db)).toMatchObject([{ local_id: id, cloud_id: server.deals[0].id, last_status: "synced" }]);
      expect(dirtyCount(db)).toBe(0);
    });

    it("K6 delete committed online, process dies before local cleanup → next pass treats not_found as done", async () => {
      const { db, e, id } = onWithDeal();
      await startAndPass(e);
      db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
      const real = e.server.transport;
      (e.service as unknown as { deps: { client: { transport: unknown } } }).deps.client.transport = async (
        f: string,
        a: Record<string, never>,
        s: AbortSignal,
      ) => {
        if (f === "cloud_delete_deal") {
          await real(f, a, s);
          throw new Error("process died");
        }
        return real(f, a, s);
      };
      await pass(e);
      expect(stateRows(db)).toHaveLength(1);
      db.prepare("UPDATE cloud_sync_dirty SET next_attempt_at = NULL").run();
      const e2 = makeEngine(db, { server: e.server });
      await startAndPass(e2);
      expect(stateRows(db)).toHaveLength(0);
      expect(dirtyCount(db)).toBe(0);
    });

    it("a write landing during the upload keeps the deal dirty for the next pass (R4 end to end)", async () => {
      const { db, e, id } = onWithDeal();
      let wrote = false;
      const real = e.server.transport;
      (e.service as unknown as { deps: { client: { transport: unknown } } }).deps.client.transport = async (
        f: string,
        a: Record<string, never>,
        s: AbortSignal,
      ) => {
        const r = await real(f, a, s);
        if (f === "cloud_upsert_deal" && !wrote) {
          wrote = true;
          db.prepare("UPDATE transactions SET property_city = 'Mid' WHERE id = ?").run(id);
        }
        return r;
      };
      await startAndPass(e);
      expect(dirty(db)).toMatchObject([{ transaction_id: id, generation: 2 }]);
      await pass(e);
      expect(dirtyCount(db)).toBe(0);
      expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(2);
    });

    it("sign-out mid-pass stops before the next call and records nothing for it", async () => {
      const { db, e } = onWithDeal();
      insertDeal(db, dealId());
      const real = e.server.transport;
      (e.service as unknown as { deps: { client: { transport: unknown } } }).deps.client.transport = async (
        f: string,
        a: Record<string, never>,
        s: AbortSignal,
      ) => {
        const r = await real(f, a, s);
        if (f === "cloud_upsert_deal") e.emit("cleared", null);
        return r;
      };
      await startAndPass(e);
      expect(e.server.callsTo("cloud_upsert_deal")).toHaveLength(1);
      expect(e.server.callsTo("cloud_mark_deal_synced")).toHaveLength(0);
      expect(stateRows(db).filter((s) => s.last_status === "synced")).toHaveLength(0);
      expect(dirtyCount(db)).toBe(2);
    });
  });

  // ------------------------------------------------------------ lifecycle
  describe("enabled lifecycle (C2.28)", () => {
    it("0 → 1 marks all eligible deals; turn-off stops marking; turned off elsewhere clears", async () => {
      const db = freshDb();
      const a = dealId();
      insertDeal(db, a);
      insertDeal(db, dealId(), USER_A, { detection_status: "rejected" });
      const e = makeEngine(db);
      e.server.enabled = false;
      expect(dirtyCount(db)).toBe(0);
      await e.service.turnOn(1);
      await e.service.runner!.whenIdle();
      expect(e.server.deals.map((d) => d.localId)).toEqual([a]);
      await e.service.turnOff();
      db.prepare("UPDATE transactions SET property_city = 'After off'").run();
      expect(dirtyCount(db)).toBe(0);
      expect(e.server.deals).toHaveLength(0);
    });
  });
});

describe("parity: notice versions in main and in the renderer copy", () => {
  it("SUPPORTED_NOTICE_VERSIONS equals the keys of NOTICE_TEXTS", async () => {
    const { SUPPORTED_NOTICE_VERSIONS } = await import("../notice");
    const { NOTICE_TEXTS } = await import("../../../../src/components/settings/cloudSync/keeprCloudCopy");
    expect(Object.keys(NOTICE_TEXTS).map(Number).sort()).toEqual([...SUPPORTED_NOTICE_VERSIONS].sort());
  });
});

void FakeServer;
