/**
 * @jest-environment node
 *
 * BACKLOG-4243 R1 — the dirty-mark triggers exist on a profile if and only if
 * Keepr Cloud is on there (some cloud_sync_settings row with enabled = 1 or a
 * turn-off still owed). Turn-on, turn-off, the machine-binding reset, forgetting
 * another project, a restored file and the pass self-check all follow the rule.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, dirty, dirtyCount, enableUser, freshDb, insertDeal, OTHER_PROJECT, PROJECT, USER_A, USER_B } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, DEVICE_1, DEVICE_2 } from "./helpers/engine";
import { CLOUD_SYNC_TRIGGERS, MARK_ALL_ELIGIBLE_ENABLED_SQL } from "../../db/cloudSyncSql";
import {
  applyCloudSyncTriggerRule,
  cloudSyncTriggersUnavailable,
  cloudSyncTriggersWanted,
  ensureCloudSyncTriggers,
  prepareRestoredFile,
} from "../../db/cloudSyncTriggers";
import { disableForUser, enableForUser, ensureInstall, forgetOtherProjects, preparePass } from "../../db/cloudSyncDbService";

const ALL = CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort();

function triggers(db: TestDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function schemaCookie(db: TestDb): number {
  return (db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
}

/** A profile as it really is: schema.sql only, no triggers (the open's rule applied). */
function realProfile(): TestDb {
  const db = freshDb({ triggers: false });
  applyCloudSyncTriggerRule(db);
  return db;
}

const turnOn = (db: TestDb, user = USER_A, project = PROJECT) =>
  enableForUser(db, project, user, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" });

describe(`Keepr Cloud trigger rule R1 [${DRIVER}]`, () => {
  it("there are 28 triggers (22 dirty-mark, 6 todo capture: BACKLOG-4263)", () => {
    expect(CLOUD_SYNC_TRIGGERS).toHaveLength(28);
  });

  it("C-a / REGULAR PROFILE: Keepr Cloud never on — no trigger, no mark, no DDL on the next open, bulk writes mark nothing, get-view hidden", async () => {
    const db = realProfile();
    expect(triggers(db)).toEqual([]);
    const cookie = schemaCookie(db);
    // A bulk import on a regular profile.
    db.exec("BEGIN");
    for (let i = 0; i < 200; i++) insertDeal(db, `imp-${i}`);
    db.prepare("UPDATE transactions SET property_city = 'X'").run();
    db.exec("COMMIT");
    // The next open applies the rule again: no DDL at all.
    expect(applyCloudSyncTriggerRule(db)).toEqual({ ok: true, wanted: false, created: 0, dropped: 0 });
    expect(schemaCookie(db)).toBe(cookie);
    expect(triggers(db)).toEqual([]);
    expect(dirtyCount(db)).toBe(0);
    const e = makeEngine(db);
    e.feature.allowed = false;
    e.service.refreshSchedule();
    await expect(e.service.getView()).resolves.toMatchObject({ status: "hidden" });
    expect(e.timers).toHaveLength(0);
    expect(e.server.calls).toHaveLength(0);
  });

  it("C-b: turn-on creates all 28 triggers before the deals are marked, in one transaction; a deal added right after the mark is marked", () => {
    const db = realProfile();
    insertDeal(db, "d-before");
    // A deal added between the mark-all step and the end of the turn-on transaction.
    const realPrepare = db.prepare.bind(db);
    let injected = false;
    (db as { prepare: TestDb["prepare"] }).prepare = (sql: string) => {
      const st = realPrepare(sql);
      if (!injected && sql.includes("WHERE t.user_id = ? AND") && sql.startsWith("INSERT INTO cloud_sync_dirty")) {
        return {
          ...st,
          run: (...p: unknown[]) => {
            const r = st.run(...p);
            injected = true;
            insertDeal(db, "d-during");
            return r;
          },
        };
      }
      return st;
    };
    turnOn(db);
    (db as { prepare: TestDb["prepare"] }).prepare = realPrepare;
    expect(injected).toBe(true);
    expect(triggers(db)).toEqual(ALL);
    expect(dirty(db).map((d) => d.transaction_id).sort()).toEqual(["d-before", "d-during"]);
  });

  it("C-b: a turn-on whose trigger creation fails leaves neither the flag nor any trigger", () => {
    const db = realProfile();
    insertDeal(db, "d-1");
    const realPrepare = db.prepare.bind(db);
    (db as { prepare: TestDb["prepare"] }).prepare = (sql: string) => {
      if (sql.startsWith("CREATE TRIGGER trg_cloud_sync_item_insert")) throw Object.assign(new Error("disk"), { code: "SQLITE_FULL" });
      return realPrepare(sql);
    };
    expect(() => turnOn(db)).toThrow();
    (db as { prepare: TestDb["prepare"] }).prepare = realPrepare;
    expect(triggers(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_settings WHERE enabled = 1").get()).toEqual({ n: 0 });
    expect(dirtyCount(db)).toBe(0);
  });

  it("C-c: a settled turn-off with one user ends with zero triggers", async () => {
    const db = realProfile();
    turnOn(db);
    const e = makeEngine(db);
    expect(await e.service.turnOff()).toEqual({ success: true });
    expect(triggers(db)).toEqual([]);
  });

  it("C-c: with a second user still on, one user's turn-off keeps all 28; that user's deals stay unmarked", async () => {
    const db = realProfile();
    turnOn(db, USER_A);
    turnOn(db, USER_B);
    const e = makeEngine(db);
    expect(await e.service.turnOff()).toEqual({ success: true });
    expect(triggers(db)).toEqual(ALL);
    db.exec("DELETE FROM cloud_sync_dirty");
    insertDeal(db, "a-deal", USER_A);
    insertDeal(db, "b-deal", USER_B);
    expect(dirty(db).map((d) => d.transaction_id)).toEqual(["b-deal"]);
  });

  it("C-d: a turn-off owed offline keeps the triggers until the server step is settled, then drops them", async () => {
    const db = realProfile();
    turnOn(db);
    const e = makeEngine(db);
    e.server.override = (fn) => (fn === "set_my_cloud_autosave" ? new Error("offline") : undefined);
    expect(await e.service.turnOff()).toEqual({ success: true, pendingOnline: true });
    expect(cloudSyncTriggersWanted(db)).toBe(true);
    expect(triggers(db)).toEqual(ALL);
    e.server.override = null;
    e.service.refreshSchedule();
    await e.service.runner!.whenIdle();
    expect(triggers(db)).toEqual([]);
  });

  it("turned off on another computer (local turn-off, not owed): zero triggers", async () => {
    const db = realProfile();
    turnOn(db);
    const e = makeEngine(db);
    e.server.enabled = false;
    e.service.refreshSchedule();
    await e.service.runner!.whenIdle();
    expect(triggers(db)).toEqual([]);
  });

  it("startup on a profile with triggers but no qualifying row drops them (profiles from earlier builds)", () => {
    const db = freshDb({ triggers: false });
    ensureCloudSyncTriggers(db); // what an earlier build did on every open
    expect(triggers(db)).toEqual(ALL);
    expect(applyCloudSyncTriggerRule(db)).toMatchObject({ wanted: false, dropped: 28 });
    expect(triggers(db)).toEqual([]);
  });

  it("C-e: an enabled row on any build: the open's rule keeps every trigger, and a missing one is created", () => {
    const db = realProfile();
    turnOn(db);
    db.exec("DROP TRIGGER trg_cloud_sync_tx_update");
    expect(applyCloudSyncTriggerRule(db)).toMatchObject({ wanted: true, created: 1 });
    expect(triggers(db)).toEqual(ALL);
  });

  it("rule 7: the machine-binding reset (all users off) ends with zero triggers", () => {
    const db = realProfile();
    ensureInstall(db, PROJECT, DEVICE_1);
    turnOn(db);
    expect(triggers(db)).toEqual(ALL);
    ensureInstall(db, PROJECT, DEVICE_2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_settings WHERE enabled = 1").get()).toEqual({ n: 0 });
    expect(triggers(db)).toEqual([]);
  });

  it("rule 7: forgetting the other project when only it was on ends with zero triggers", () => {
    const db = realProfile();
    turnOn(db, USER_A, OTHER_PROJECT);
    expect(triggers(db)).toEqual(ALL);
    forgetOtherProjects(db, PROJECT);
    expect(triggers(db)).toEqual([]);
  });

  it("restore: the restored file follows the rule in both states", () => {
    const off = freshDb({ triggers: false });
    ensureCloudSyncTriggers(off);
    prepareRestoredFile(off);
    expect(triggers(off)).toEqual([]);
    const on = realProfile();
    turnOn(on);
    on.exec("DROP TRIGGER trg_cloud_sync_party_insert");
    prepareRestoredFile(on);
    expect(triggers(on)).toEqual(ALL);
  });

  it("self-check: Cloud on, a trigger deleted by hand, a write it missed → the next pass recreates it, marks every deal, and uploads the change", async () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    const e = makeEngine(db);
    await startAndPass(e);
    expect(dirtyCount(db)).toBe(0);
    db.exec("DROP TRIGGER trg_cloud_sync_tx_update");
    db.prepare("UPDATE transactions SET property_city = 'Missed' WHERE id = ?").run(id);
    expect(dirtyCount(db)).toBe(0);
    const before = e.server.callsTo("cloud_upsert_deal").length;
    await pass(e);
    expect(triggers(db)).toEqual(ALL);
    expect(e.server.callsTo("cloud_upsert_deal").length).toBe(before + 1);
    expect(e.logs.some((l) => l.message.includes("Triggers were missing"))).toBe(true);
  });

  it("self-check on a healthy profile issues no DDL", async () => {
    const db = freshDb();
    enableUser(db);
    insertDeal(db, dealId());
    const e = makeEngine(db);
    await startAndPass(e);
    const cookie = schemaCookie(db);
    await pass(e);
    expect(schemaCookie(db)).toBe(cookie);
  });

  it("self-check: a trigger that cannot be created on this schema is reported once and does not re-mark every deal on each pass", () => {
    const db = freshDb();
    enableUser(db);
    insertDeal(db, dealId());
    // The schema loses a column three triggers name (dropping the table drops its triggers too).
    db.exec("DROP TABLE contact_source_links");
    db.exec("CREATE TABLE contact_source_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL)");
    const unavailable = ALL.filter((n) => n.startsWith("trg_cloud_sync_contact_source_links_"));
    expect(unavailable).toHaveLength(3);
    expect(triggers(db)).toEqual(ALL.filter((n) => !unavailable.includes(n)));

    let markAll = 0;
    const prepare = db.prepare.bind(db);
    (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (sql === MARK_ALL_ELIGIBLE_ENABLED_SQL) markAll++;
      return prepare(sql);
    }) as typeof db.prepare;
    const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const log = { warn: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }) };
    const acceptedAt = (db.prepare("SELECT accepted_at FROM cloud_sync_settings").get() as { accepted_at: string | null }).accepted_at;

    for (let i = 0; i < 3; i++) preparePass(db, PROJECT, USER_A, acceptedAt, log);

    // Nothing to repair that a pass could repair: zero mark-alls across three passes.
    expect(markAll).toBe(0);
    const reports = logs.filter((l) => l.message.includes("cannot be created on this schema"));
    expect(reports).toHaveLength(1);
    expect(reports[0].meta).toEqual({ code: "CLOUD_SYNC_TRIGGER_PREREQUISITE", triggers: unavailable });
    expect(logs.some((l) => l.message.includes("every deal marked"))).toBe(false);
    expect(triggers(db)).toEqual(ALL.filter((n) => !unavailable.includes(n)));
    expect(cloudSyncTriggersUnavailable()).toEqual(unavailable);

    // A repairable trigger alongside them is still recreated, with exactly one mark-all.
    db.exec("DROP TRIGGER trg_cloud_sync_tx_update");
    for (let i = 0; i < 3; i++) preparePass(db, PROJECT, USER_A, acceptedAt, log);
    expect(markAll).toBe(1);
    expect(triggers(db)).toEqual(ALL.filter((n) => !unavailable.includes(n)));
    expect(logs.filter((l) => l.message.includes("cannot be created on this schema"))).toHaveLength(1);
  });

  it("disableForUser keeps the rule: owed keeps, not owed drops", () => {
    const db = realProfile();
    turnOn(db);
    disableForUser(db, PROJECT, USER_A, true);
    expect(triggers(db)).toEqual(ALL);
    disableForUser(db, PROJECT, USER_A, false);
    expect(triggers(db)).toEqual([]);
  });
});
