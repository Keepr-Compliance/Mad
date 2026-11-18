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
import { CloudTodoScreens } from "../todoScreens";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
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

  // ================================================================ NOTE
  describe("NOTE: notices", () => {
    async function withConflict() {
      const ctx = await synced();
      const { db, e } = ctx;
      e.server.connections = [{ id: "conn-1", client_name: "Claude", provider: "anthropic", redirect_host: "claude.ai", consented_at: "2026-11-01T00:00:00Z", last_used_at: null }];
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("mine, older", I1);
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
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(got.notices[0].otherValue as string, I1);
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

  // ================================================================ HIST
  describe("HIST: history", () => {
    it("online: the last changes in the user's words; offline: no call and the offline answer", async () => {
      const { db, e, s } = await synced();
      e.server.connections = [{ id: "conn-1", client_name: "ChatGPT", provider: "openai", redirect_host: "chatgpt.com", consented_at: "2026-11-01T00:00:00Z", last_used_at: null }];
      const cloudId = (db.prepare("SELECT cloud_id FROM cloud_sync_todo_state WHERE local_id = ?").get(I1) as { cloud_id: string }).cloud_id;
      e.server.history.set(cloudId, [
        { part: "note", old_value: "a", new_value: "b", outcome: "applied", actor_kind: "ai_app", actor_ref: "conn-1", actor_label: "ChatGPT", effective_at: "2026-11-18T10:00:00Z" },
        { part: "done", old_value: { is_checked: false }, new_value: { is_checked: true }, outcome: "lost", actor_kind: "desktop", actor_ref: INSTALL, actor_label: null, effective_at: "2026-11-18T09:00:00Z" },
      ] as Array<Record<string, JsonValue>>);
      expect(await s.history(I1)).toEqual({
        success: true,
        rows: [
          { who: "ChatGPT", at: "2026-11-18T10:00:00Z", part: "note", oldText: "a", newText: "b", kept: true },
          { who: "this computer", at: "2026-11-18T09:00:00Z", part: "done", oldText: "not ticked", newText: "ticked", kept: false },
        ],
      });
      expect(e.server.callsTo("cloud_todo_history").at(-1)!.args.p_limit).toBe(20);
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
