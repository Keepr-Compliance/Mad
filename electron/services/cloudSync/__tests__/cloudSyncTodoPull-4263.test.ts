/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-4b — the todo puller (todos/puller.ts) and the page applier (db/cloudSyncTodoPullDb.ts),
 * driven through the real runner pass, the real capture triggers and the app's own checklist statements. The
 * server is the fake (helpers/fakeServer.ts): its cloud_todo_pull and the calls around it are transcribed from
 * migration 20261118110000 and checked against the real functions (supabase/tests/backlog-4263-pr4b/harness-4b.sql).
 *
 *   APPLY   another side's change reaches the local row and the shadow; nothing echoes back as an op (W10)
 *   PEND    a part waiting in the outbox is never overwritten by a pull (W2); removal while a local edit waits (W26)
 *   REM     removed online -> deleted here and archived (D7); restored -> created again with its links (W35);
 *           a checklist's items come back with it; purged -> gone; new online -> created here, never sent back (W5)
 *   PARK    a child before its parent is parked and applied in the same pull (PR-2 review carry list); a deal that
 *           is not on this computer is skipped
 *   ACID    the page and its cursor pair commit together (W4); a crash between pages resumes from the stored
 *           cursor with its horizon; a re-delivered page applies to the same result; a user edit during a pull
 *           call still records its op (C24)
 *   CUR     the cursor pair (next_after, horizon); resync applies nothing from its answer (W22)
 *   LOCK    another side's change on a locked deal: held_locked
 *   EVT     conflict events become notices once
 *   R3      the rewound counter is raised from install_max_edit_seq; rewound_at clears when no restore pull is owed
 *   LOOP    ops of a todo whose create was answered with a kept refusal are dropped, not resent
 *   LWF     a failed local write-back is re-applied before the scan
 *   W28     install_removed: persisted per user, no calls, once-per-launch status check, reclaim for this user only
 *   ORPH    the Settings orphan count skips deals removed online
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, USER_A, USER_B } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { FakeServer, type FakeTodo } from "./helpers/fakeServer";
import { enableForUser, preparePass, reclaimInstallForUser } from "../../db/cloudSyncDbService";
import * as todos from "../../db/cloudSyncTodoDbService";
import { applyTodoPage } from "../../db/cloudSyncTodoPullDb";
import * as todosPull from "../../db/cloudSyncTodoPullDb";
import { MAX_BYTES_PER_CALL, MAX_OPS_PER_CALL } from "../todos/sender";
import { prepareRestoredFile } from "../../db/cloudSyncTriggers";
import { pullTodos } from "../todos/puller";
import { CloudClient, type RpcTransport } from "../cloudClient";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import { INSERT_CHECKLIST_ITEM_SQL, INSERT_CHECKLIST_SQL, INSERT_PRIVATE_CHECKLIST_SQL, SET_CHECKLIST_ITEM_CHECKED_SQL, SET_CHECKLIST_ITEM_NOTE_SQL } from "../../db/checklistSql";
import type { JsonValue } from "../jcs";

type Row = Record<string, unknown>;
const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const INSTALL = fid(98, 4263);
const CL = fid(3, 1);
const MY = fid(3, 2);
const I1 = fid(4, 1);
const I2 = fid(4, 2);

const outbox = (db: TestDb, user = USER_A) =>
  db.prepare("SELECT * FROM cloud_sync_todo_outbox WHERE owner_user_id = ? ORDER BY entity, local_id, part").all(user) as Row[];
const shadow = (db: TestDb, localId: string) => db.prepare("SELECT * FROM cloud_sync_todo_state WHERE local_id = ?").get(localId) as Row | undefined;
const item = (db: TestDb, id: string) => db.prepare("SELECT * FROM transaction_checklist_items WHERE id = ?").get(id) as Row | undefined;
const n = (db: TestDb, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const pushes = (e: Engine) => e.server.callsTo("cloud_todo_push");
const pulls = (e: Engine) => e.server.callsTo("cloud_todo_pull");
const allOps = (e: Engine) => pushes(e).flatMap((c) => c.args.p_ops as Array<Record<string, JsonValue>>);
const onlineItem = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "item" && t.localId === local) as FakeTodo;
const onlineList = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "checklist" && t.localId === local) as FakeTodo;
const cursor = (db: TestDb, user = USER_A) => todos.getTodoCursor(db, PROJECT, user);

function setTransport(e: Engine, t: RpcTransport): void {
  (e.service as unknown as { deps: { client: { transport: RpcTransport } } }).deps.client.transport = t;
}

function profile(): { db: TestDb; deal: string } {
  const db = freshDb();
  db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, NULL, '2026-11-01T00:00:00.000Z')").run(PROJECT, INSTALL);
  const deal = dealId();
  insertDeal(db, deal, USER_A);
  db.prepare(INSERT_CHECKLIST_SQL).run(CL, deal, "tpl-1", "Purchase", 0);
  db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(MY, deal, MY_ITEMS_TEMPLATE_ID, "My items", 1);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I1, CL, "Inspection", null, 1, "inspection", 0);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I2, MY, "Call lender", null, 0, null, 0);
  enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
  return { db, deal };
}

function engine(db: TestDb, server?: FakeServer, user = USER_A): Engine {
  const e = makeEngine(db, { server, user });
  Object.defineProperty(e.clock, "now", { get: () => new Date(), set: () => undefined, configurable: true });
  e.server.serverNow = () => Date.now();
  return e;
}

/** Turned on, one pass: everything online, the full pull done. */
async function synced(): Promise<{ db: TestDb; deal: string; e: Engine }> {
  const { db, deal } = profile();
  const e = engine(db);
  await startAndPass(e);
  expect(outbox(db)).toEqual([]);
  expect(cursor(db)).toMatchObject({ full_pull_owed: 0 });
  expect(e.server.todos).toHaveLength(4);
  return { db, deal, e };
}

/** A local edit that the capture triggers do not see (as a restored file or a missed change would hold it). */
function quietly(db: TestDb, fn: () => void): void {
  db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, 'x')").run();
  fn();
  db.exec("DELETE FROM cloud_sync_applying");
}

describe(`Keepr Cloud todo puller [${DRIVER}]`, () => {
  // ================================================================ APPLY
  describe("APPLY: another side's change", () => {
    it("an AI change to a part reaches the local row and the shadow in the next pass; no op echoes back (W10)", async () => {
      const { db, e } = await synced();
      const t = onlineItem(e, I1);
      expect(e.server.aiSet(t, "note", "from the phone")).toBe("applied");
      expect(e.server.aiSet(t, "done", { is_checked: true, checked_at: "2026-11-17T04:05:08.266Z" })).toBe("applied");
      const before = pushes(e).length;
      await pass(e);
      expect(item(db, I1)).toMatchObject({ note: "from the phone", is_checked: 1 });
      expect(shadow(db, I1)).toMatchObject({ note_rev: t.parts.note.rev, done_rev: t.parts.done.rev, note_json: JSON.stringify("from the phone") });
      expect(outbox(db)).toEqual([]);
      expect(pushes(e)).toHaveLength(before);
      await pass(e);
      expect(pushes(e)).toHaveLength(before);
    });

    it("this computer's own change comes back with the rev the answer already gave: nothing is written locally and no op is made", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("mine", I1);
      const r = await pass(e);
      expect(onlineItem(e, I1).parts.note.value).toBe("mine");
      expect(r.pull).toMatchObject({ outcome: "done", localWrites: 0 });
      expect(r.pull!.rows).toBeGreaterThan(0);
      expect(outbox(db)).toEqual([]);
    });
  });

  // ================================================================ PEND
  describe("PEND: a waiting local part is never overwritten (W2, W26)", () => {
    it("a part whose op is still waiting keeps the local value and the shadow's rev while another side's change to it is pulled; the server then judges the op", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("local, waiting", I1);
      const shadowRev = shadow(db, I1)!.note_rev;
      e.server.aiSet(onlineItem(e, I1), "note", "from the phone", Date.now() - 60_000);
      e.server.aiSet(onlineItem(e, I1), "title", "Inspection report");
      // the push answers `locked` (not kept by the server: retried), so the op stays waiting through the pull
      e.server.override = (fn, args) =>
        fn === "cloud_todo_push"
          ? { data: { ok: true, results: (args.p_ops as Array<Record<string, JsonValue>>).map((o) => ({ op_id: o.op_id, status: "locked" })) }, error: null, status: 200 }
          : undefined;
      await pass(e);
      expect(item(db, I1)).toMatchObject({ note: "local, waiting", title: "Inspection report" });
      expect(shadow(db, I1)!.note_rev).toBe(shadowRev);
      expect(outbox(db).map((r) => `${r.local_id}:${r.part}`)).toEqual([`${I1}:note`]);
      e.server.override = null;
      await pass(e);
      // the local edit was made after the phone's: it wins by time, everywhere
      expect(onlineItem(e, I1).parts.note.value).toBe("local, waiting");
      expect(item(db, I1)!.note).toBe("local, waiting");
      expect(outbox(db)).toEqual([]);
    });

    it("W26: an AI app removes an item while a local note edit waits: after one pass the item is gone here, its note is in the trash and online (kept for a restore), nothing waits", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("edited offline", I2);
      e.server.removeOnline(onlineItem(e, I2));
      await pass(e);
      expect(item(db, I2)).toBeUndefined();
      const trash = db.prepare("SELECT payload_json FROM cloud_sync_todo_trash WHERE local_id = ?").get(I2) as { payload_json: string };
      expect(JSON.parse(trash.payload_json).item.note).toBe("edited offline");
      expect(onlineItem(e, I2).parts.note.value).toBe("edited offline");
      expect(onlineItem(e, I2).removed).toBe(true);
      expect(outbox(db)).toEqual([]);
    });
  });

  // ================================================================ REM
  describe("REM: removal, restore, purge, new todos", () => {
    function linkEvidence(db: TestDb, itemId: string): void {
      db.prepare("INSERT INTO emails (id, user_id, external_id, source, subject) VALUES (?, ?, 'ext-1', 'gmail', 'Report')").run(fid(9, 1), USER_A);
      db.prepare("INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order) VALUES (?, ?, 'email', 'Report', 0)").run(fid(10, 1), itemId);
      db.prepare("INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)").run(fid(11, 1), fid(10, 1), fid(9, 1));
    }

    it("removed online: deleted here under the guard, archived to the trash with its links (D7), no op; restored online: created again with its pulled values and the links whose evidence still exists (W35)", async () => {
      const { db, e } = await synced();
      linkEvidence(db, I1);
      db.prepare("INSERT INTO messages (id, user_id, channel, direction, body_text, sent_at) VALUES (?, ?, 'sms', 'inbound', 'x', '2026-11-01T00:00:00Z')").run(fid(12, 1), USER_A);
      db.prepare("INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order) VALUES (?, ?, 'text', 'Text', 1)").run(fid(10, 2), I1);
      db.prepare("INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id) VALUES (?, ?, 'text', ?)").run(fid(11, 2), fid(10, 2), fid(12, 1));
      const t = onlineItem(e, I1);
      e.server.removeOnline(t);
      await pass(e);
      expect(item(db, I1)).toBeUndefined();
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash WHERE local_id = ?", I1)).toBe(1);
      expect(outbox(db)).toEqual([]);
      expect(shadow(db, I1)).toMatchObject({ removed_rev: t.parts.removed.rev });
      // the text the second link pointed at is gone before the restore
      db.prepare("DELETE FROM messages WHERE id = ?").run(fid(12, 1));
      e.server.restoreOnline(t);
      e.server.aiSet(t, "note", "changed while removed");
      await pass(e);
      expect(item(db, I1)).toMatchObject({ checklist_id: CL, title: "Inspection", note: "changed while removed", is_required: 1 });
      // SR2 S2: the text link's only evidence is gone, so it does not come back empty; a notice counts it
      expect(db.prepare("SELECT id FROM transaction_checklist_links WHERE item_id = ? ORDER BY id").all(I1)).toEqual([{ id: fid(10, 1) }]);
      expect(db.prepare("SELECT id FROM transaction_checklist_link_members ORDER BY id").all()).toEqual([{ id: fid(11, 1) }]);
      expect(db.prepare("SELECT other_json FROM cloud_sync_todo_notices WHERE kind = 'links_not_restored' AND local_id = ?").all(I1)).toEqual([{ other_json: JSON.stringify({ count: 1 }) }]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash WHERE local_id = ?", I1)).toBe(0);
      expect(outbox(db)).toEqual([]);
      await pass(e);
      expect(outbox(db)).toEqual([]);
    });

    it("a checklist removed online goes here with its items (archived); restored online, it comes back with its items although their rows were not renumbered (observed O5f)", async () => {
      const { db, e } = await synced();
      const cl = onlineList(e, CL);
      e.server.removeOnline(cl);
      await pass(e);
      expect(db.prepare("SELECT id FROM transaction_checklists WHERE id = ?").get(CL)).toBeUndefined();
      expect(item(db, I1)).toBeUndefined();
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash WHERE removed_with = ?", CL)).toBe(1);
      expect(outbox(db)).toEqual([]);
      e.server.restoreOnline(cl);
      await pass(e);
      expect(db.prepare("SELECT template_name FROM transaction_checklists WHERE id = ?").get(CL)).toEqual({ template_name: "Purchase" });
      expect(item(db, I1)).toMatchObject({ checklist_id: CL, title: "Inspection" });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash")).toBe(0);
      expect(outbox(db)).toEqual([]);
    });

    it("purged online: the local row, the shadow and the trash row go", async () => {
      const { db, e } = await synced();
      const t = onlineItem(e, I2);
      e.server.removeOnline(t);
      await pass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash WHERE local_id = ?", I2)).toBe(1);
      e.server.purgeOnline(t);
      await pass(e);
      expect(shadow(db, I2)).toBeUndefined();
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash WHERE local_id = ?", I2)).toBe(0);
      expect(item(db, I2)).toBeUndefined();
    });

    it("a todo added online (an AI app) is created here with the cloud's id, never sent back as a create (W5); a later local tick goes as a set and applies", async () => {
      const { db, e } = await synced();
      const added = e.server.aiAdd(onlineList(e, MY), "Book the movers");
      const before = allOps(e).length;
      await pass(e);
      expect(item(db, added.id)).toMatchObject({ checklist_id: MY, title: "Book the movers", is_checked: 0 });
      expect(shadow(db, added.id)).toMatchObject({ cloud_id: added.id, title_rev: 1 });
      expect(allOps(e)).toHaveLength(before);
      // the daily scan finds nothing to send for it
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, added.id);
      await pass(e);
      expect(allOps(e).slice(before).map((o) => `${o.kind}:${o.part}`)).toEqual(["set:done"]);
      expect((onlineItem(e, added.id).parts.done.value as Row).is_checked).toBe(true);
      expect(e.server.todos.filter((x) => x.entity === "item")).toHaveLength(3);
    });
  });

  // ================================================================ PARK
  describe("PARK: rows that cannot be applied yet", () => {
    it("an item that arrives before its checklist (one row a page) is parked, then applied in the same pull once the checklist arrives; nothing stays parked", async () => {
      const { db, e } = await synced();
      // a new My items list online (the server makes one when an AI app adds to a deal without it) is renumbered
      // after its item, as a later order change would (PR-2 review: child before parent)
      const list: FakeTodo = {
        ...onlineList(e, MY),
        id: fid(97, 1),
        localId: fid(97, 1),
        templateId: "tpl-new",
        fields: { template_name: "Closing", is_private: false },
        changeSeq: e.server.nextSeq(USER_A),
        // migration :674: the server's My items list is created with sort_order NULL
        parts: { ...onlineList(e, MY).parts, order: { rev: 1, value: null, at: Date.now(), by: "ai_app:conn-1", edit_seq: null } },
      };
      e.server.todos.push(list);
      const child = e.server.aiAdd(list, "Final walk-through");
      list.changeSeq = e.server.nextSeq(USER_A);
      expect((child.changeSeq as number) < list.changeSeq).toBe(true);
      const client = new CloudClient(e.server.transport, 5_000);
      const r = await pullTodos({
        db, client, projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: () => new Date(), guard: () => undefined, stopOn: () => undefined, pageSize: 1,
      });
      expect(r.outcome).toBe("done");
      expect(r.parked).toBeGreaterThan(0);
      expect(db.prepare("SELECT template_name FROM transaction_checklists WHERE id = ?").get(list.id)).toEqual({ template_name: "Closing" });
      expect(item(db, child.id)).toMatchObject({ checklist_id: list.id, title: "Final walk-through" });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_parked")).toBe(0);
      expect(outbox(db)).toEqual([]);
    });

    it("a todo of a deal no longer on this computer is skipped (not parked, not created)", async () => {
      const { db, deal, e } = await synced();
      db.prepare("DELETE FROM transactions WHERE id = ?").run(deal);
      await pass(e);
      expect(e.server.softRemovedDeals).toHaveLength(1);
      // a full pull returns the removed deal's todos again
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1, last_seq = 0, horizon = NULL").run();
      const r = await pass(e);
      expect(r.pull).toMatchObject({ outcome: "done", fullPullDone: true, parked: 0, localWrites: 0 });
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_checklist_items")).toBe(0);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_parked")).toBe(0);
    });
  });

  // ================================================================ ACID
  describe("ACID: the page and its cursor pair are one transaction", () => {
    it("W4: a failure at the cursor write rolls the page back: the local row, the shadow and the cursor stay as before, no guard row; the next pass applies the page", async () => {
      const { db, e } = await synced();
      const c0 = cursor(db);
      e.server.aiSet(onlineItem(e, I1), "note", "from the phone");
      const real = db.prepare.bind(db);
      (db as { prepare: unknown }).prepare = (sql: string) => {
        if (sql.startsWith("UPDATE cloud_sync_todo_cursor SET last_seq = ?, horizon = ?")) throw Object.assign(new Error("disk"), { code: "SQLITE_FULL" });
        return real(sql);
      };
      await expect(pass(e)).rejects.toThrow("disk");
      (db as { prepare: unknown }).prepare = real;
      expect(item(db, I1)!.note).toBeNull();
      expect(shadow(db, I1)!.note_json).toBe("null");
      expect(cursor(db)).toEqual(c0);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I2);
      expect(outbox(db).map((r) => r.part)).toEqual(["done"]);
      await pass(e);
      expect(item(db, I1)!.note).toBe("from the phone");
      expect(cursor(db)!.last_seq).toBeGreaterThan(c0!.last_seq);
      expect(outbox(db)).toEqual([]);
    });

    it("a crash between pages: the pages before it stay applied with their (next_after, horizon); the next pull resumes from there and ends equal to an uninterrupted pull; a re-delivered page changes nothing", async () => {
      const { db, e } = await synced();
      await pass(e); // the cursor passes this computer's own creates
      for (const [local, note] of [[I1, "one"], [I2, "two"]] as const) e.server.aiSet(onlineItem(e, local), "note", note);
      e.server.aiAdd(onlineList(e, CL), "Three");
      const c0 = cursor(db)!;
      const client = new CloudClient(e.server.transport, 5_000);
      let calls = 0;
      const flaky = new CloudClient(async (fn, args, signal) => {
        if (fn === "cloud_todo_pull" && ++calls === 2) throw new Error("network");
        return e.server.transport(fn, args, signal);
      }, 5_000);
      const deps = { db, projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: () => new Date(), guard: () => undefined, stopOn: () => undefined, pageSize: 1 };
      const first = await pullTodos({ ...deps, client: flaky });
      expect(first).toMatchObject({ outcome: "failed", pages: 1 });
      const mid = cursor(db)!;
      expect(mid.last_seq).toBeGreaterThan(c0.last_seq);
      expect(mid.horizon).toBe(0);
      expect(item(db, I1)!.note).toBe("one");
      expect(item(db, I2)!.note).toBeNull();
      // the resumed pull sends the stored pair
      const before = pulls(e).length;
      const second = await pullTodos({ ...deps, client });
      expect(second.outcome).toBe("done");
      const sent = e.server.calls.filter((c) => c.fn === "cloud_todo_pull").slice(before);
      expect(sent[0].args).toMatchObject({ p_after_seq: mid.last_seq, p_horizon: mid.horizon });
      expect(item(db, I2)!.note).toBe("two");
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_checklist_items WHERE title = 'Three'")).toBe(1);
      // re-delivery: the same pages from the earlier cursor (a crash after commit, before the next page)
      const snap = JSON.stringify([db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all(), db.prepare("SELECT * FROM cloud_sync_todo_state ORDER BY local_id").all()]);
      db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = ?, horizon = ?").run(c0.last_seq, c0.horizon);
      const again = await pullTodos({ ...deps, client });
      expect(again.outcome).toBe("done");
      expect(again.localWrites).toBe(0);
      const snap2 = JSON.stringify([db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all(), db.prepare("SELECT * FROM cloud_sync_todo_state ORDER BY local_id").all().map((r) => ({ ...(r as Row), updated_at: (JSON.parse(snap)[1] as Row[]).find((x) => x.local_id === (r as Row).local_id)?.updated_at }))]);
      expect(snap2).toBe(snap);
      expect(outbox(db)).toEqual([]);
    });

    it("C24: a user edit made while a pull call is in flight is recorded by the capture trigger (the page is applied after it, synchronously) and sent", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "title", "Inspection (phone)");
      const t = e.server.transport;
      let edited = false;
      setTransport(e, async (fn, args, signal) => {
        if (fn === "cloud_todo_pull" && !edited) {
          edited = true;
          db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("typed during the pull", I1);
        }
        return t(fn, args, signal);
      });
      await pass(e);
      expect(item(db, I1)).toMatchObject({ note: "typed during the pull", title: "Inspection (phone)" });
      expect(outbox(db).map((r) => r.part)).toEqual(["note"]);
      await pass(e);
      expect(onlineItem(e, I1).parts.note.value).toBe("typed during the pull");
      expect(outbox(db)).toEqual([]);
    });
  });

  // ================================================================ CUR
  describe("CUR: the cursor pair and resync", () => {
    it("a full pull starts at 0 without a horizon; every later call sends the stored next_after and horizon; no pass restarts a full pull", async () => {
      const { db, e } = await synced();
      expect(pulls(e)[0].args).toMatchObject({ p_after_seq: 0, p_horizon: null });
      e.server.aiSet(onlineItem(e, I1), "note", "x");
      const r = await pass(e);
      const last = pulls(e).at(-1)!.args;
      expect(last.p_after_seq).toBeGreaterThan(0);
      expect(typeof last.p_horizon).toBe("number");
      expect(r.pull).toMatchObject({ resyncs: 0, fullPullDone: false });
      expect(cursor(db)).toMatchObject({ full_pull_owed: 0, horizon: 0 });
    });

    it("resync_required: nothing of that answer is applied, the cursor goes back to 0 with no horizon and a full pull owed; the full pull then deletes nothing (W22)", async () => {
      const { db, e } = await synced();
      // a todo removed and purged online while this computer's cursor sits below it
      const gone = e.server.aiAdd(onlineList(e, CL), "Temporary");
      await pass(e);
      expect(item(db, gone.id)).toBeDefined();
      const c = cursor(db)!;
      db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = ?").run(c.last_seq - 1);
      e.server.removeOnline(gone);
      e.server.purgeOnline(gone);
      e.server.aiSet(onlineItem(e, I1), "note", "in the resync answer");
      // the answer says resync; the next call fails, so only that answer is seen this pass
      const t = e.server.transport;
      let k = 0;
      setTransport(e, async (fn, args, signal) => {
        if (fn === "cloud_todo_pull" && ++k === 2) throw new Error("network");
        return t(fn, args, signal);
      });
      const r = await pass(e);
      expect(r.pull).toMatchObject({ outcome: "failed", resyncs: 1, pages: 0 });
      expect(item(db, I1)!.note).toBeNull();
      expect(item(db, gone.id)).toBeDefined();
      expect(cursor(db)).toMatchObject({ last_seq: 0, horizon: null, full_pull_owed: 1 });
      setTransport(e, t);
      const r2 = await pass(e);
      expect(r2.pull).toMatchObject({ outcome: "done", fullPullDone: true });
      expect(item(db, I1)!.note).toBe("in the resync answer");
      // the purged todo goes because its row says purged; every other local todo stays
      expect(item(db, gone.id)).toBeUndefined();
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_checklist_items")).toBe(2);
      expect(cursor(db)).toMatchObject({ full_pull_owed: 0 });
    });
  });

  // ================================================================ LOCK
  describe("LOCK: a locked deal (plan §2.4)", () => {
    it("another side's change on a deal locked here is not applied: the shadow takes it and this computer's value is sent back with held_locked, which wins causally", async () => {
      const { db, deal, e } = await synced();
      db.prepare("UPDATE transactions SET submission_status = 'submitted' WHERE id = ?").run(deal);
      e.server.aiSet(onlineItem(e, I1), "note", "ai during review");
      await pass(e);
      expect(item(db, I1)!.note).toBeNull();
      const held = allOps(e).filter((o) => o.held_locked === true);
      expect(held.map((o) => `${o.kind}:${o.part}:${o.local_id}`)).toEqual([`set:note:${I1}`]);
      expect(onlineItem(e, I1).parts.note.value).toBeNull();
      expect(outbox(db)).toEqual([]);
      // unlocked: another side's change applies again
      db.prepare("UPDATE transactions SET submission_status = 'not_submitted' WHERE id = ?").run(deal);
      e.server.aiSet(onlineItem(e, I1), "note", "ai after review");
      await pass(e);
      expect(item(db, I1)!.note).toBe("ai after review");
    });
  });

  // ================================================================ EVT
  describe("EVT: conflict events", () => {
    it("a conflict event becomes one notice; a re-delivered pull adds none", async () => {
      const { db, e } = await synced();
      // a newer phone change, then this computer's older edit of the same part (made before, sent after)
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("mine, older", I1);
      const row = outbox(db)[0];
      db.prepare("UPDATE cloud_sync_todo_outbox SET edited_at = ? WHERE op_id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), row.op_id);
      e.server.aiSet(onlineItem(e, I1), "note", "phone, newer");
      await pass(e);
      expect(item(db, I1)!.note).toBe("phone, newer");
      const notices = () => db.prepare("SELECT entity, local_id, part, kind, actor_kind, change_seq FROM cloud_sync_todo_notices WHERE kind = 'conflict'").all() as Row[];
      expect(notices()).toEqual([{ entity: "item", local_id: I1, part: "note", kind: "conflict", actor_kind: "desktop", change_seq: expect.any(Number) }]);
      const other = JSON.parse((db.prepare("SELECT other_json FROM cloud_sync_todo_notices WHERE kind = 'conflict'").get() as { other_json: string }).other_json);
      expect(other).toMatchObject({ outcome: "lost", loser_value: "mine, older", winner_value: "phone, newer" });
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1, last_seq = 0, horizon = NULL").run();
      await pass(e);
      expect(notices()).toHaveLength(1);
    });
  });

  // ================================================================ R3
  describe("R3: the counter after a restore", () => {
    it("the restore pull raises the rewound counter to install_max_edit_seq and clears rewound_at; the next edit outranks this computer's stored edit_seq", async () => {
      const { db, e } = await synced();
      for (let i = 0; i < 4; i++) {
        db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(`v${i}`, I1);
        await pass(e);
      }
      const stored = onlineItem(e, I1).parts.note.edit_seq as number;
      db.prepare("UPDATE cloud_sync_todo_counter SET edit_seq = 1").run();
      prepareRestoredFile(db);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter WHERE rewound_at IS NOT NULL")).toBe(1);
      await pass(e);
      expect(db.prepare("SELECT edit_seq, rewound_at FROM cloud_sync_todo_counter").get()).toEqual({ edit_seq: stored, rewound_at: null });
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("after the restore", I1);
      expect((outbox(db)[0].edit_seq as number) > stored).toBe(true);
    });

    it("two local users: the counter stays rewound until the second user's restore pull is done too", async () => {
      const { db, e } = await synced();
      const deal = dealId();
      insertDeal(db, deal, USER_B);
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 80), deal, "tpl-b", "B list", 0);
      enableForUser(db, PROJECT, USER_B, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      prepareRestoredFile(db);
      expect(cursor(db, USER_B)).toMatchObject({ full_pull_kind: "restore" });
      await pass(e);
      expect(cursor(db, USER_A)).toMatchObject({ full_pull_owed: 0, full_pull_kind: null });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter WHERE rewound_at IS NOT NULL")).toBe(1);
      const eb = engine(db, new FakeServer(USER_B), USER_B);
      await startAndPass(eb);
      expect(cursor(db, USER_B)).toMatchObject({ full_pull_owed: 0 });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter WHERE rewound_at IS NOT NULL")).toBe(0);
    });
  });

  // ================================================================ LOOP
  describe("LOOP: a create answered with a kept refusal", () => {
    it("the todo's later part and removal ops are dropped with a notice instead of answering not_found every pass, and no later scan queues the create again", async () => {
      const { db, e } = await synced();
      db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 9), CL, "Refused", null, 0, null, 5);
      e.server.override = (fn, args) => {
        if (fn !== "cloud_todo_push") return undefined;
        const ops = args.p_ops as Array<Record<string, JsonValue>>;
        if (!ops.some((o) => o.local_id === fid(4, 9) && o.kind === "create_item")) return undefined;
        return { data: { ok: true, results: ops.map((o) => ({ op_id: o.op_id, status: "rejected", reason: "invalid_value", field: "title" })) }, error: null, status: 200 };
      };
      await pass(e);
      e.server.override = null;
      expect(outbox(db)).toEqual([]);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("note on it", fid(4, 9));
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, fid(4, 9));
      const before = allOps(e).length;
      await pass(e);
      await pass(e);
      expect(allOps(e).slice(before).filter((o) => o.local_id === fid(4, 9))).toEqual([]);
      expect(outbox(db)).toEqual([]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_notices WHERE kind = 'dropped_not_online' AND local_id = ?", fid(4, 9))).toBe(2);
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
    });
  });

  // ================================================================ LWF
  describe("LWF: a failed local write-back (PR-4a review A)", () => {
    it("is re-applied from the shadow before the scan, so the scan never sends the old local value against the matching base", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "the winner");
      await pass(e);
      // as a confirm whose write-back failed leaves it: shadow on the winner, local row on the old value, a notice
      quietly(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("the loser", I1));
      db.prepare(
        "INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, part, kind, created_at) VALUES (?, ?, 'item', ?, 'note', 'local_write_failed', 'x')",
      ).run(PROJECT, USER_A, I1);
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1, last_seq = 0, horizon = NULL").run();
      const before = allOps(e).length;
      await pass(e);
      expect(item(db, I1)!.note).toBe("the winner");
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_notices WHERE kind = 'local_write_failed' AND dismissed_at IS NULL")).toBe(0);
      expect(allOps(e)).toHaveLength(before);
      expect(onlineItem(e, I1).parts.note.value).toBe("the winner");
    });
  });

  // ================================================================ W28
  describe("W28: install_removed (D2, E1)", () => {
    it("user A is stopped (persisted, no server call on later passes); user B on the same computer keeps saving under the same install id; A's reclaim resumes A on the same id; nothing of B changes", async () => {
      const { db, e } = await synced();
      const deal = dealId();
      insertDeal(db, deal, USER_B);
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 80), deal, "tpl-b", "B list", 0);
      enableForUser(db, PROJECT, USER_B, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      const serverB = new FakeServer(USER_B);
      const eb = engine(db, serverB, USER_B);
      await startAndPass(eb);
      expect(serverB.deals.map((d) => d.install)).toEqual([INSTALL]);
      // another computer removes A's copy of this computer
      e.server.respond("cloud_delete_install", { p_expected_user_id: USER_A, p_source_install_id: INSTALL });
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("while removed", I1);
      const r = await pass(e);
      expect(r.outcome).toBe("install_removed");
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).not.toBeNull();
      // the once-per-launch status check, then no call at all
      const calls = e.server.calls.length;
      const r2 = await pass(e);
      expect(r2.outcome).toBe("install_removed");
      expect(e.server.calls.slice(calls).map((c) => c.fn)).toEqual(["cloud_install_status"]);
      const calls2 = e.server.calls.length;
      await pass(e);
      expect(e.server.calls.length).toBe(calls2);
      expect(outbox(db).map((o) => o.part)).toEqual(["note"]);
      // B: unaffected
      expect(todos.installRemovedAt(db, PROJECT, USER_B)).toBeNull();
      db.prepare("UPDATE transaction_checklists SET sort_order = 4 WHERE id = ?").run(fid(3, 80));
      await pass(eb);
      expect(serverB.todos.find((t) => t.localId === fid(3, 80))!.parts.order.value).toBe(4);
      const bState = JSON.stringify(db.prepare("SELECT * FROM cloud_sync_todo_state WHERE owner_user_id = ? ORDER BY local_id").all(USER_B));
      // I3: B's deal records and marks are untouched by A's reclaim
      const bDeals = JSON.stringify([
        db.prepare("SELECT * FROM cloud_sync_state WHERE owner_user_id = ? ORDER BY entity, local_id").all(USER_B),
        db.prepare("SELECT d.* FROM cloud_sync_dirty d JOIN transactions t ON t.id = d.transaction_id WHERE t.user_id = ? ORDER BY d.transaction_id").all(USER_B),
      ]);
      expect(JSON.parse(bDeals)[0].length).toBeGreaterThan(0);
      // B is not stopped: B's reclaim is refused and forgets nothing
      expect(await eb.service.reclaimInstall()).toEqual({ success: false, error: "not_stopped" });
      // A's reclaim: only A's register row, only A's local state; same install id
      const res = await e.service.reclaimInstall();
      expect(res).toEqual({ success: true });
      expect(e.server.removedInstalls.size).toBe(0);
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).toBeNull();
      await e.service.runner!.whenIdle();
      expect(e.server.deals.map((d) => [d.id, d.install])).toHaveLength(1);
      expect(e.server.deals[0].install).toBe(INSTALL);
      expect(e.server.todos.filter((t) => t.entity === "item")).toHaveLength(2);
      expect(JSON.stringify(db.prepare("SELECT * FROM cloud_sync_todo_state WHERE owner_user_id = ? ORDER BY local_id").all(USER_B))).toBe(bState);
      expect(JSON.stringify([
        db.prepare("SELECT * FROM cloud_sync_state WHERE owner_user_id = ? ORDER BY entity, local_id").all(USER_B),
        db.prepare("SELECT d.* FROM cloud_sync_dirty d JOIN transactions t ON t.id = d.transaction_id WHERE t.user_id = ? ORDER BY d.transaction_id").all(USER_B),
      ])).toBe(bDeals);
      expect(db.prepare("SELECT install_id FROM cloud_sync_install").all()).toEqual([{ install_id: INSTALL }]);
    });

    it("the once-per-launch status check resumes a stopped user whose copy was restored elsewhere (no register row), on the same install id", async () => {
      const { db, e } = await synced();
      e.server.respond("cloud_delete_install", { p_expected_user_id: USER_A, p_source_install_id: INSTALL });
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("kept", I1);
      expect((await pass(e)).outcome).toBe("install_removed");
      // restored from another computer: the register row is gone and the deals are live again
      e.server.removedInstalls.clear();
      for (const d of [...e.server.softRemovedDeals]) e.server.respond("cloud_upsert_deal", { p_expected_user_id: USER_A, p_deal: { source_install_id: d.install, local_id: d.localId, content_hash: d.hash } });
      const later = engine(db, e.server); // a new launch
      const r = await startAndPass(later);
      expect(r!.outcome).toBe("done");
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).toBeNull();
      expect(onlineItem(later, I1).parts.note.value).toBe("kept");
    });
  });

  // ================================================================ W27 / W15 / reconcile
  describe("W27, W15 and the reconcile's re-upload", () => {
    it("W27: a pulled checklist of the same template as a local one (other id, no alias online) maps onto the local one; later ops on it and on new items under it name it by cloud id and apply", async () => {
      const { db, deal, e } = await synced();
      // the online My items list is replaced, as an AI app's first add makes one when none is live: another id and
      // local id, no alias for this computer's list
      const old = onlineList(e, MY);
      e.server.todos = e.server.todos.filter((t) => t !== old && t.checklistId !== old.id);
      const fresh: FakeTodo = { ...old, id: fid(97, 7), localId: fid(97, 7), aliases: [], changeSeq: e.server.nextSeq(USER_A) };
      e.server.todos.push(fresh);
      db.prepare("DELETE FROM cloud_sync_todo_state WHERE local_id IN (?, ?)").run(MY, I2);
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1, last_seq = 0, horizon = NULL").run();
      await pass(e);
      expect(db.prepare("SELECT id FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?").all(deal, MY_ITEMS_TEMPLATE_ID)).toEqual([{ id: MY }]);
      expect(shadow(db, MY)).toMatchObject({ cloud_id: fresh.id });
      // a local order change and a new item under the mapped list
      db.prepare("UPDATE transaction_checklists SET sort_order = 9 WHERE id = ?").run(MY);
      db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 20), MY, "Under the mapped list", null, 0, null, 3);
      await pass(e);
      expect(fresh.parts.order.value).toBe(9);
      expect(e.server.todos.find((t) => t.localId === fid(4, 20))).toMatchObject({ checklistId: fresh.id });
      expect(outbox(db)).toEqual([]);
      await pass(e);
      expect(outbox(db)).toEqual([]);
    });

    it("W15: a pulled value the local CHECK refuses parks that row (with its code); the rest of the page applies and the cursor advances; a later valid change applies it and clears the park", async () => {
      const { db, e } = await synced();
      const t = onlineItem(e, I1);
      // a due date outside the local CHECK range (2000-2100)
      t.parts.due = { rev: t.parts.due.rev + 1, value: "1999-12-31", at: Date.now(), by: "ai_app:conn-1", edit_seq: null };
      t.changeSeq = e.server.nextSeq(USER_A);
      e.server.aiSet(onlineItem(e, I2), "note", "applies");
      const c0 = cursor(db)!;
      await pass(e);
      expect(item(db, I2)!.note).toBe("applies");
      expect(item(db, I1)!.due_date).toBeNull();
      expect(db.prepare("SELECT entity, error_code FROM cloud_sync_todo_parked").all()).toEqual([{ entity: "item", error_code: expect.stringMatching(/CONSTRAINT/) }]);
      expect(cursor(db)!.last_seq).toBeGreaterThan(c0.last_seq);
      const attempts = () => (db.prepare("SELECT attempts FROM cloud_sync_todo_parked").get() as { attempts: number }).attempts;
      const a1 = attempts();
      await pass(e);
      expect(attempts()).toBeGreaterThan(a1);
      e.server.aiSet(t, "due", "2026-12-01");
      await pass(e);
      expect(item(db, I1)!.due_date).toBe("2026-12-01");
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_parked")).toBe(0);
      expect(outbox(db)).toEqual([]);
    });

    it("an eligible deal removed online (its record still here) is uploaded again by the daily reconcile, which un-removes it under the same id with its todos", async () => {
      const { db, deal, e } = await synced();
      const id = e.server.deals[0].id;
      e.server.respond("cloud_delete_deal", { p_expected_user_id: USER_A, p_cloud_deal_id: id });
      expect(e.server.softRemovedDeals.map((d) => d.id)).toEqual([id]);
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      expect(e.server.deals.map((d) => [d.id, d.localId])).toEqual([[id, deal]]);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(e.server.todos.filter((t) => t.dealId === id)).toHaveLength(4);
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_checklist_items")).toBe(2);
    });

    it("the once-per-launch status check is spent only on an answer: a failed call is tried again on the next pass", async () => {
      const { db, e } = await synced();
      e.server.respond("cloud_delete_install", { p_expected_user_id: USER_A, p_source_install_id: INSTALL });
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("kept", I1);
      expect((await pass(e)).outcome).toBe("install_removed");
      e.server.removedInstalls.clear();
      const t = e.server.transport;
      let failOnce = true;
      let asked = 0;
      setTransport(e, async (fn, args, signal) => {
        if (fn === "cloud_install_status") asked++;
        if (fn === "cloud_install_status" && failOnce) {
          failOnce = false;
          throw new Error("network");
        }
        return t(fn, args, signal);
      });
      expect((await pass(e)).outcome).toBe("install_removed");
      const r = await pass(e);
      expect(asked).toBe(2);
      expect(r.outcome).toBe("done");
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).toBeNull();
    });
  });

  // ================================================================ KIND (SR review of #3594: R1-R4)
  describe("KIND: whose value wins in a pull", () => {
    it("R2: an incremental pull writes the cloud's value locally even for a part this computer wrote last", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("sent from here", I1);
      await pass(e);
      const online = onlineItem(e, I1).parts.note;
      expect(online.by).toBe(`desktop:${INSTALL}`);
      // the shadow one rev behind and the local row on another value, with no op waiting (as after a lost write-back)
      quietly(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("stale here", I1));
      db.prepare("UPDATE cloud_sync_todo_state SET note_rev = ? WHERE local_id = ?").run(online.rev - 1, I1);
      onlineItem(e, I1).changeSeq = e.server.nextSeq(USER_A);
      await pass(e);
      expect(item(db, I1)!.note).toBe("sent from here");
      expect(outbox(db)).toEqual([]);
      expect(onlineItem(e, I1).parts.note.value).toBe("sent from here");
    });

    it("R1: a full pull owed by resync_required lets the cloud win: a profile rolled back on this computer does not push its older values over newer ones", async () => {
      const { db, e } = await synced();
      await pass(e);
      const old = { cursor: cursor(db)!, shadow: shadow(db, I1)!, note: item(db, I1)!.note };
      // newer values sent from this computer after that point
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("newer, from here", I1);
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I1);
      await pass(e);
      expect(onlineItem(e, I1).parts.note.value).toBe("newer, from here");
      // a purge online moves the horizon past the old cursor
      const gone = e.server.aiAdd(onlineList(e, CL), "Temporary");
      e.server.removeOnline(gone);
      e.server.purgeOnline(gone);
      // the file is rolled back (Time Machine, a copy): the old local values, shadow and cursor, no outbox
      quietly(db, () => {
        db.prepare("UPDATE transaction_checklist_items SET note = ?, is_checked = 0, checked_at = NULL WHERE id = ?").run(old.note, I1);
        db.prepare("UPDATE cloud_sync_todo_state SET note_rev = ?, note_json = ?, done_rev = ?, done_json = ? WHERE local_id = ?").run(
          old.shadow.note_rev, old.shadow.note_json, old.shadow.done_rev, old.shadow.done_json, I1);
        db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = ?, horizon = ?").run(old.cursor.last_seq, old.cursor.horizon);
      });
      expect(outbox(db)).toEqual([]);
      const r = await pass(e);
      expect(r.pull).toMatchObject({ resyncs: 1, fullPullDone: true });
      expect(onlineItem(e, I1).parts.note.value).toBe("newer, from here");
      expect((onlineItem(e, I1).parts.done.value as Row).is_checked).toBe(true);
      expect(item(db, I1)).toMatchObject({ note: "newer, from here", is_checked: 1 });
      expect(outbox(db)).toEqual([]);
      expect(cursor(db)).toMatchObject({ full_pull_owed: 0, full_pull_kind: null });
    });

    it("R1: a resync during the full pull a turn-on owes keeps that pull's kind (its outbox was cleared, so this computer's own values stay)", () => {
      const { db } = profile();
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: null });
      todosPull.resetTodoCursorForFullPull(db, PROJECT, USER_A, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: null });
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 0, last_seq = 9, horizon = 0").run();
      todosPull.resetTodoCursorForFullPull(db, PROJECT, USER_A, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "resync", last_seq: 0, horizon: null });
    });

    it("R3: a resync_required answered in the middle of a restore pull keeps it a restore pull", async () => {
      const { db, e } = await synced();
      prepareRestoredFile(db);
      expect(cursor(db)).toMatchObject({ full_pull_kind: "restore" });
      // page 1 applies; page 2 answers resync (the shape cloud_todo_pull gives, observed O8c); page 3 fails
      let k = 0;
      const client = new CloudClient(async (fn, args, signal) => {
        if (fn === "cloud_todo_pull") {
          k++;
          if (k === 2) return { data: { ok: true, head: 99, rows: [], horizon: 98, next_after: 99, install_max_edit_seq: null, resync_required: true }, error: null, status: 200 };
          if (k === 3) throw new Error("network");
        }
        return e.server.transport(fn, args, signal);
      }, 5_000);
      const r = await pullTodos({ db, client, projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: () => new Date(), guard: () => undefined, stopOn: () => undefined, pageSize: 1 });
      expect(r).toMatchObject({ outcome: "failed", resyncs: 1 });
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "restore", last_seq: 0 });
    });

    it("R4: an account reset (or a reclaim) while a restore pull is owed does not downgrade it", async () => {
      const { db } = await synced();
      prepareRestoredFile(db);
      // the account was turned off and on elsewhere: accepted_at changed
      preparePass(db, PROJECT, USER_A, "2026-11-20T00:00:00.000Z", undefined, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "restore" });
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "restore" });
    });
  });

  // ================================================================ SR2 (second review of #3594: S1-S5)
  describe("SR2: other sides' changes", () => {
    const lock = (db: TestDb, deal: string, status = "approved") => db.prepare("UPDATE transactions SET submission_status = ? WHERE id = ?").run(status, deal);

    it("S1: a local edit of one part pushed while another side changed a different part: the other part reaches the local row, and a later scan does not revert it online", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "ai note, other part");
      db.prepare("UPDATE transaction_checklist_items SET title = ? WHERE id = ?").run("Inspection (edited here)", I1);
      await pass(e);
      expect(onlineItem(e, I1).parts.title.value).toBe("Inspection (edited here)");
      expect(item(db, I1)).toMatchObject({ title: "Inspection (edited here)", note: "ai note, other part" });
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
      await pass(e);
      expect(onlineItem(e, I1).parts.note).toMatchObject({ value: "ai note, other part", by: "ai_app:conn-1" });
    });

    it("S3: on a locked deal (approved) an online removal, an add, a restore and a purge are parked with deal_locked; nothing is written or sent; after the unlock each applies", async () => {
      const { db, deal, e } = await synced();
      const removed = onlineItem(e, I1);
      const restored = onlineItem(e, I2);
      e.server.removeOnline(restored);
      await pass(e);
      expect(item(db, I2)).toBeUndefined();
      lock(db, deal);
      e.server.removeOnline(removed);
      const added = e.server.aiAdd(onlineList(e, CL), "Added while approved");
      e.server.restoreOnline(restored);
      const c0 = cursor(db)!;
      const sent = allOps(e).length;
      await pass(e);
      expect(item(db, I1)).toBeDefined();
      expect(item(db, added.id)).toBeUndefined();
      expect(item(db, I2)).toBeUndefined();
      expect(db.prepare("SELECT DISTINCT error_code FROM cloud_sync_todo_parked").all()).toEqual([{ error_code: "deal_locked" }]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_parked")).toBe(3);
      expect(cursor(db)!.last_seq).toBeGreaterThan(c0.last_seq);
      expect(shadow(db, I1)!.removed_json).toBe(JSON.stringify({ removed_at: null, kind: null }));
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
      await pass(e);
      expect(allOps(e)).toHaveLength(sent);
      // a purge waits too (the local row is the only copy left while locked)
      e.server.purgeOnline(removed);
      await pass(e);
      expect(item(db, I1)).toBeDefined();
      // unlocked: every parked change applies
      lock(db, deal, "not_submitted");
      await pass(e);
      expect(item(db, I1)).toBeUndefined();
      expect(shadow(db, I1)).toBeUndefined();
      expect(item(db, added.id)).toMatchObject({ title: "Added while approved" });
      expect(item(db, I2)).toMatchObject({ title: "Call lender" });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_parked")).toBe(0);
      expect(outbox(db)).toEqual([]);
    });

    it("S4: a todo created online with sort_order NULL (an AI add, the server's My items list) is created here with 0 and sends no op, neither after a full pull nor after a daily scan; nothing parks", async () => {
      const { db, e } = await synced();
      const added = e.server.aiAdd(onlineList(e, MY), "null order", undefined, null);
      expect(added.parts.order.value).toBeNull();
      const list: FakeTodo = { ...onlineList(e, CL), id: fid(96, 1), localId: fid(96, 1), templateId: "tpl-null", aliases: [], fields: { template_name: "Online list", is_private: false },
        changeSeq: e.server.nextSeq(USER_A), parts: { ...onlineList(e, CL).parts, order: { rev: 1, value: null, at: Date.now(), by: "ai_app:conn-1", edit_seq: null } } };
      e.server.todos.push(list);
      const sent = allOps(e).length;
      await pass(e);
      expect(item(db, added.id)!.sort_order).toBe(0);
      expect(db.prepare("SELECT sort_order FROM transaction_checklists WHERE id = ?").get(list.id)).toEqual({ sort_order: 0 });
      e.server.aiSet(added, "note", "ai note");
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1, last_seq = 0, horizon = NULL").run();
      const r = await pass(e);
      expect(r.pull).toMatchObject({ fullPullDone: true, parked: 0 });
      expect(item(db, added.id)!.note).toBe("ai note");
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
      await pass(e);
      expect(allOps(e)).toHaveLength(sent);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_parked")).toBe(0);
    });

    it("H1/H3: a held op wins causally (base_rev = the pulled rev) even when the other side's change is timed after it; approved locks like submitted", async () => {
      const { db, deal, e } = await synced();
      lock(db, deal, "approved");
      e.server.aiSet(onlineItem(e, I1), "note", "ai, timed later", Date.now() + 3_600_000);
      await pass(e);
      const held = allOps(e).filter((o) => o.held_locked === true);
      expect(held).toHaveLength(1);
      expect(typeof held[0].base_rev).toBe("number");
      expect(onlineItem(e, I1).parts.note.value).toBeNull();
      expect(item(db, I1)!.note).toBeNull();
    });

    it("PD: a pulled row whose local_id names a local todo of another checklist and cloud id is parked (local_id_conflict); that todo and its shadow are untouched", async () => {
      const { db, e } = await synced();
      const before = { item: item(db, I1), shadow: shadow(db, I1) };
      const cur = cursor(db)!;
      const other = onlineItem(e, I2);
      const r = applyTodoPage(db, { projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: new Date() }, {
        rows: [{ entity: "item", cloud_id: fid(77, 1), cloud_deal_id: other.dealId, cloud_checklist_id: other.checklistId, local_id: I1, change_seq: cur.last_seq + 1, purged: false,
          parts: Object.fromEntries(Object.entries(other.parts).map(([k, v]) => [k, { ...v, rev: v.rev + 5, by: "ai_app:x", value: k === "title" ? "INTRUDER" : v.value }])) as unknown as JsonValue }],
        next_after: cur.last_seq + 1, horizon: cur.horizon ?? 0, install_max_edit_seq: null,
      }, 500);
      expect(r.parked).toBeGreaterThan(0);
      expect(item(db, I1)).toEqual(before.item);
      expect(shadow(db, I1)).toEqual(before.shadow);
      expect(db.prepare("SELECT error_code FROM cloud_sync_todo_parked").all()).toEqual([{ error_code: "local_id_conflict" }]);
    });

    it("D1: a pulled row whose local_id is another local user's todo writes nothing to it", async () => {
      const { db, e } = await synced();
      const dealB = dealId();
      insertDeal(db, dealB, USER_B);
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 70), dealB, "tpl-b", "B list", 0);
      db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 70), fid(3, 70), "B's item", null, 0, null, 0);
      const before = item(db, fid(4, 70));
      const cur = cursor(db)!;
      const t = onlineItem(e, I1);
      applyTodoPage(db, { projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: new Date() }, {
        // a deal id this computer does not know, so only the owner check stands between the row and B's todo
        rows: [{ entity: "item", cloud_id: fid(77, 2), cloud_deal_id: fid(77, 3), cloud_checklist_id: t.checklistId, local_id: fid(4, 70), change_seq: cur.last_seq + 1, purged: false,
          parts: Object.fromEntries(Object.entries(t.parts).map(([k, v]) => [k, { ...v, rev: v.rev + 5, value: k === "title" ? "INTRUDER" : v.value }])) as unknown as JsonValue }],
        next_after: cur.last_seq + 1, horizon: cur.horizon ?? 0, install_max_edit_seq: null,
      }, 500);
      expect(item(db, fid(4, 70))).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_todo_state WHERE local_id = ?").get(fid(4, 70))).toEqual({ n: 0 });
    });

    it("D4 (W27): a pulled checklist of a template whose local list is already bound to another cloud id is skipped; the local list keeps its binding", async () => {
      const { db, e } = await synced();
      const mine = onlineList(e, MY);
      const other: FakeTodo = { ...mine, id: fid(97, 9), localId: fid(97, 9), aliases: [], changeSeq: e.server.nextSeq(USER_A) };
      e.server.todos.push(other);
      await pass(e);
      expect(shadow(db, MY)).toMatchObject({ cloud_id: mine.id });
      expect(db.prepare("SELECT COUNT(*) AS n FROM transaction_checklists WHERE id = ?").get(fid(97, 9))).toEqual({ n: 0 });
    });

    it("E1: conflict notices are deduplicated per user: two local users with an event of the same number each get theirs", async () => {
      const { db, e } = await synced();
      enableForUser(db, PROJECT, USER_B, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      const t = onlineItem(e, I1);
      const ev = { entity: "event", change_seq: 4242, cloud_deal_id: t.dealId, about: "item", cloud_id: t.id, part: "note", outcome: "lost", loser_value: "a", winner_value: "b", by: `desktop:${INSTALL}`, label: "Keepr desktop", other_by: "ai_app:conn-1", effective_at: null, received_at: null };
      for (const user of [USER_A, USER_B]) {
        applyTodoPage(db, { projectRef: PROJECT, userId: user, installId: INSTALL, now: new Date() }, { rows: [ev], next_after: 4242, horizon: 0, install_max_edit_seq: null }, 500);
      }
      expect(db.prepare("SELECT owner_user_id FROM cloud_sync_todo_notices WHERE kind = 'conflict' AND change_seq = 4242 ORDER BY owner_user_id").all()).toEqual([
        { owner_user_id: USER_A },
        { owner_user_id: USER_B },
      ]);
    });

    it("I2: an ok status answer without removed:false keeps the user stopped", async () => {
      const { db, e } = await synced();
      e.server.respond("cloud_delete_install", { p_expected_user_id: USER_A, p_source_install_id: INSTALL });
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("kept", I1);
      expect((await pass(e)).outcome).toBe("install_removed");
      e.server.override = (fn) => (fn === "cloud_install_status" ? { data: { ok: true }, error: null, status: 200 } : undefined);
      const calls = e.server.calls.length;
      expect((await pass(e)).outcome).toBe("install_removed");
      // the answer resumed nothing: no call after the status check
      expect(e.server.calls.slice(calls).map((c) => c.fn)).toEqual(["cloud_install_status"]);
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).not.toBeNull();
    });
  });

  // ================================================================ S6 / R6 (re-review of #3594)
  describe("S6 / R6", () => {
    it("S6: a restored link with one member whose evidence is gone and one whose evidence remains comes back with the remaining member", async () => {
      const { db, e } = await synced();
      db.prepare("INSERT INTO emails (id, user_id, external_id, source, subject) VALUES (?, ?, 'ext-1', 'gmail', 'Report')").run(fid(9, 1), USER_A);
      db.prepare("INSERT INTO emails (id, user_id, external_id, source, subject) VALUES (?, ?, 'ext-2', 'gmail', 'Gone')").run(fid(9, 2), USER_A);
      db.prepare("INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order) VALUES (?, ?, 'email', 'Mail', 0)").run(fid(10, 1), I1);
      db.prepare("INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)").run(fid(11, 1), fid(10, 1), fid(9, 1));
      db.prepare("INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)").run(fid(11, 2), fid(10, 1), fid(9, 2));
      const t = onlineItem(e, I1);
      e.server.removeOnline(t);
      await pass(e);
      expect(item(db, I1)).toBeUndefined();
      db.prepare("DELETE FROM emails WHERE id = ?").run(fid(9, 2));
      e.server.restoreOnline(t);
      await pass(e);
      expect(db.prepare("SELECT id FROM transaction_checklist_links WHERE item_id = ?").all(I1)).toEqual([{ id: fid(10, 1) }]);
      expect(db.prepare("SELECT id FROM transaction_checklist_link_members ORDER BY id").all()).toEqual([{ id: fid(11, 1) }]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_notices WHERE kind = 'links_not_restored'")).toBe(0);
    });

    /** A file older than this computer's online history: the older note and shadow, the counter before the newer edit. */
    async function rolledBack() {
      const { db, e } = await synced();
      const old = { shadow: shadow(db, I1)!, counter: (db.prepare("SELECT edit_seq FROM cloud_sync_todo_counter").get() as { edit_seq: number }).edit_seq };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("newer, from here", I1);
      await pass(e);
      expect(onlineItem(e, I1).parts.note.edit_seq as number).toBeGreaterThan(old.counter);
      quietly(db, () => {
        db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(null, I1);
        db.prepare("UPDATE cloud_sync_todo_state SET note_rev = ?, note_json = ? WHERE local_id = ?").run(old.shadow.note_rev, old.shadow.note_json, I1);
        db.prepare("UPDATE cloud_sync_todo_counter SET edit_seq = ?").run(old.counter);
      });
      return { db, e };
    }

    it("R6: a reclaim (or an account reset) on a file older than this computer's online history makes the full pull cloud-wins ('behind'): the newer online value comes back and nothing older is pushed", async () => {
      const { db, e } = await rolledBack();
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: null });
      const r = await pass(e);
      expect(r.pull).toMatchObject({ fullPullDone: true });
      expect(item(db, I1)!.note).toBe("newer, from here");
      expect(onlineItem(e, I1).parts.note.value).toBe("newer, from here");
      expect(outbox(db)).toEqual([]);
      expect(cursor(db)).toMatchObject({ full_pull_owed: 0, full_pull_kind: null });
    });

    it("R6: the 'behind' decision is stored with the first page, so a crash before the next page cannot turn the rest into keep-local", async () => {
      const { db, e } = await rolledBack();
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      let k = 0;
      const client = new CloudClient(async (fn, args, signal) => {
        if (fn === "cloud_todo_pull" && ++k === 2) throw new Error("network");
        return e.server.transport(fn, args, signal);
      }, 5_000);
      const r = await pullTodos({ db, client, projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: () => new Date(), guard: () => undefined, stopOn: () => undefined, pageSize: 1 });
      expect(r).toMatchObject({ outcome: "failed", pages: 1 });
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "behind" });
    });

    /** A rolled-back file, reclaimed, whose 'behind' pull applied page 1 (the counter is now raised) and then stopped. */
    async function behindAfterPage1(page2?: "resync") {
      const { db, e } = await rolledBack();
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      let k = 0;
      const client = new CloudClient(async (fn, args, signal) => {
        if (fn === "cloud_todo_pull") {
          k++;
          if (k === 2 && page2 === "resync")
            return { data: { ok: true, head: 999, rows: [], horizon: 998, next_after: 999, install_max_edit_seq: null, resync_required: true }, error: null, status: 200 };
          if (k === (page2 === "resync" ? 3 : 2)) throw new Error("network");
        }
        return e.server.transport(fn, args, signal);
      }, 5_000);
      await pullTodos({ db, client, projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: () => new Date(), guard: () => undefined, stopOn: () => undefined, pageSize: 1 });
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "behind" });
      // page 1 raised the counter to the online max: a new first page could not detect the file again
      expect((db.prepare("SELECT edit_seq FROM cloud_sync_todo_counter").get() as { edit_seq: number }).edit_seq).toBe(onlineItem(e, I1).parts.note.edit_seq);
      return { db, e };
    }

    it("R7a: a resync_required during a 'behind' pull keeps it 'behind' (cloud-wins) to the end: the newer online value comes back and nothing older is pushed", async () => {
      const { db, e } = await behindAfterPage1("resync");
      expect(cursor(db)).toMatchObject({ last_seq: 0, horizon: null });
      await pass(e);
      expect(item(db, I1)!.note).toBe("newer, from here");
      expect(onlineItem(e, I1).parts.note.value).toBe("newer, from here");
      expect(outbox(db)).toEqual([]);
      expect(cursor(db)).toMatchObject({ full_pull_owed: 0, full_pull_kind: null });
    });

    it("R7b: a reclaim while a 'behind' pull is owed carries 'behind' (as a restore is carried); an account reset does the same; the pull stays cloud-wins", async () => {
      const { db, e } = await behindAfterPage1();
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "behind", last_seq: 0 });
      preparePass(db, PROJECT, USER_A, "2026-11-21T00:00:00.000Z", undefined, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: "behind" });
      await pass(e);
      expect(item(db, I1)!.note).toBe("newer, from here");
      expect(onlineItem(e, I1).parts.note.value).toBe("newer, from here");
      expect(outbox(db)).toEqual([]);
    });

    it("R6: a reclaim on a file that is NOT behind stays keep-local: a local value of a part this computer wrote last, never sent, reaches the cloud", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("sent", I1);
      await pass(e);
      quietly(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("never sent", I1));
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      await pass(e);
      expect(onlineItem(e, I1).parts.note.value).toBe("never sent");
      expect(item(db, I1)!.note).toBe("never sent");
      expect(cursor(db)).toMatchObject({ full_pull_owed: 0, full_pull_kind: null });
    });
  });

  // ================================================================ PR-5: AI-app writes as the real write tools make them
  describe("PR-5: an AI app's writes (mcp_update_todo / mcp_add_todo, migration 20261118130000)", () => {
    it("(b) an AI add arrives with the sort_order the tool sends (next free place on My items) and is created here at it; nothing is sent back, not even by the scan", async () => {
      const { db, e } = await synced();
      // the fixture's My items list holds I2 at 0
      const added = e.server.aiAdd(onlineList(e, MY), "Book the movers");
      expect(added.parts.order.value).toBe(1);
      const sent = allOps(e).length;
      await pass(e);
      expect(item(db, added.id)).toMatchObject({ checklist_id: MY, title: "Book the movers", sort_order: 1 });
      expect(shadow(db, added.id)).toMatchObject({ cloud_id: added.id, order_rev: 1 });
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
      await pass(e);
      expect(allOps(e)).toHaveLength(sent);
      // a second add goes after it, as the tool computes it
      expect(e.server.aiAdd(onlineList(e, MY), "Second").parts.order.value).toBe(2);
    });

    it("(a) a keep-local full pull never keeps this computer's value over an AI app's change: only parts this install wrote last are kept", async () => {
      const { db, e } = await synced();
      const t = onlineItem(e, I1);
      expect(e.server.aiSet(t, "note", "from Claude")).toBe("applied");
      // this computer holds another value it never sent (as a restored file would), then a keep-local full pull
      quietly(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("local, never sent", I1));
      reclaimInstallForUser(db, PROJECT, USER_A, new Date());
      expect(cursor(db)).toMatchObject({ full_pull_owed: 1, full_pull_kind: null });
      await pass(e);
      expect(item(db, I1)!.note).toBe("from Claude");
      expect(onlineItem(e, I1).parts.note).toMatchObject({ value: "from Claude", by: "ai_app:conn-1" });
      expect(outbox(db)).toEqual([]);
    });

    it("(a) second actor on different parts during a send: the AI app's done survives this computer's note push and the next pull", async () => {
      const { db, e } = await synced();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("desk note", I1);
      e.server.aiSet(onlineItem(e, I1), "done", { is_checked: true, checked_at: "2026-11-18T00:00:00.000Z" });
      await pass(e);
      await pass(e);
      expect(item(db, I1)).toMatchObject({ note: "desk note", is_checked: 1 });
      expect(onlineItem(e, I1).parts.note.value).toBe("desk note");
      expect((onlineItem(e, I1).parts.done.value as Row).is_checked).toBe(true);
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
    });
  });

  // ================================================================ BATCH
  describe("BATCH: the sender's caps on a full batch", () => {
    it("250 todos with long notes go out in calls of at most 200 ops and 921,600 bytes of compact JSON (server: 200 ops, 1,048,576 bytes); every op applies", async () => {
      const { db, deal, e } = await synced();
      expect([MAX_OPS_PER_CALL, MAX_BYTES_PER_CALL]).toEqual([200, 921_600]);
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 50), deal, "tpl-bulk", "Bulk", 5);
      for (let i = 0; i < 250; i++) {
        db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title, description, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)").run(
          fid(5, i), fid(3, 50), `Bulk ${i}`, "d".repeat(600), "n".repeat(3900), i);
      }
      const before = pushes(e).length;
      await pass(e);
      const calls = pushes(e).slice(before);
      const sizes = calls.map((c) => ({ ops: (c.args.p_ops as unknown[]).length, bytes: Buffer.byteLength(JSON.stringify(c.args.p_ops), "utf8") }));
      expect(calls.length).toBeGreaterThan(1);
      for (const z of sizes) {
        expect(z.ops).toBeLessThanOrEqual(200);
        expect(z.bytes).toBeLessThanOrEqual(921_600);
      }
      expect(Math.max(...sizes.map((z) => z.bytes))).toBeGreaterThan(800_000);
      expect(e.server.todos.filter((t) => t.checklistId === onlineList(e, fid(3, 50)).id)).toHaveLength(250);
      expect(outbox(db)).toEqual([]);
    });
  });

  // ================================================================ ORPH
  describe("ORPH: Settings' 'saved online but not on this computer'", () => {
    it("a deal deleted here is removed online (kept 30 days): the daily reconcile does not count it, and 'Delete them' sends no delete for it", async () => {
      const { db, deal, e } = await synced();
      db.prepare("DELETE FROM transactions WHERE id = ?").run(deal);
      await pass(e);
      expect(e.server.softRemovedDeals).toHaveLength(1);
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      await pass(e);
      const listed = e.server.calls.filter((c) => c.fn === "cloud_list_install_rows" && c.args.p_kind === "deal");
      expect(listed.length).toBeGreaterThan(0);
      const summary = JSON.parse((db.prepare("SELECT last_state_json FROM cloud_sync_settings WHERE user_id = ?").get(USER_A) as { last_state_json: string }).last_state_json);
      expect(summary.orphanDeals).toBe(0);
      const deletes = e.server.callsTo("cloud_delete_deal").length;
      expect(await e.service.deleteOnlineNotHere()).toEqual({ success: true });
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(deletes);
    });
  });
});
