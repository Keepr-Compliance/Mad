/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-6 — the todo screens' main side (todoScreens.ts, db/cloudSyncTodoScreensDb.ts), driven through
 * the real runner pass, the real capture triggers and the app's own checklist statements against the fake server
 * (helpers/fakeServer.ts; its PR-6 RPCs are transcribed from migration 20261118110000 and 20261112170000).
 *
 *   OFF     a user who never turned Keepr Cloud on gets nothing and no network call
 *   NOTE    a conflict notice: the other version, who made it, "Use this version" records exactly one op;
 *           a notice keyed by the online id resolves to its item; one-line notices
 *   MARK    the AI-app marker names the app from the connection list, else "an AI app"
 *   HIST    online only; rows in the user's words
 *   REM     recently removed: listed online only; restore through the server arrives by the pull, once;
 *           refused offline, on a locked deal, and for anything main did not list; a second actor
 *   DEAL    Settings › Removed online: online-only and rejected rows; restore makes the online copy live
 *   EVT     cloud-todos:changed after a pull that wrote here, not after one that did not
 *   OFFPULL turn-off pulls once first
 *   PARK    the parked counts in the view
 *   WRITER  changed_json has exactly one value writer (the puller) and no renderer path
 */
import * as fs from "fs";
import * as path from "path";
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, USER_A } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { FakeServer, type FakeTodo } from "./helpers/fakeServer";
import { enableForUser } from "../../db/cloudSyncDbService";
import { CloudTodoScreens, historyWho } from "../todoScreens";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  DELETE_CHECKLIST_IN_TRANSACTION_SQL,
  DELETE_PRIVATE_ITEM_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  checkedItemArgs,
  noteItemArgs,
} from "../../db/checklistSql";
import type { JsonValue } from "../jcs";

type Row = Record<string, unknown>;
const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const INSTALL = fid(98, 4263);
const CL = fid(3, 1);
const MY = fid(3, 2);
const I1 = fid(4, 1);
const I2 = fid(4, 2);

const outbox = (db: TestDb) => db.prepare("SELECT * FROM cloud_sync_todo_outbox ORDER BY local_id, part").all() as Row[];
const item = (db: TestDb, id: string) => db.prepare("SELECT * FROM transaction_checklist_items WHERE id = ?").get(id) as Row | undefined;
const onlineItem = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "item" && t.localId === local) as FakeTodo;
const onlineList = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "checklist" && t.localId === local) as FakeTodo;
const calls = (e: Engine, fn: string) => e.server.callsTo(fn).length;

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

function engine(db: TestDb, server?: FakeServer): Engine {
  const e = makeEngine(db, { server });
  Object.defineProperty(e.clock, "now", { get: () => new Date(), set: () => undefined, configurable: true });
  e.server.serverNow = () => Date.now();
  return e;
}

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

async function synced(): Promise<{ db: TestDb; deal: string; e: Engine; s: CloudTodoScreens }> {
  const { db, deal } = profile();
  const e = engine(db);
  await startAndPass(e);
  expect(outbox(db)).toEqual([]);
  expect(e.server.todos).toHaveLength(4);
  return { db, deal, e, s: screensOf(e, db) };
}

describe(`Keepr Cloud todo screens, main side [${DRIVER}]`, () => {
  // ================================================================ OFF
  describe("OFF: never turned on", () => {
    it("every screen answer is off or empty and no call reaches the network", async () => {
      const { db, deal } = profile(false);
      const e = engine(db);
      const s = screensOf(e, db);
      const before = e.server.calls.length;
      expect(await s.localState()).toEqual({ on: false, online: true });
      expect(await s.forDeal(deal)).toEqual({ on: false, online: true, notices: [], markers: {} });
      expect(await s.history(I1)).toMatchObject({ success: false, error: "cloud_off" });
      expect(await s.listRemovedTodos(deal)).toMatchObject({ success: false, error: "cloud_off" });
      expect(await s.restoreTodo(deal, "item", fid(9, 1))).toEqual({ success: false, error: "cloud_off" });
      expect(await s.listRemovedOnline()).toMatchObject({ success: false, error: "cloud_off" });
      expect(await s.restoreOnlineDeal(fid(9, 2))).toEqual({ success: false, error: "cloud_off" });
      expect(e.server.calls.length).toBe(before);
    });
  });

  // ================================================================ LOCAL
  describe("LOCAL: the read-only answers follow the archive's rule", () => {
    it("Keepr Cloud on here, offline and with the online sign-in not matching: still on (the delete is still kept); actions are refused", async () => {
      const { deal, e, s } = await synced();
      e.authUser.id = null;
      e.online.value = false;
      expect(await s.localState()).toEqual({ on: true, online: false });
      expect((await s.forDeal(deal)).on).toBe(true);
      expect(await s.restoreTodo(deal, "item", fid(9, 1))).toEqual({ success: false, error: "cloud_off" });
    });
  });

  // ================================================================ NOTE
  describe("NOTE: notices", () => {
    async function withConflict() {
      const ctx = await synced();
      const { db, e } = ctx;
      e.server.connections = [{ id: "conn-1", client_name: "Claude", provider: "anthropic", redirect_host: "claude.ai", consented_at: "2026-11-01T00:00:00Z", last_used_at: null }];
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine, older", I1));
      const row = outbox(db)[0];
      db.prepare("UPDATE cloud_sync_todo_outbox SET edited_at = ? WHERE op_id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), row.op_id);
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude, newer");
      await pass(e);
      expect(item(db, I1)!.note).toBe("from Claude, newer");
      return ctx;
    }

    it("a conflict shows the version this computer does not show, who made the other change, and Use this version records exactly one op", async () => {
      const { db, deal, e, s } = await withConflict();
      const got = await s.forDeal(deal);
      expect(got.on).toBe(true);
      expect(got.notices).toEqual([
        expect.objectContaining({ kind: "conflict", itemId: I1, part: "note", otherText: "mine, older", otherValue: "mine, older", who: "Claude" }),
      ]);
      // the renderer's "Use this version" is the ordinary note write (checklists:set-item-note), then dismiss
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs(got.notices[0].otherValue as string, I1));
      expect(outbox(db).map((o) => `${o.local_id}:${o.part}:${JSON.parse(o.value_json as string).note}`)).toEqual([`${I1}:note:mine, older`]);
      expect(await s.dismissNotice(got.notices[0].id)).toEqual({ success: true });
      expect((await s.forDeal(deal)).notices).toEqual([]);
      await pass(e);
      expect(onlineItem(e, I1).parts.note.value).toBe("mine, older");
    });

    it("a conflict notice whose key is the online id (written before the shadow) resolves to its item", async () => {
      const { db, deal, s } = await withConflict();
      const cloudId = (db.prepare("SELECT cloud_id FROM cloud_sync_todo_state WHERE local_id = ?").get(I1) as { cloud_id: string }).cloud_id;
      db.prepare("UPDATE cloud_sync_todo_notices SET local_id = ? WHERE kind = 'conflict'").run(cloudId);
      expect((await s.forDeal(deal)).notices).toEqual([expect.objectContaining({ itemId: I1, kind: "conflict" })]);
    });

    /**
     * BACKLOG-4263: every actor kind the notice's `who` maps (todoScreens.ts `who()`), on the real conflict notice
     * from withConflict() with only its `by` / `other_by` / `actor_label` rewritten. No producer at this head puts
     * `cloud_user` on a conflict (the server writes conflict rows on `set` ops only, and `cloud_user` sends only
     * `restore`); the row is here so the mapping is swept, not because it occurs.
     */
    it("BACKLOG-4263: a conflict notice names every actor kind: cloud_user reads You, the others as before", async () => {
      const { db, deal, e, s } = await withConflict();
      const mine = `desktop:${e.service.installIdForScreens() ?? ""}`;
      const set = db.prepare(
        "UPDATE cloud_sync_todo_notices SET other_json = json_set(other_json, '$.by', ?, '$.other_by', ?), actor_label = ? WHERE kind = 'conflict'",
      );
      const whoFor = async (by: string | null, otherBy: string | null, label: string | null) => {
        set.run(by, otherBy, label);
        const notices = (await s.forDeal(deal)).notices;
        expect(notices).toHaveLength(1);
        return notices[0].who;
      };
      expect(await whoFor(`cloud_user:${USER_A}`, null, "Keepr")).toBe("You");
      expect(await whoFor(mine, mine, "Keepr desktop")).toBe("this computer");
      expect(await whoFor(`desktop:${fid(98, 1)}`, null, "Keepr desktop")).toBe("another computer");
      expect(await whoFor("ai_app:conn-1", null, "ignored")).toBe("Claude");
      expect(await whoFor(`ai_app:${fid(97, 1)}`, null, "Some app")).toBe("Some app");
      expect(await whoFor(`ai_app:${fid(97, 1)}`, null, null)).toBe("an AI app");
      expect(await whoFor("other_kind:x", null, null)).toBe("another device");
      expect(await whoFor(null, null, null)).toBe("another device");
    });

    it("a dismissed notice, another user's notice and another deal's notice are not shown", async () => {
      const { db, deal, s } = await withConflict();
      db.prepare("UPDATE cloud_sync_todo_notices SET owner_user_id = 'someone-else'").run();
      expect((await s.forDeal(deal)).notices).toEqual([]);
      expect(await s.dismissNotice(1)).toEqual({ success: false, error: "not_found" });
    });

    it("one-line notices carry their kind, title and count", async () => {
      const { db, deal, s } = await synced();
      const ins = db.prepare(
        "INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, part, kind, transaction_id, other_json, actor_kind, created_at) VALUES (?, ?, 'item', ?, ?, ?, ?, ?, 'desktop', ?)",
      );
      const at = new Date().toISOString();
      ins.run(PROJECT, USER_A, I2, "note", "dropped_not_online", deal, "{}", at);
      ins.run(PROJECT, USER_A, I1, null, "links_not_restored", deal, JSON.stringify({ count: 3 }), at);
      ins.run(PROJECT, USER_A, I2, "title", "rejected", deal, "{}", at);
      const kinds = (await s.forDeal(deal)).notices.map((n) => [n.kind, n.title, n.count ?? null]);
      expect(kinds).toEqual([
        ["dropped_not_online", "Call lender", null],
        ["links_not_restored", "Inspection", 3],
        ["not_accepted", "Call lender", null],
      ]);
    });
  });

  // ================================================================ MARK
  describe("MARK: the AI-app marker", () => {
    it("names the app from this user's connection list; without it, an AI app", async () => {
      const { db, deal, e, s } = await synced();
      e.server.aiSet(onlineItem(e, I1), "done", { is_checked: true, checked_at: new Date().toISOString() });
      await pass(e);
      expect((await s.forDeal(deal)).markers[I1]).toMatchObject({ kind: "ticked", who: "an AI app" });
      e.server.connections = [{ id: "conn-1", client_name: "Claude", provider: "anthropic", redirect_host: "claude.ai", consented_at: "2026-11-01T00:00:00Z", last_used_at: null }];
      const fresh = screensOf(e, db);
      expect((await fresh.forDeal(deal)).markers[I1]).toMatchObject({ kind: "ticked", who: "Claude" });
    });
  });

  // ================================================================ MARKWAIT
  describe("MARKWAIT: a part this computer changed and has not sent yet (SR P1-P3)", () => {
    it("P1: an AI tick pulled, then unticked here and not sent: no marker (it would say Unticked by the app); none after the untick is kept", async () => {
      const { db, deal, e, s } = await synced();
      e.server.aiSet(onlineItem(e, I1), "done", { is_checked: true, checked_at: new Date().toISOString() });
      await pass(e);
      expect((await s.forDeal(deal)).markers[I1]).toMatchObject({ kind: "ticked" });
      e.online.value = false;
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(...checkedItemArgs(0, I1));
      expect(outbox(db).map((o) => o.part)).toEqual(["done"]);
      expect((await s.forDeal(deal)).markers[I1]).toBeUndefined();
      e.online.value = true;
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect((await s.forDeal(deal)).markers[I1]).toBeUndefined();
    });

    it("P2: an AI note pulled, then a note edit here not sent: no marker while it waits", async () => {
      const { db, deal, e, s } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "from the AI");
      await pass(e);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine", I1));
      expect((await s.forDeal(deal)).markers[I1]).toBeUndefined();
    });

    it("an AI-added item whose note is edited here and not yet sent still shows Added (the waiting filter is per part)", async () => {
      const { db, deal, e, s } = await synced();
      const t = e.server.aiAdd(onlineList(e, MY), "From the AI app");
      await pass(e);
      e.online.value = false;
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine", t.id));
      expect(outbox(db).map((o) => `${o.local_id}|${o.part}`)).toEqual([`${t.id}|note`]);
      expect((await s.forDeal(deal)).markers[t.id]).toMatchObject({ kind: "added", who: "an AI app" });
    });

    it("P3: the edit here then LOSES to a newer AI change: the marker is back and names the AI change", async () => {
      const { db, deal, e, s } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "ai one", Date.now() - 120_000);
      await pass(e);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine, older", I1));
      const row = outbox(db)[0];
      db.prepare("UPDATE cloud_sync_todo_outbox SET edited_at = ? WHERE op_id = ?").run(new Date(Date.now() - 60_000).toISOString(), row.op_id);
      e.server.aiSet(onlineItem(e, I1), "note", "ai two", Date.now());
      await pass(e);
      await pass(e);
      expect(item(db, I1)!.note).toBe("ai two");
      expect(outbox(db)).toEqual([]);
      expect((await s.forDeal(deal)).markers[I1]).toMatchObject({ kind: "changed", who: "an AI app" });
    });
  });

  // ================================================================ HIST
  describe("HIST: history", () => {
    /**
     * Rows TRANSCRIBED from cloud_todo_history on the test database (supabase/tests/backlog-4263-pr6/harness-6-history.sql,
     * run 2026-11-18, rolled back; keys and values as observed (a desktop row's label is "Keepr desktop", migration 20261118110000 :1004), the fixture's own invented texts; change_seq and
     * times replaced by fixed values). Item i2: a desktop edit that LOST to an AI app's later note; item i3: removed
     * by an AI app, restored by the owner; item i1: a desktop edit with an unknowable clock ('-infinity').
     */
    const row = (x: Record<string, JsonValue>): Record<string, JsonValue> => ({
      change_seq: 1, other_by: null, received_at: "2026-11-18T05:01:13.4+00:00", effective_at: "2026-11-18T05:01:13.4+00:00", ...x,
    });
    const I2_ROWS = [
      row({ kind: "conflict", part: "note", outcome: "lost", actor_kind: "desktop", actor_label: "Keepr desktop", other_by: "ai_app:conn-1", old_value: "from desk", new_value: "from ai" }),
      row({ kind: "change", part: "note", outcome: "lost", actor_kind: "desktop", actor_label: "Keepr desktop", other_by: "ai_app:conn-1", old_value: "from ai", new_value: "from desk" }),
      row({ kind: "change", part: "note", outcome: "applied", actor_kind: "ai_app", actor_label: "Claude", old_value: "start", new_value: "from ai" }),
      row({ kind: "change", part: "created", outcome: "applied", actor_kind: "desktop", actor_label: "Keepr desktop", effective_at: "-infinity", old_value: null, new_value: { title: { rev: 1, value: "Appraisal" } } }),
    ];
    const I3_ROWS = [
      row({ kind: "change", part: "removed", outcome: "restored", actor_kind: "cloud_user", actor_label: "Keepr", old_value: { kind: "item", removed_at: "2026-11-18T05:01:13.502342+00:00" }, new_value: null }),
      row({ kind: "change", part: "removed", outcome: "removed", actor_kind: "ai_app", actor_label: "Claude", old_value: { kind: null, removed_at: null }, new_value: { kind: "item" } }),
    ];
    const I1_ROWS = [
      row({ kind: "change", part: "title", outcome: "applied", actor_kind: "desktop", actor_label: "Keepr desktop", effective_at: "-infinity", old_value: "Inspection", new_value: "Inspection report" }),
      row({ kind: "change", part: "done", outcome: "applied", actor_kind: "ai_app", actor_label: "Claude", old_value: { checked_at: null, is_checked: false }, new_value: { checked_at: "2026-11-18T05:01:13.354072+00:00", is_checked: true } }),
      row({ kind: "change", part: "note", outcome: "unchanged", actor_kind: "desktop", actor_label: "Keepr desktop", old_value: "a", new_value: "a" }),
      row({ kind: "change", part: "order", outcome: "applied", actor_kind: "desktop", actor_label: "Keepr desktop", old_value: 0, new_value: 1 }),
    ];
    const cloudIdOf = (db: TestDb, id: string) => (db.prepare("SELECT cloud_id FROM cloud_sync_todo_state WHERE local_id = ?").get(id) as { cloud_id: string }).cloud_id;

    it("a lost concurrent edit shows once, the right way round and not kept; the conflict row is not listed; an add shows as added", async () => {
      const { db, e, s } = await synced();
      e.server.history.set(cloudIdOf(db, I2), I2_ROWS);
      const got = await s.history(I2);
      expect(got).toEqual({
        success: true,
        rows: [
          { who: "You, on a computer", at: "2026-11-18T05:01:13.400Z", what: "changed", part: "note", oldText: "from ai", newText: "from desk", kept: false },
          { who: "Claude", at: "2026-11-18T05:01:13.400Z", what: "changed", part: "note", oldText: "start", newText: "from ai", kept: true },
          { who: "You, on a computer", at: "2026-11-18T05:01:13.400Z", what: "added", part: null, oldText: null, newText: null, kept: true },
        ],
      });
    });

    it("a removal and a restore read as removed and restored, by who did them", async () => {
      const { db, e, s } = await synced();
      e.server.history.set(cloudIdOf(db, I2), I3_ROWS);
      expect((await s.history(I2)).rows.map((r) => [r.what, r.who])).toEqual([["restored", "You"], ["removed", "Claude"]]);
    });

    it("BACKLOG-4263: history names every actor kind: cloud_user reads You, the others as before", async () => {
      // historyWho over every value cloud_todo_history.actor_kind can hold (CHECK desktop | cloud_user | ai_app,
      // migration 20261118110000 :174), plus null and an unknown kind.
      expect(historyWho("cloud_user", "Keepr")).toBe("You");
      expect(historyWho("desktop", "Keepr desktop")).toBe("You, on a computer");
      expect(historyWho("ai_app", "Claude")).toBe("Claude");
      expect(historyWho("ai_app", "")).toBe("an AI app");
      expect(historyWho("ai_app", null)).toBe("an AI app");
      expect(historyWho("ai_app", "x".repeat(61))).toBe("an AI app");
      expect(historyWho("other_kind", "x")).toBe("another device");
      expect(historyWho(null, null)).toBe("another device");
    });

    it("an unknowable clock falls back to the time the server received it; ticks read as ticked; unchanged and order rows are not listed", async () => {
      const { db, e, s } = await synced();
      e.server.history.set(cloudIdOf(db, I1), I1_ROWS);
      const rows = (await s.history(I1)).rows;
      expect(rows.map((r) => [r.part, r.at, r.oldText, r.newText])).toEqual([
        ["title", "2026-11-18T05:01:13.400Z", "Inspection", "Inspection report"],
        ["done", "2026-11-18T05:01:13.400Z", "not ticked", "ticked"],
      ]);
    });

    it("asks the server for 50 rows and shows at most 20; offline: no call and the offline answer", async () => {
      const { db, e, s } = await synced();
      e.server.history.set(cloudIdOf(db, I1), Array.from({ length: 30 }, () => I1_ROWS[0]));
      expect((await s.history(I1)).rows).toHaveLength(20);
      expect(e.server.callsTo("cloud_todo_history").at(-1)!.args.p_limit).toBe(50);
      e.online.value = false;
      const n = calls(e, "cloud_todo_history");
      expect(await s.history(I1)).toEqual({ success: false, error: "offline", rows: [] });
      expect(calls(e, "cloud_todo_history")).toBe(n);
    });
  });

  // ================================================================ REM
  describe("REM: recently removed todos", () => {
    async function removedOnline() {
      const ctx = await synced();
      ctx.e.server.removeOnline(onlineItem(ctx.e, I2));
      await pass(ctx.e);
      expect(item(ctx.db, I2)).toBeUndefined();
      return ctx;
    }

    it("lists this deal's removed todo; Restore goes through the server and the todo comes back by the pull, once, with nothing created online", async () => {
      const { db, deal, e, s } = await removedOnline();
      const listed = await s.listRemovedTodos(deal);
      expect(listed).toEqual({ success: true, items: [expect.objectContaining({ entity: "item", cloudId: onlineItem(e, I2).id, title: "Call lender" })] });
      const todosOnline = e.server.todos.length;
      const pushes = e.server.callsTo("cloud_todo_push").length;
      expect(await s.restoreTodo(deal, "item", onlineItem(e, I2).id)).toEqual({ success: true });
      expect(e.server.callsTo("cloud_todo_restore").at(-1)!.args).toMatchObject({ p_entity: "item", p_id: onlineItem(e, I2).id });
      expect(item(db, I2)).toMatchObject({ title: "Call lender", checklist_id: MY });
      expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items WHERE title = 'Call lender'").get() as { n: number }).n).toBe(1);
      expect(e.server.todos.length).toBe(todosOnline);
      const created = e.server.callsTo("cloud_todo_push").slice(pushes).flatMap((c) => c.args.p_ops as Array<Record<string, JsonValue>>).filter((o) => String(o.kind).startsWith("create"));
      expect(created).toEqual([]);
      expect(outbox(db)).toEqual([]);
      expect((await s.listRemovedTodos(deal)).items).toEqual([]);
    });

    it("a My item removed on this computer: listed, restored through the server, back once with nothing queued to send", async () => {
      const { db, deal, e, s } = await synced();
      const cloudId = onlineItem(e, I2).id;
      db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I2, deal, MY_ITEMS_TEMPLATE_ID);
      await pass(e);
      expect(onlineItem(e, I2).removed).toBe(true);
      expect((await s.listRemovedTodos(deal)).items.map((i) => [i.entity, i.cloudId])).toEqual([["item", cloudId]]);
      expect(await s.restoreTodo(deal, "item", cloudId)).toEqual({ success: true });
      expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items WHERE id = ?").get(I2) as { n: number }).n).toBe(1);
      expect(outbox(db)).toEqual([]);
      expect(onlineItem(e, I2).removed).toBe(false);
    });

    it("a template checklist removed on this computer: listed, restored, back once with its items, nothing queued to send", async () => {
      const { db, deal, e, s } = await synced();
      const cloudId = onlineList(e, CL).id;
      db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL, deal);
      await pass(e);
      expect(item(db, I1)).toBeUndefined();
      expect((await s.listRemovedTodos(deal)).items.map((i) => [i.entity, i.cloudId])).toEqual([["checklist", cloudId]]);
      expect(await s.restoreTodo(deal, "checklist", cloudId)).toEqual({ success: true });
      expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_checklists WHERE id = ?").get(CL) as { n: number }).n).toBe(1);
      expect(item(db, I1)).toMatchObject({ title: "Inspection", checklist_id: CL });
      expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items WHERE checklist_id = ?").get(CL) as { n: number }).n).toBe(1);
      await pass(e);
      expect(outbox(db)).toEqual([]);
    });

    it("offline: the list and the restore answer offline and call nothing", async () => {
      const { deal, e, s } = await removedOnline();
      e.online.value = false;
      const n = e.server.calls.length;
      expect(await s.listRemovedTodos(deal)).toMatchObject({ success: false, error: "offline" });
      expect(await s.restoreTodo(deal, "item", onlineItem(e, I2).id)).toEqual({ success: false, error: "offline" });
      expect(e.server.calls.length).toBe(n);
    });

    it("a locked deal: refused, no restore call", async () => {
      const { db, deal, e, s } = await removedOnline();
      db.prepare("UPDATE transactions SET submission_status = 'submitted' WHERE id = ?").run(deal);
      expect(await s.restoreTodo(deal, "item", onlineItem(e, I2).id)).toEqual({ success: false, error: "locked" });
      expect(calls(e, "cloud_todo_restore")).toBe(0);
    });

    it("an id main does not list for this deal is refused: no restore call", async () => {
      const { deal, e, s } = await removedOnline();
      expect(await s.restoreTodo(deal, "item", onlineItem(e, I1).id)).toEqual({ success: false, error: "not_found" });
      expect(await s.restoreTodo(dealId(), "item", onlineItem(e, I2).id)).toEqual({ success: false, error: "not_found" });
      expect(calls(e, "cloud_todo_restore")).toBe(0);
    });

    it("second actor: restored from this computer while an AI app changes the same todo's note: one item here with the AI's note", async () => {
      const { db, deal, e, s } = await removedOnline();
      const t = onlineItem(e, I2);
      // the AI's change between the restore and the pull that brings the todo back
      const realKick = (s as unknown as { deps: { kick: () => Promise<unknown> } }).deps.kick;
      (s as unknown as { deps: { kick: () => Promise<unknown> } }).deps.kick = async () => {
        expect(e.server.aiSet(t, "note", "AI note after restore")).toBe("applied");
        return realKick();
      };
      expect(await s.restoreTodo(deal, "item", t.id)).toEqual({ success: true });
      expect(item(db, I2)).toMatchObject({ title: "Call lender", note: "AI note after restore" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items WHERE checklist_id = ?").get(MY) as { n: number }).n).toBe(1);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(onlineItem(e, I2).parts.note.value).toBe("AI note after restore");
    });
  });

  // ================================================================ DEAL
  describe("DEAL: Settings › Removed online", () => {
    it("a deal removed online and not on this computer is restorable here (Online only); a rejected deal here says so; one still here is not listed", async () => {
      const { db, e, s } = await synced();
      const other = { id: fid(60, 1), owner: USER_A, install: fid(98, 1), localId: "elsewhere", hash: "h", version: 1, fullSyncAt: null, removedKind: "deal" as const, address: "9 Elsewhere Road" };
      e.server.softRemovedDeals.push(other);
      const rejected = dealId();
      insertDeal(db, rejected, USER_A);
      await pass(e);
      const cloudRejected = e.server.deals.find((d) => d.localId === rejected)!;
      db.prepare("UPDATE transactions SET detection_status = 'rejected' WHERE id = ?").run(rejected);
      e.server.deals = e.server.deals.filter((d) => d !== cloudRejected);
      e.server.softRemovedDeals.push({ ...cloudRejected, removedKind: "deal", address: "3 Rejected Lane" });
      const live = dealId();
      insertDeal(db, live, USER_A);
      await pass(e);
      const cloudLive = e.server.deals.find((d) => d.localId === live)!;
      e.server.deals = e.server.deals.filter((d) => d !== cloudLive);
      e.server.softRemovedDeals.push({ ...cloudLive, removedKind: "deal" });

      const got = await s.listRemovedOnline();
      expect(got.success).toBe(true);
      expect(got.deals.map((d) => [d.propertyAddress, d.kind]).sort()).toEqual([["3 Rejected Lane", "rejected"], ["9 Elsewhere Road", "online"]]);
      expect(await s.restoreOnlineDeal(cloudRejected.id)).toEqual({ success: false, error: "not_found" });
      expect(await s.restoreOnlineDeal(other.id)).toEqual({ success: true });
      expect(e.server.deals.map((d) => d.id)).toContain(other.id);
      expect(e.server.history.get(other.id)![0]).toMatchObject({ outcome: "restored", actor_kind: "cloud_user" });
    });

    it("a deal of this computer that main cannot map (its install listing fails) is never offered for restore", async () => {
      const { db, e, s } = await synced();
      const gone = dealId();
      insertDeal(db, gone, USER_A);
      await pass(e);
      const cloud = e.server.deals.find((d) => d.localId === gone)!;
      db.prepare("UPDATE transactions SET detection_status = 'rejected' WHERE id = ?").run(gone);
      await pass(e);
      expect(e.server.softRemovedDeals.map((d) => d.id)).toContain(cloud.id);
      e.server.override = (fn) => (fn === "cloud_list_install_rows" ? { data: null, error: { code: "network" }, status: 500 } : undefined);
      expect((await s.listRemovedOnline()).deals).toEqual([]);
      e.server.override = null;
      expect((await s.listRemovedOnline()).deals.map((d) => d.kind)).toEqual(["rejected"]);
    });

    it("a deal from this computer restored online only: nothing shows as a change that could not be applied", async () => {
      const { db, deal, e, s } = await synced();
      // deleted here without an archive (an older Keepr): removed online by the next pass
      db.prepare("DELETE FROM transactions WHERE id = ?").run(deal);
      await pass(e);
      const listed = await s.listRemovedOnline();
      expect(listed.deals.map((d) => d.kind)).toEqual(["online"]);
      expect(await s.restoreOnlineDeal(listed.deals[0].cloudId)).toEqual({ success: true });
      await pass(e);
      // observed on this path: its todos keep their shadow, so the pull skips them (deal not here); none is parked
      const parked = db.prepare("SELECT error_code FROM cloud_sync_todo_parked").all() as Row[];
      expect(parked.filter((p) => p.error_code !== "deal_unknown")).toEqual([]);
      expect((await e.service.getView()).parked).toBeUndefined();
    });

    it("deals removed with another computer's whole copy are not listed (one Restore would bring every one of them back)", async () => {
      const { e, s } = await synced();
      for (let i = 1; i <= 3; i++) {
        e.server.softRemovedDeals.push({ id: fid(61, i), owner: USER_A, install: fid(98, 2), localId: `old-${i}`, hash: "h", version: 1, fullSyncAt: null, removedKind: "install", address: `${i} Old Copy Road` });
      }
      expect((await s.listRemovedOnline()).deals).toEqual([]);
    });

    it("offline: answers offline and calls nothing", async () => {
      const { e, s } = await synced();
      e.online.value = false;
      const n = e.server.calls.length;
      expect(await s.listRemovedOnline()).toMatchObject({ success: false, error: "offline" });
      expect(e.server.calls.length).toBe(n);
    });
  });

  // ================================================================ EVT
  describe("EVT: cloud-todos:changed", () => {
    it("is reported after a pull that wrote todos here, and not after one that did not", async () => {
      const { e } = await synced();
      const base = e.todosChanged.count;
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base);
      e.server.aiSet(onlineItem(e, I1), "note", "from the phone");
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base + 1);
    });

    // ---- the server answered this computer's own todo changes (fix 7) ----

    it("own note edit: the pass that sends it reports the event once (pull wrote nothing); the next pass does not", async () => {
      const { db, e } = await synced();
      const base = e.todosChanged.count;
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine", I1));
      const r = await e.service.kick();
      expect(r!.todos).toMatchObject({ outcome: "done", confirmed: 1 });
      expect(r!.pull).toMatchObject({ outcome: "done", localWrites: 0 });
      expect(e.todosChanged.count).toBe(base + 1);
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base + 1);
    });

    it("no loop: the reads the screen makes on the event queue no op and write no todo, so the next passes stay silent", async () => {
      const { db, deal, e, s } = await synced();
      const base = e.todosChanged.count;
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine", I1));
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base + 1);
      const todoRows = () => db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all();
      const before = { outbox: outbox(db), items: todoRows() };
      expect(before.outbox).toEqual([]);
      // What the renderer asks on the event: the provider's forDeal, Recently removed, an open History.
      await s.forDeal(deal);
      await s.listRemovedTodos(deal);
      await s.history(I1);
      expect(outbox(db)).toEqual(before.outbox);
      expect(todoRows()).toEqual(before.items);
      const pushes = calls(e, "cloud_todo_push");
      await e.service.kick();
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base + 1);
      expect(calls(e, "cloud_todo_push")).toBe(pushes);
    });

    it("own item removal: answered 'removed', the event is reported and Recently removed lists it", async () => {
      const { db, deal, e, s } = await synced();
      const base = e.todosChanged.count;
      const cloudId = onlineItem(e, I2).id;
      db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I2, deal, MY_ITEMS_TEMPLATE_ID);
      const r = await e.service.kick();
      expect(r!.todos).toMatchObject({ confirmed: 1 });
      expect(r!.pull!.localWrites).toBe(0);
      expect(e.todosChanged.count).toBe(base + 1);
      expect((await s.listRemovedTodos(deal)).items.map((i) => [i.entity, i.cloudId])).toEqual([["item", cloudId]]);
    });

    it("a change the server refused and kept (not_restorable: the item was deleted for good online): the event is reported and the not-kept notice is there", async () => {
      const { db, deal, e, s } = await synced();
      const base = e.todosChanged.count;
      const gone = onlineItem(e, I1);
      gone.removed = true;
      gone.purged = true;
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("too late", I1));
      const r = await e.service.kick();
      expect(r!.todos).toMatchObject({ confirmed: 1, retried: 0 });
      expect(r!.pull!.localWrites).toBe(0);
      expect(e.todosChanged.count).toBe(base + 1);
      expect((await s.forDeal(deal)).notices.map((n) => n.kind)).toContain("not_accepted");
    });

    it("an own edit answered 'lost' (a later change elsewhere won): the event is reported", async () => {
      const { db, e } = await synced();
      const base = e.todosChanged.count;
      const t = onlineItem(e, I1);
      t.parts.note = { rev: t.parts.note.rev + 1, value: "from the phone", at: Date.now() + 60_000, by: "ai_app:conn-1", edit_seq: null };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("desk", I1));
      const r = await e.service.kick();
      expect(r!.todos).toMatchObject({ confirmed: 1 });
      expect(e.todosChanged.count).toBe(base + 1);
    });

    it("answers the server does not keep (not_found, every op): sent but not confirmed, no event on two passes", async () => {
      const { db, e } = await synced();
      const base = e.todosChanged.count;
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("mine", I1));
      // Answer shape as helpers/fakeServer.ts documents for a not-kept status ({op_id, status}); not_found reaches a desktop op.
      e.server.override = (fn, args) =>
        fn === "cloud_todo_push"
          ? { data: { ok: true, results: (args.p_ops as Array<Record<string, JsonValue>>).map((op) => ({ op_id: op.op_id, entity: "item", status: "not_found" })) }, error: null, status: 200 }
          : undefined;
      const r1 = await e.service.kick();
      expect(r1!.todos).toMatchObject({ sent: 1, retried: 1, confirmed: 0 });
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base);
      expect(outbox(db)).toHaveLength(1);
      e.server.override = null;
    });

    it("after-pull send on a deal locked here: the held op is answered once, one event, then the passes stay silent", async () => {
      const { db, deal, e } = await synced();
      db.prepare("UPDATE transactions SET submission_status = 'submitted' WHERE id = ?").run(deal);
      e.server.aiSet(onlineItem(e, I1), "note", "ai during review");
      const base = e.todosChanged.count;
      const r = await e.service.kick();
      expect(r!.pull!.held).toBeGreaterThan(0);
      expect(r!.todosAfterPull).toMatchObject({ confirmed: 1 });
      expect(e.todosChanged.count).toBe(base + 1);
      const pushes = calls(e, "cloud_todo_push");
      await e.service.kick();
      await e.service.kick();
      expect(e.todosChanged.count).toBe(base + 1);
      expect(outbox(db)).toEqual([]);
      expect(calls(e, "cloud_todo_push")).toBe(pushes);
    });

    describe("sweep over the pass summary (shapes taken from a real pass, counts set per case)", () => {
      const cases: Array<[string, { pullWrites: number; first?: number; afterPull?: number; outcome?: "done" | "stopped" }, number]> = [
        ["first send only", { pullWrites: 0, first: 1 }, 1],
        ["after-pull send only", { pullWrites: 0, first: 0, afterPull: 1 }, 1],
        ["both sends", { pullWrites: 0, first: 2, afterPull: 1 }, 1],
        ["neither (both sends ran, nothing confirmed)", { pullWrites: 0, first: 0, afterPull: 0 }, 0],
        ["pull wrote locally only", { pullWrites: 1, first: 0 }, 1],
        ["a stopped pass with no todosAfterPull, its first send confirmed", { pullWrites: 0, first: 1, outcome: "stopped" }, 1],
        ["a stopped pass with no todosAfterPull, nothing confirmed", { pullWrites: 0, first: 0, outcome: "stopped" }, 0],
      ];
      it.each(cases)("%s", async (_name, c, events) => {
        const { db, e } = await synced();
        db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("shape", I1));
        const real = await pass(e);
        expect(real.todos).toBeDefined();
        expect(real.pull).toBeDefined();
        const summary = {
          ...real,
          outcome: c.outcome ?? real.outcome,
          todos: { ...real.todos!, confirmed: c.first ?? 0 },
          pull: { ...real.pull!, localWrites: c.pullWrites },
          todosAfterPull: c.afterPull === undefined ? undefined : { ...real.todos!, confirmed: c.afterPull },
        };
        if (c.afterPull === undefined) delete (summary as { todosAfterPull?: unknown }).todosAfterPull;
        const base = e.todosChanged.count;
        jest.spyOn(e.service.runner!, "runPass").mockResolvedValueOnce(summary);
        await e.service.kick();
        expect(e.todosChanged.count).toBe(base + events);
      });
    });
  });

  // ================================================================ OFFPULL
  describe("OFFPULL: turn-off pulls once first", () => {
    it("an AI change made online before the turn-off reaches this computer; then the online copy goes", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "last change online");
      expect(await e.service.turnOff()).toMatchObject({ success: true });
      expect(item(db, I1)!.note).toBe("last change online");
      expect(e.server.todos).toEqual([]);
    });

    it("SR P4: a last pull whose answer arrives after the turn-off committed writes nothing here", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "slow change online");
      e.server.override = (fn, args) =>
        fn === "cloud_todo_pull"
          ? (new Promise((r) => setTimeout(() => r({ data: e.server.respond(fn, args), error: null, status: 200 }), 3_500)) as never)
          : undefined;
      expect(await e.service.turnOff()).toMatchObject({ success: true });
      expect((db.prepare("SELECT enabled FROM cloud_sync_settings WHERE user_id = ?").get(USER_A) as { enabled: number }).enabled).toBe(0);
      await new Promise((r) => setTimeout(r, 2_000));
      e.server.override = null;
      expect(item(db, I1)!.note).toBeNull();
    }, 20_000);

    it("the wait is bounded: a slow pass (3 s send, then 3 s pull) does not hold the turn-off for both", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("unsent", I1));
      const slow = (fn: string, args: Record<string, JsonValue>) =>
        new Promise((r) => setTimeout(() => r({ data: e.server.respond(fn, args), error: null, status: 200 }), 3_000)) as never;
      e.server.override = (fn, args) => (fn === "cloud_todo_push" || fn === "cloud_todo_pull" ? slow(fn, args) : undefined);
      const t = Date.now();
      await e.service.turnOff();
      const took = Date.now() - t;
      e.server.override = null;
      expect(took).toBeLessThan(5_500);
    }, 20_000);

    it("offline: no pull is tried and the turn-off is not held up", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "not reachable");
      e.online.value = false;
      const pulls = calls(e, "cloud_todo_pull");
      await e.service.turnOff();
      expect(calls(e, "cloud_todo_pull")).toBe(pulls);
      expect(item(db, I1)!.note).toBeNull();
    });
  });

  // ================================================================ ORPHORDER
  describe("ORPHORDER: deals already found restored take no check slot", () => {
    it("with 21 restored deals ahead of it, a plain online-only deal is still deleted by Delete them", async () => {
      const { db, e } = await synced();
      const install = e.server.deals[0].install;
      for (let i = 1; i <= 22; i++) {
        const id = fid(72, i);
        e.server.deals.push({ id, owner: USER_A, install, localId: `gone-${String(i).padStart(2, "0")}`, hash: "h", version: 1, fullSyncAt: null, changeSeq: e.server.nextSeq(USER_A) });
        if (i <= 21) e.server.history.set(id, [{ kind: "change", part: "removed", outcome: "restored", actor_kind: "cloud_user", actor_label: "Keepr" }]);
      }
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      expect(await e.service.deleteOnlineNotHere()).toEqual({ success: true });
      const online = new Set(e.server.deals.map((d) => d.id));
      expect(online.has(fid(72, 22))).toBe(false);
      for (let i = 1; i <= 21; i++) expect([i, online.has(fid(72, i))]).toEqual([i, true]);
    });
  });

  // ================================================================ PARK
  describe("PARK: the view's parked counts", () => {
    it("counts rows waiting for a locked deal apart from the rest", async () => {
      const { db, e } = await synced();
      const ins = db.prepare(
        "INSERT INTO cloud_sync_todo_parked (project_ref, owner_user_id, entity, cloud_id, change_seq, row_json, error_code, attempts, parked_at) VALUES (?, ?, 'item', ?, 1, '{}', ?, 1, '2026-11-18T00:00:00Z')",
      );
      ins.run(PROJECT, USER_A, "c1", "deal_locked");
      ins.run(PROJECT, USER_A, "c2", "deal_locked");
      ins.run(PROJECT, USER_A, "c3", "local_id_conflict");
      // a todo of a deal that is not on this computer is not something waiting here
      ins.run(PROJECT, USER_A, "c4", "deal_unknown");
      expect((await e.service.getView()).parked).toEqual({ locked: 2, other: 1 });
    });
  });
});

// ================================================================ WRITER
describe("WRITER: changed_json (v84)", () => {
  const root = path.join(__dirname, "..", "..", "..", "..");
  const files = (dir: string): string[] =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
      const rel = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === "__tests__" || d.name === "node_modules" ? [] : files(rel);
      return /\.(ts|tsx|sql)$/.test(d.name) && !/\.test\./.test(d.name) ? [rel] : [];
    });
  const naming = (dir: string) => files(dir).filter((f) => fs.readFileSync(path.join(root, f), "utf8").includes("changed_json"));

  it("only the schema, the v84 migration, the puller (the one value writer), the confirm path (clears only) and the read-only screens module name it; the renderer never does", () => {
    const named = naming("electron").sort();
    // positive control: the sweep reads the puller itself
    expect(named).toContain(path.join("electron", "services", "db", "cloudSyncTodoPullDb.ts"));
    expect(named).toEqual(
      [
        "electron/database/schema.sql",
        "electron/services/db/cloudSyncTodoDbService.ts",
        "electron/services/db/cloudSyncTodoPullDb.ts",
        "electron/services/db/cloudSyncTodoScreensDb.ts",
        "electron/services/db/cloudSyncTodoSql.ts",
        "electron/services/db/migrationV84Sql.ts",
        "electron/services/cloudSync/todoScreens.ts",
        "electron/services/databaseService.ts",
      ].sort().map((f) => f.split("/").join(path.sep)),
    );
    expect(naming("src")).toEqual([]);
    const text = (f: string) => fs.readFileSync(path.join(root, "electron", "services", "db", f), "utf8");
    // the screens module only reads it; the confirm path only writes NULL
    // code lines (not comments) that name it: in the screens modules none of them writes it
    const codeLines = (src: string) => src.split("\n").filter((l) => l.includes("changed_json") && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    const writes = (l: string) => /UPDATE|INSERT|SET\s/.test(l);
    expect(codeLines(text("cloudSyncTodoScreensDb.ts")).length).toBeGreaterThan(0);
    expect(codeLines(text("cloudSyncTodoScreensDb.ts")).filter(writes)).toEqual([]);
    const main = fs.readFileSync(path.join(root, "electron", "services", "cloudSync", "todoScreens.ts"), "utf8");
    expect(codeLines(main).filter(writes)).toEqual([]);
    expect(text("cloudSyncTodoDbService.ts").match(/changed_json = [^,\s]+/g)).toEqual(["changed_json = NULL"]);
  });
});
