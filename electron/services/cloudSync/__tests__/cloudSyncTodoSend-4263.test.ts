/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-4a — the todo sender (todos/sender.ts), its answer table (todos/answers.ts), the wire
 * encoder (todos/wire.ts) and the local todo store (db/cloudSyncTodoDbService.ts), driven through the real
 * runner pass, the real capture triggers and the app's own checklist statements. The server is the fake
 * (helpers/fakeServer.ts): its cloud_todo_push is transcribed from PR-2's migration and contract (see its
 * header); the answers listed in the PR-4a handoff are to be re-checked against the applied functions.
 *
 *   W-wire  every outbox shape the triggers and the scan write encodes to the contract's field types
 *   W-order creates, then parts, then removals; checklists before items on create (N2)
 *   S       turn-on scan, send, confirm; outbox empty, shadow written
 *   R4      confirm: generation, rebase, the winner written locally, never a lower rev, the guard
 *   ACID    crash before send / after the server committed / between two confirms
 *   R-op    retries reuse the op_id (lost response, not_found, parent_missing)
 *   R8      install_removed stops the sender (persisted), turn-off clears it (E1)
 *   E4/W32  a restore: no scan while a full pull is owed; nothing sent over the cloud's values
 *   D6/W30  turn-off, turn-on, rebind clear the todo tables; no op from before is sent
 *   N1a/b   the one-time step for profiles turned on before this build; the counter seed
 *   P       the premise of the initial scan: todos already online are never duplicated or overwritten
 *   U       another local user's ops are never read or sent; a never-on user sends nothing
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, USER_A, USER_B } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { badTodoFields, FakeServer, jsonType, refusedFields, TODO_FIELD_TYPES, WIRE_EXAMPLES } from "./helpers/fakeServer";
import { disableForUser, enableForUser, ensureInstall, preparePass } from "../../db/cloudSyncDbService";
import * as todos from "../../db/cloudSyncTodoDbService";
import { applyTodoPage } from "../../db/cloudSyncTodoPullDb";
import { prepareRestoredFile, markAllEligibleAfterMigration } from "../../db/cloudSyncTriggers";
import { encodeOp, compareForSend, SCAN_EPOCH, normOpId, wireOpId, type OutboxRow } from "../todos/wire";
import { actionFor, ANSWER_TABLE } from "../todos/answers";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  DELETE_PRIVATE_ITEM_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  RENAME_PRIVATE_ITEM_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  SET_ITEM_SORT_ORDER_SQL,
} from "../../db/checklistSql";
import type { JsonValue } from "../jcs";
import type { RpcTransport } from "../cloudClient";

type Row = Record<string, unknown>;
/** Invented all-zero-pattern ids. */
const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const INSTALL = fid(98, 4263);
const CL = fid(3, 1);
const MY = fid(3, 2);
const I1 = fid(4, 1);
const I2 = fid(4, 2);

const outbox = (db: TestDb, user = USER_A) =>
  db.prepare("SELECT * FROM cloud_sync_todo_outbox WHERE owner_user_id = ? ORDER BY entity, local_id, part").all(user) as unknown as OutboxRow[];
const keys = (rows: OutboxRow[]) => rows.map((r) => `${r.entity}:${r.local_id}:${r.part}`).sort();
const shadow = (db: TestDb, localId: string) =>
  db.prepare("SELECT * FROM cloud_sync_todo_state WHERE local_id = ?").get(localId) as Row | undefined;
const item = (db: TestDb, id: string) => db.prepare("SELECT * FROM transaction_checklist_items WHERE id = ?").get(id) as Row;
const n = (db: TestDb, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const pushes = (e: Engine) => e.server.callsTo("cloud_todo_push");
const opsOf = (e: Engine, i = -1) => {
  const calls = pushes(e);
  return (calls[i < 0 ? calls.length + i : i]?.args.p_ops ?? []) as Array<Record<string, JsonValue>>;
};
const allOps = (e: Engine) => pushes(e).flatMap((c) => c.args.p_ops as Array<Record<string, JsonValue>>);
const onlineItem = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "item" && t.localId === local);

function setTransport(e: Engine, t: RpcTransport): void {
  (e.service as unknown as { deps: { client: { transport: RpcTransport } } }).deps.client.transport = t;
}

/** A profile with the install row, USER_A's deal with one checklist (two items) and a My items list. */
function profile(opts: { turnOn?: boolean } = {}): { db: TestDb; deal: string } {
  const db = freshDb();
  db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, NULL, '2026-11-01T00:00:00.000Z')").run(
    PROJECT,
    INSTALL,
  );
  const deal = dealId();
  insertDeal(db, deal, USER_A);
  db.prepare(INSERT_CHECKLIST_SQL).run(CL, deal, "tpl-1", "Purchase", 0);
  db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(MY, deal, MY_ITEMS_TEMPLATE_ID, "My items", 1);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I1, CL, "Inspection", null, 1, "inspection", 0);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I2, MY, "Call lender", null, 0, null, 0);
  if (opts.turnOn !== false) turnOn(db);
  return { db, deal };
}

function turnOn(db: TestDb, user = USER_A): void {
  enableForUser(db, PROJECT, user, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
}

/** The engine on the real clock (the triggers stamp the real wall time). */
function engine(db: TestDb, server?: FakeServer): Engine {
  const e = makeEngine(db, { server });
  // a moving clock: sent_at is read just before each call, after the edits it sends
  Object.defineProperty(e.clock, "now", { get: () => new Date(), set: () => undefined, configurable: true });
  e.server.serverNow = () => Date.now();
  return e;
}

async function sentOnce(): Promise<{ db: TestDb; deal: string; e: Engine }> {
  const { db, deal } = profile();
  const e = engine(db);
  await startAndPass(e);
  expect(outbox(db)).toEqual([]);
  return { db, deal, e };
}

describe(`Keepr Cloud todo sender [${DRIVER}]`, () => {
  // ================================================================ wire (coordinator 2026-11-17, item 1)
  describe("W-wire: every outbox shape PR-3's triggers and the scan write encodes to the contract's types", () => {
    it("trigger-made rows (one of every kind of change) and scan-made rows: no field outside its contract type list; done is an object; booleans are JSON booleans", () => {
      const { db, deal } = profile();
      // the scan's rows (PR-4b: the turn-on writes none; the scan runs after the first full pull)
      expect(outbox(db)).toEqual([]);
      todos.scanTodos(db, PROJECT, USER_A, new Date());
      const shapes: OutboxRow[] = [...outbox(db)];
      expect(shapes.length).toBe(4);
      db.exec("DELETE FROM cloud_sync_todo_outbox");
      // one of every trigger-made shape
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 9), deal, "tpl-2", "Two", 2);
      db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 9), fid(3, 9), "Walk", "Desc", 1, "other", 3);
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I1);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("Booked", I1);
      db.prepare(SET_ITEM_SORT_ORDER_SQL).run(7, I1, CL);
      db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Call the lender", I2, deal, MY_ITEMS_TEMPLATE_ID);
      db.prepare("UPDATE transaction_checklist_items SET due_date = '2026-12-01' WHERE id = ?").run(I2);
      db.prepare("UPDATE transaction_checklists SET sort_order = 4 WHERE id = ?").run(CL);
      shapes.push(...outbox(db));
      db.exec("DELETE FROM cloud_sync_todo_outbox");
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(0, 0, I1);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(null, I1);
      db.prepare("UPDATE transaction_checklist_items SET due_date = NULL WHERE id = ?").run(I2);
      db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I2, deal, MY_ITEMS_TEMPLATE_ID);
      db.prepare("DELETE FROM transaction_checklists WHERE id = ?").run(fid(3, 9));
      shapes.push(...outbox(db));
      const kinds = new Set(shapes.map((r) => `${r.entity}:${r.part}`));
      for (const k of ["checklist:create", "checklist:order", "checklist:removed", "item:create", "item:done", "item:title", "item:note", "item:due", "item:order", "item:removed"]) {
        expect([k, kinds.has(k)]).toEqual([k, true]);
      }
      for (const r of shapes) {
        const op = encodeOp(r, { cloudDealId: fid(77, 1), currentEpoch: 0 })!;
        expect([r.entity, r.part, refusedFields(op as Record<string, unknown>)]).toEqual([r.entity, r.part, []]);
        for (const [k, v] of Object.entries(op)) {
          const types = TODO_FIELD_TYPES[k];
          if (types) expect([k, types.some((t) => (t === "integer" ? Number.isInteger(v) : t === jsonType(v)))]).toEqual([k, true]);
        }
        if (op.kind === "create_item") expect(jsonType(op.done)).toBe("object");
        if (op.kind === "set" && op.part === "done") expect(jsonType((op.value as Record<string, JsonValue>).is_checked)).toBe("boolean");
        if (op.kind === "set" && op.part === "title") expect(jsonType(op.value)).toBe("string");
        if (op.kind === "set" && (op.part === "note" || op.part === "due")) expect(["string", "null"]).toContain(jsonType(op.value));
        if (op.kind === "set" && op.part === "order") expect(Number.isInteger(op.value)).toBe(true);
        expect(op.op_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(normOpId(op.op_id)).toBe(r.op_id);
      }
    });

    it("the fake's field types and wire examples are the contract file's (supabase/contracts/cloud-todo-change-v1.json in this tree)", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const c = require("../../../../supabase/contracts/cloud-todo-change-v1.json") as {
        field_types: Record<string, unknown>;
        wire_types: { examples_accepted: unknown[]; examples_refused: unknown[] };
      };
      const { rule: _r, value: _v, ...types } = c.field_types;
      expect(TODO_FIELD_TYPES).toEqual(types);
      expect(WIRE_EXAMPLES.accepted).toEqual(c.wire_types.examples_accepted);
      expect(WIRE_EXAMPLES.refused).toEqual(c.wire_types.examples_refused);
    });

    it("the contract's wire_types examples: every accepted one passes the check the fake applies, every refused one is refused", () => {
      for (const op of WIRE_EXAMPLES.accepted) expect([op.kind, refusedFields(op)]).toEqual([op.kind, []]);
      for (const x of WIRE_EXAMPLES.refused) expect([x.why, refusedFields(x.op).length > 0]).toEqual([x.why, true]);
    });

    it("the fake server rejects a raw (unconverted) value exactly as the contract says: is_required 1 and a one-key part object", () => {
      expect(badTodoFields({ is_required: 1, title: "x" })).toEqual(["is_required"]);
      expect(badTodoFields({ part: "title", value: { title: "x" }, base_rev: 1.5 })).toEqual(["base_rev"]);
      expect(badTodoFields({ done: 1 })).toEqual(["done"]);
    });
  });

  // ================================================================ order (N2)
  describe("W-order", () => {
    it("creates (checklists, then items), then parts, then removals (items, then checklists); a create and a removal of a todo that never reached the cloud are both sent, in that order", async () => {
      const { db, e } = await sentOnce();
      const deal = db.prepare("SELECT id FROM transactions").get() as { id: string };
      e.online.value = false;
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 5), deal.id, "tpl-5", "Five", 5);
      db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 5), fid(3, 5), "Five a", null, 0, null, 0);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("n", fid(4, 5));
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("later", I1);
      db.prepare("DELETE FROM transaction_checklist_items WHERE id = ?").run(I2);
      db.prepare("DELETE FROM transaction_checklists WHERE id = ?").run(fid(3, 5));
      e.online.value = true;
      await pass(e);
      const seq = opsOf(e).map((o) => `${o.kind}:${o.entity ?? (o.kind === "create_checklist" ? "checklist" : "item")}:${o.local_id}`);
      expect(seq).toEqual([
        `create_checklist:checklist:${fid(3, 5)}`,
        `create_item:item:${fid(4, 5)}`,
        `set:item:${fid(4, 5)}`, // edited first (lower edit_seq)
        `set:item:${I1}`,
        `remove:item:${I2}`,
        `remove:checklist:${fid(3, 5)}`,
      ]);
      expect(outbox(db)).toEqual([]);
      expect(e.server.todos.find((t) => t.localId === fid(3, 5))!.removed).toBe(true);
    });

    it("compareForSend ranks by kind, then edit_seq, then edited_at; never by rowid", () => {
      const r = (entity: string, part: string, edit_seq: number | null, edited_at = "2026-01-01T00:00:00.000Z") => ({ entity, part, edit_seq, edited_at, local_id: `${entity}${part}` }) as OutboxRow;
      const list = [r("item", "removed", 1), r("item", "note", 9), r("item", "note", 2), r("checklist", "create", 5), r("item", "create", 3), r("checklist", "removed", 0), r("item", "done", null)];
      expect([...list].sort(compareForSend).map((x) => `${x.entity}:${x.part}:${x.edit_seq}`)).toEqual([
        "checklist:create:5",
        "item:create:3",
        "item:note:2",
        "item:note:9",
        "item:done:null",
        "item:removed:1",
        "checklist:removed:0",
      ]);
    });
  });

  // ================================================================ send and confirm
  describe("S / R4: send and confirm", () => {
    it("S (PR-4b order): turn-on queues nothing and owes a full pull; one pass pulls, scans every existing todo (unknowable time) and sends them; the outbox empties, the shadow holds the server's revs, no full pull is owed", async () => {
      const { db } = profile();
      expect(outbox(db)).toEqual([]);
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).toMatchObject({ last_seq: 0, full_pull_owed: 1 });
      const e = engine(db);
      await startAndPass(e);
      // the order of the pass: the full pull before any todo push
      const fns = e.server.calls.map((c) => c.fn).filter((f) => f === "cloud_todo_pull" || f === "cloud_todo_push");
      expect(fns[0]).toBe("cloud_todo_pull");
      expect(pushes(e)).toHaveLength(1);
      expect(keys(opsOf(e).map((o) => ({ entity: o.kind === "create_checklist" ? "checklist" : "item", local_id: o.local_id, part: "create" }) as unknown as OutboxRow))).toEqual(
        [`checklist:${CL}:create`, `checklist:${MY}:create`, `item:${I1}:create`, `item:${I2}:create`],
      );
      expect(opsOf(e).every((o) => o.clock_stepped === true)).toBe(true);
      expect(outbox(db)).toEqual([]);
      expect(e.server.todos.map((t) => `${t.entity}:${t.localId}`).sort()).toEqual([`checklist:${CL}`, `checklist:${MY}`, `item:${I1}`, `item:${I2}`]);
      expect(shadow(db, I1)).toMatchObject({ cloud_id: onlineItem(e, I1)!.id, done_rev: 1, note_rev: 1, title_json: JSON.stringify("Inspection") });
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).toMatchObject({ full_pull_owed: 0, horizon: 0 });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
    });

    it("R4: an edit made while the push is in flight keeps its outbox row (generation changed): base_rev moves to the returned rev, the next pass sends it, causally applied", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("first", I1);
      const sentGen = outbox(db)[0].generation;
      const real = e.server.transport;
      setTransport(e, async (f, a, s) => {
        const r = await real(f, a, s);
        // the user types again while the answer is on its way (an awaited callback on the same connection)
        if (f === "cloud_todo_push") db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("second", I1);
        return r;
      });
      await pass(e);
      const row = outbox(db)[0];
      expect(row).toMatchObject({ part: "note", generation: sentGen + 1, base_rev: onlineItem(e, I1)!.parts.note.rev });
      expect(onlineItem(e, I1)!.parts.note.value).toBe("first");
      expect(item(db, I1).note).toBe("second");
      setTransport(e, real);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("second");
      expect(shadow(db, I1)!.note_json).toBe(JSON.stringify("second"));
    });

    it("SR R1: a DIFFERENT part edited while another part's op is in flight survives that op's confirm and is sent next pass", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I1);
      expect(keys(outbox(db))).toEqual([`item:${I1}:done`]);
      const real = e.server.transport;
      setTransport(e, async (f, a, sig) => {
        const r = await real(f, a, sig);
        if (f === "cloud_todo_push") db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("typed during the tick", I1);
        return r;
      });
      await pass(e);
      expect(keys(outbox(db))).toEqual([`item:${I1}:note`]);
      setTransport(e, real);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("typed during the tick");
      expect((onlineItem(e, I1)!.parts.done.value as Record<string, unknown>).is_checked).toBe(true);
    });

    it("SR R4 (W18): a re-edit made while its op was in flight and LOST keeps its old base, so it is compared with the winner by time, not applied over it", async () => {
      const { db, e } = await sentOnce();
      const baseBefore = (shadow(db, I1)!.note_rev as number);
      const t = onlineItem(e, I1)!;
      t.parts.note = { rev: t.parts.note.rev + 1, value: "later, elsewhere", at: Date.now() + 600_000, by: "ai_app:conn-1", edit_seq: null };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("desk 1", I1);
      const real = e.server.transport;
      setTransport(e, async (f, a, sig) => {
        const r = await real(f, a, sig);
        if (f === "cloud_todo_push") db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("desk 2", I1);
        return r;
      });
      await pass(e);
      setTransport(e, real);
      const row = outbox(db).find((r) => r.part === "note")!;
      expect(row.base_rev).toBe(baseBefore);
      expect(row.base_rev).not.toBe(t.parts.note.rev);
      await pass(e);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("later, elsewhere");
      expect(item(db, I1).note).toBe("later, elsewhere");
    });

    it("R4: a lost answer writes the winner to the local row and the shadow (under the guard: no new op), and the outbox row goes", async () => {
      const { db, e } = await sentOnce();
      // another side changed the note later (as an AI app will from PR-5): later effective time, another actor
      const t = onlineItem(e, I1)!;
      t.parts.note = { rev: t.parts.note.rev + 1, value: "from the phone", at: Date.now() + 60_000, by: "ai_app:conn-1", edit_seq: null };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("desk", I1);
      await pass(e);
      const ans = (e.server.todoLedger.get([...e.server.todoLedger.keys()].pop() as string) as Row).status;
      expect(ans).toBe("lost");
      expect(item(db, I1).note).toBe("from the phone");
      expect(shadow(db, I1)).toMatchObject({ note_rev: t.parts.note.rev, note_json: JSON.stringify("from the phone") });
      expect(outbox(db)).toEqual([]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
    });

    it("time decides a concurrent change: a desktop edit made after another side's change wins (applied, conflict) and stays the value online", async () => {
      const { db, e } = await sentOnce();
      const t = onlineItem(e, I1)!;
      t.parts.note = { rev: t.parts.note.rev + 1, value: "an hour ago elsewhere", at: Date.now() - 3_600_000, by: "ai_app:conn-1", edit_seq: null };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("just now here", I1);
      await pass(e);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("just now here");
      expect(item(db, I1).note).toBe("just now here");
      expect(shadow(db, I1)).toMatchObject({ note_rev: t.parts.note.rev, note_json: JSON.stringify("just now here") });
      expect(outbox(db)).toEqual([]);
    });

    it("R4: a replayed answer naming an older rev moves neither the shadow nor the local row back", () => {
      const { db, deal } = profile();
      const row = { transaction_id: deal };
      db.prepare("INSERT INTO cloud_sync_todo_state (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, note_rev, note_json, updated_at) VALUES (?, ?, 'item', ?, ?, 'c-1', 5, ?, 'x')").run(
        PROJECT,
        USER_A,
        I1,
        row.transaction_id,
        JSON.stringify("newest"),
      );
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("newest", I1);
      const note = outbox(db).find((r) => r.local_id === I1 && r.part === "note")!;
      const stale = { op_id: note.op_id, status: "lost", entity: "item", cloud_id: "c-1", parts: { note: { rev: 3, value: "old winner" } } };
      todos.confirmTodoAnswer(db, note, stale, actionFor(stale), new Date());
      expect(shadow(db, I1)).toMatchObject({ note_rev: 5, note_json: JSON.stringify("newest") });
      expect(item(db, I1).note).toBe("newest");
    });

    it("the answer table: every contract status has one entry; refusals the server does not keep are retried, kept refusals are final", () => {
      for (const s of ["applied", "unchanged", "lost", "applied_to_removed", "removed", "already_removed", "restored", "not_removed", "not_restorable", "refused_removed", "locked", "not_allowed", "not_found", "rejected", "added", "exists", "mapped", "already_added", "install_removed"]) {
        expect([s, s in ANSWER_TABLE]).toEqual([s, true]);
      }
      for (const a of [{ status: "not_found" }, { status: "locked" }, { status: "refused_removed" }, { status: "rejected", reason: "parent_missing" }, { status: "not_restorable", reason: "my_items_exists" }, { status: "brand_new" }, undefined]) {
        expect(actionFor(a).action).toBe("retry");
      }
      expect(actionFor({ status: "rejected", reason: "invalid_value" }).action).toBe("final");
      expect(actionFor({ status: "install_removed" }).action).toBe("stop");
    });

    it("final: a kept rejection drops the op and records a notice; it is not sent again", async () => {
      const { db, e } = await sentOnce();
      e.server.override = (fn, a) => {
        if (fn !== "cloud_todo_push") return undefined;
        const ops = a.p_ops as Array<Record<string, JsonValue>>;
        return { data: { ok: true, results: ops.map((o) => ({ op_id: o.op_id, status: "rejected", reason: "invalid_value", field: "note" })) }, error: null };
      };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x".repeat(10), I1);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(db.prepare("SELECT kind, part FROM cloud_sync_todo_notices").all()).toEqual([{ kind: "rejected", part: "note" }]);
      const calls = pushes(e).length;
      await pass(e);
      expect(pushes(e)).toHaveLength(calls);
    });
  });

  // ================================================================ ACID crash points
  describe("ACID: a crash at any point leaves a state the next pass repairs", () => {
    it("before the send (no answer, the server never saw it): every row stays; the next pass sends the same op_ids once", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("a", I1);
      const before = outbox(db).map((r) => `${r.op_id}#${r.generation}`);
      e.server.override = (fn) => (fn === "cloud_todo_push" ? new Error("network") : undefined);
      await pass(e);
      expect(outbox(db).map((r) => `${r.op_id}#${r.generation}`)).toEqual(before);
      e.server.override = null;
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(opsOf(e).map((o) => normOpId(o.op_id))).toEqual(before.map((b) => b.split("#")[0]));
    });

    it("after the server committed, before the answer arrived: the same op_ids are sent again, the server replays, nothing is duplicated", async () => {
      const { db } = profile();
      const e = engine(db);
      const real = e.server.transport;
      let lost = false;
      setTransport(e, async (f, a, s) => {
        const r = await real(f, a, s);
        if (f === "cloud_todo_push" && !lost) {
          lost = true;
          throw new Error("connection reset");
        }
        return r;
      });
      await startAndPass(e);
      expect(outbox(db)).toHaveLength(4);
      expect(e.server.todos).toHaveLength(4);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(e.server.todos).toHaveLength(4);
      const [first, second] = pushes(e);
      expect((second.args.p_ops as Array<Record<string, JsonValue>>).map((o) => o.op_id)).toEqual((first.args.p_ops as Array<Record<string, JsonValue>>).map((o) => o.op_id));
      expect(shadow(db, I1)!.cloud_id).toBe(onlineItem(e, I1)!.id);
    });

    it("between two confirms: the confirmed answer stays confirmed, the other row stays with its op_id and is confirmed by the replay next pass; no guard row is left", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("one", I1);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("two", I2);
      const realPrepare = db.prepare.bind(db);
      let confirms = 0;
      (db as { prepare: TestDb["prepare"] }).prepare = (sql: string) => {
        if (sql.startsWith("INSERT OR REPLACE INTO cloud_sync_applying") && ++confirms === 2) throw Object.assign(new Error("quit"), { code: "SQLITE_IOERR" });
        return realPrepare(sql);
      };
      await expect(pass(e)).rejects.toThrow("quit");
      (db as { prepare: TestDb["prepare"] }).prepare = realPrepare;
      expect(outbox(db).map((r) => r.local_id)).toEqual([I2]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      const left = outbox(db)[0].op_id;
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(opsOf(e).map((o) => normOpId(o.op_id))).toEqual([left]);
      expect(onlineItem(e, I2)!.parts.note.value).toBe("two");
    });

    it("SR R2: a failure inside a confirm rolls the whole confirm back: no guard row, shadow, local row and outbox as they were", async () => {
      const { db, e } = await sentOnce();
      const t = onlineItem(e, I1)!;
      t.parts.note = { rev: t.parts.note.rev + 1, value: "winner", at: Date.now() + 600_000, by: "ai_app:conn-1", edit_seq: null };
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("mine", I1);
      const before = { sh: JSON.stringify(shadow(db, I1)), it: JSON.stringify(item(db, I1)), ob: JSON.stringify(outbox(db)) };
      const realPrepare = db.prepare.bind(db);
      let confirming = false;
      const real = e.server.transport;
      setTransport(e, async (f, a, sig) => {
        const r = await real(f, a, sig);
        if (f === "cloud_todo_push") confirming = true;
        return r;
      });
      (db as { prepare: TestDb["prepare"] }).prepare = (sql: string) => {
        // the last write of the confirm, after the guard, the shadow and the winner's write-back
        if (confirming && sql.startsWith("DELETE FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ? AND part = ? AND generation = ?")) {
          throw Object.assign(new Error("disk"), { code: "SQLITE_IOERR" });
        }
        return realPrepare(sql);
      };
      await expect(pass(e)).rejects.toThrow("disk");
      (db as { prepare: TestDb["prepare"] }).prepare = realPrepare;
      setTransport(e, real);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      expect(JSON.stringify(shadow(db, I1))).toBe(before.sh);
      expect(JSON.stringify(item(db, I1))).toBe(before.it);
      expect(JSON.stringify(outbox(db))).toBe(before.ob);
      // the next pass resends the same op_id and the replay confirms it
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(item(db, I1).note).toBe("winner");
    });

    it("SR R3: answers are matched by op_id: a missing, reordered, duplicated and an unknown answer confirm only the rows they name", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("one", I1);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("two", I2);
      db.prepare("UPDATE transaction_checklists SET sort_order = 9 WHERE id = ?").run(CL);
      const rows = outbox(db);
      const idOf = (local: string) => rows.find((r) => r.local_id === local)!.op_id;
      const real = e.server.transport;
      setTransport(e, async (f, a, sig) => {
        const r = await real(f, a, sig);
        if (f !== "cloud_todo_push") return r;
        const body = r.data as { ok: boolean; results: Array<Record<string, unknown>> };
        const by = (local: string) => body.results.find((x) => normOpId(x.op_id) === idOf(local))!;
        // reordered, I2's answer missing, CL's answer twice, and an answer for an op_id nobody sent
        body.results = [by(CL), { op_id: wireOpId("ab".repeat(16)), status: "applied", parts: {} }, by(I1), by(CL)];
        return r;
      });
      await pass(e);
      setTransport(e, real);
      expect(outbox(db).map((r) => r.local_id)).toEqual([I2]);
      expect(outbox(db)[0].op_id).toBe(idOf(I2));
      expect(shadow(db, I1)!.note_json).toBe(JSON.stringify("one"));
      expect(shadow(db, CL)!.order_json).toBe("9");
      expect(shadow(db, I2)!.note_json).not.toBe(JSON.stringify("two"));
    });

    it("a malformed online deal id answers a final rejected/invalid_value: the op is dropped with a notice, never resent", async () => {
      const { db, deal, e } = await sentOnce();
      db.prepare("UPDATE cloud_sync_state SET cloud_id = 'not-a-uuid' WHERE entity = 'deal' AND local_id = ?").run(deal);
      db.prepare("UPDATE cloud_sync_dirty SET next_attempt_at = '9999-12-31T00:00:00.000Z#99'").run();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", I1);
      await pass(e);
      expect(opsOf(e)[0]).toMatchObject({ deal_id: "not-a-uuid" });
      expect(outbox(db)).toEqual([]);
      expect(db.prepare("SELECT kind FROM cloud_sync_todo_notices").all()).toEqual([{ kind: "rejected" }]);
    });

    it("the apply guard is cleared at open and empty at rest", () => {
      const { db } = profile();
      db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, 'x')").run();
      todos.clearApplyGuard(db);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
    });
  });

  // ================================================================ op_id reuse (PR-2 review R4)
  describe("R-op: retries reuse the op_id", () => {
    it("not_found (not kept by the server) is retried with the same op_id until it applies", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("later", I1);
      const id = outbox(db)[0].op_id;
      let refuse = 2;
      const real = e.server.transport;
      const sentIds: string[] = [];
      setTransport(e, async (f, a, s) => {
        if (f === "cloud_todo_push") sentIds.push(normOpId((a.p_ops as Array<Record<string, JsonValue>>)[0].op_id));
        if (f === "cloud_todo_push" && refuse-- > 0) {
          const ops = a.p_ops as Array<Record<string, JsonValue>>;
          return { data: { ok: true, results: ops.map((o) => ({ op_id: o.op_id, status: "not_found" })) }, error: null };
        }
        return real(f, a, s);
      });
      await pass(e);
      await pass(e);
      expect(outbox(db).map((r) => r.op_id)).toEqual([id]);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(sentIds).toEqual([id, id, id]);
    });

    it("parent_missing (the checklist is not online yet) is retried with the same op_id; once the checklist is created the item is added", async () => {
      const { db, e } = await sentOnce();
      const deal = (db.prepare("SELECT id FROM transactions").get() as { id: string }).id;
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 7), deal, "tpl-7", "Seven", 7);
      db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(fid(4, 7), fid(3, 7), "Seven a", null, 0, null, 0);
      // the checklist create fails on this pass only (as when it is cut off from its item's batch)
      let failOnce = true;
      const real = e.server.transport;
      setTransport(e, async (f, a, s) => {
        if (f === "cloud_todo_push" && failOnce) {
          failOnce = false;
          const ops = a.p_ops as Array<Record<string, JsonValue>>;
          const r = (await real(f, { ...a, p_ops: ops.filter((o) => o.kind !== "create_checklist") }, s)).data as { results: JsonValue[] };
          return { data: { ok: true, results: [{ op_id: ops[0].op_id, status: "not_found" }, ...r.results] }, error: null };
        }
        return real(f, a, s);
      });
      await pass(e);
      const itemRow = outbox(db).find((r) => r.entity === "item")!;
      expect(itemRow).toBeDefined();
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(allOps(e).filter((o) => o.kind === "create_item" && o.local_id === fid(4, 7)).map((o) => normOpId(o.op_id))).toEqual([itemRow.op_id, itemRow.op_id]);
      expect(onlineItem(e, fid(4, 7))).toBeDefined();
    });
  });

  // ================================================================ install_removed (R8)
  describe("R8: install_removed", () => {
    it("stops the sender and persists the stop: no further todo call on later passes; the outbox is kept; turn-off clears the stop (E1)", async () => {
      const { db, e } = await sentOnce();
      e.server.removedInstalls.add(`${USER_A}|${e.service.runner && (db.prepare("SELECT install_id FROM cloud_sync_install").get() as { install_id: string }).install_id}`);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("after removal", I1);
      const before = pushes(e).length;
      await pass(e);
      expect(pushes(e)).toHaveLength(before + 1);
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).not.toBeNull();
      for (let i = 0; i < 3; i++) await pass(e);
      expect(pushes(e)).toHaveLength(before + 1);
      expect(outbox(db)).toHaveLength(1);
      disableForUser(db, PROJECT, USER_A, false);
      expect(todos.installRemovedAt(db, PROJECT, USER_A)).toBeNull();
    });
  });

  // ================================================================ E4 / W32
  describe("E4 / W32: after a backup restore no scan runs while a full pull is owed", () => {
    it("a 4a-only build: the restored file's older todo values are never sent over the cloud's (restore, pass, migration scan, trigger repair, daily reconcile)", async () => {
      const { db, e } = await sentOnce();
      // the cloud moved on after the backup: newer values online and in the shadow
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("newer", I1);
      await pass(e);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("newer");
      // the backup has the older value (rewritten under the guard, as a restored file would hold it)
      db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, 'x')").run();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("older (backup)", I1);
      db.exec("DELETE FROM cloud_sync_applying");
      // an op from before the backup still in the file
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("older op", I2);
      expect(prepareRestoredFile(db)).toBe(true);
      expect(outbox(db)).toEqual([]);
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).toMatchObject({ last_seq: 0, full_pull_owed: 1, horizon: null, full_pull_kind: "restore" });
      expect(markAllEligibleAfterMigration(db)).toBe(true);
      preparePass(db, PROJECT, USER_A, "2026-11-01T00:00:00.000Z", undefined, new Date());
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      const before = pushes(e).length;
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(pushes(e)).toHaveLength(before);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("newer");
      // PR-4b: the restore pull wrote the cloud's value over the backup's, so the scan after it finds nothing.
      expect(item(db, I1).note).toBe("newer");
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).toMatchObject({ full_pull_owed: 0, full_pull_kind: null });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter WHERE rewound_at IS NOT NULL")).toBe(0);
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
    });

    it("a scan that bypasses the gate after a restore (a deal the cloud lost, a server reset) sends no edit_seq: the rewound counter cannot outrank a newer value this computer wrote before the restore", async () => {
      const { db, deal, e } = await sentOnce();
      // before the restore: a newer note sent from this computer (same install, edit_seq k)
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("newer", I1);
      await pass(e);
      const stored = onlineItem(e, I1)!.parts.note;
      expect(stored).toMatchObject({ value: "newer", by: expect.stringMatching(/^desktop:/) });
      // the restored file: the older note, and a counter well behind (the backup's)
      db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, 'x')").run();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("older (backup)", I1);
      db.exec("DELETE FROM cloud_sync_applying");
      db.prepare("UPDATE cloud_sync_todo_counter SET edit_seq = ?").run((stored.edit_seq as number) - 1);
      prepareRestoredFile(db);
      // the cloud loses track of the deal's todos (R3b / reconcile path): the deal is scanned again
      todos.resetTodoDeal(db, PROJECT, USER_A, deal, new Date());
      expect(outbox(db).every((r) => r.edit_seq === null)).toBe(true);
      await pass(e);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("newer");
      expect(item(db, I1).note).toBe("newer");
    });

    it("the gate: once no full pull is owed, the same daily scan does send the difference (the predicate is what stops it)", async () => {
      const { db, e } = await sentOnce();
      db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, 'x')").run();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("missed", I1);
      db.exec("DELETE FROM cloud_sync_applying");
      // PR-4b: the first pass finished the full pull; owe one again to show the gate
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1").run();
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(0);
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 0").run();
      expect(todos.scanTodosIfAllowed(db, PROJECT, USER_A, new Date())).toBe(1);
      await pass(e);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("missed");
    });

    it("a restored backup from before this build (no cursor row): its PR-3-era ops are dropped, a full pull is owed, and the one-time step does not run", () => {
      const { db } = profile({ turnOn: false });
      db.prepare(
        "INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at, notice_version, accepted_at) VALUES (?, ?, 1, 'x', 1, '2026-11-01T00:00:00.000Z')",
      ).run(PROJECT, USER_A);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("pr3 era", I1);
      expect(outbox(db).length).toBeGreaterThan(0);
      prepareRestoredFile(db);
      expect(outbox(db)).toEqual([]);
      expect(todos.prepareTodoPass(db, PROJECT, USER_A, new Date())).toEqual({ oneShot: false });
      expect(outbox(db)).toEqual([]);
    });
  });

  // ================================================================ D6 / N3 / W30
  describe("D6 / N3 / W30: turn-off, turn-on and rebind clear the todo tables", () => {
    it("edit offline, turn off, turn on: no op from before the turn-off is sent; the full pull and the scan after it run in the next pass", async () => {
      const { db, e } = await sentOnce();
      e.online.value = false;
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("offline", I1);
      const old = outbox(db).map((r) => r.op_id);
      disableForUser(db, PROJECT, USER_A, false);
      for (const t of todos.TODO_USER_TABLES) expect([t, n(db, `SELECT COUNT(*) AS n FROM ${t}`)]).toEqual([t, 0]);
      // rows written while it was off by any other writer are cleared at turn-on too (N3)
      db.prepare(
        "INSERT INTO cloud_sync_todo_outbox (project_ref, owner_user_id, entity, local_id, part, value_json, edited_at, op_id) VALUES (?, ?, 'item', ?, 'note', '{}', 'x', 'ffffffffffffffffffffffffffffffff')",
      ).run(PROJECT, USER_A, I1);
      turnOn(db);
      e.server.enabled = true;
      e.online.value = true;
      await pass(e);
      const sent = allOps(e).map((o) => normOpId(o.op_id));
      for (const id of [...old, "ffffffffffffffffffffffffffffffff"]) expect(sent).not.toContain(id);
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).toMatchObject({ full_pull_owed: 0 });
      expect(outbox(db)).toEqual([]);
    });

    it("a machine rebind clears every user's todo rows and every counter row", () => {
      const { db } = profile();
      turnOn(db, USER_B);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", I1);
      db.prepare("INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, kind, created_at) VALUES (?, ?, 'item', 'i', 'rejected', 'x')").run(PROJECT, USER_B);
      db.prepare("UPDATE cloud_sync_install SET machine_hash = 'another-computer'").run();
      expect(ensureInstall(db, PROJECT, "device-on-a-new-computer").rebound).toBe(true);
      for (const t of [...todos.TODO_USER_TABLES, "cloud_sync_todo_counter"]) expect([t, n(db, `SELECT COUNT(*) AS n FROM ${t}`)]).toEqual([t, 0]);
    });
  });

  // ================================================================ N1a / N1b
  describe("N1a / N1b: profiles turned on before this build", () => {
    function pr3Profile(): TestDb {
      const { db } = profile({ turnOn: false });
      db.prepare(
        "INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at, notice_version, accepted_at) VALUES (?, ?, 1, 'x', 1, '2026-11-01T00:00:00.000Z')",
      ).run(PROJECT, USER_A);
      db.prepare("INSERT INTO cloud_sync_todo_counter (project_ref, install_id, edit_seq, clock_epoch) VALUES (?, 'old-install-id', 40, 2)").run(PROJECT);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("pr3 era", I1);
      db.prepare("DELETE FROM transaction_checklist_items WHERE id = ?").run(I2);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash")).toBe(1);
      db.prepare("INSERT INTO cloud_sync_state (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, removed, updated_at) VALUES (?, ?, 'checklist_item', ?, 'd', 'c', 0, 'x')").run(PROJECT, USER_A, I1);
      return db;
    }

    it("runs once: the outbox, trash and old one-way item records go, stale counter rows go, the counter is seeded, a full pull is owed (PR-4b: the scan waits for it); the next pass does not redo it", () => {
      const db = pr3Profile();
      const pr3Ops = outbox(db).map((r) => r.op_id);
      expect(todos.prepareTodoPass(db, PROJECT, USER_A, new Date())).toEqual({ oneShot: true });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash")).toBe(0);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_state WHERE entity = 'checklist_item'")).toBe(0);
      expect(db.prepare("SELECT install_id, edit_seq FROM cloud_sync_todo_counter").all()).toEqual([{ install_id: INSTALL, edit_seq: 0 }]);
      expect(outbox(db)).toEqual([]);
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).toMatchObject({ last_seq: 0, full_pull_owed: 1 });
      for (const id of pr3Ops) expect(outbox(db).map((r) => r.op_id)).not.toContain(id);
      // a new edit after the step, then the next pass's prepare: nothing is cleared again
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("after", I1);
      const fp = outbox(db).map((r) => `${r.op_id}#${r.generation}`);
      expect(todos.prepareTodoPass(db, PROJECT, USER_A, new Date())).toEqual({ oneShot: false });
      expect(outbox(db).map((r) => `${r.op_id}#${r.generation}`)).toEqual(fp);
    });

    it("N1b: turned on before the install row existed (no counter): the pass seeds it before sending, and later edits carry edit_seq", async () => {
      const { db } = profile({ turnOn: false });
      db.exec("DELETE FROM cloud_sync_install");
      turnOn(db);
      expect(todos.getTodoCursor(db, PROJECT, USER_A)).not.toBeNull();
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter")).toBe(0);
      const e = engine(db);
      await startAndPass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter")).toBe(1);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("counted", I1);
      expect(outbox(db)[0].edit_seq).not.toBeNull();
    });

    it("N1b: an enabled user with no counter row gets one before any send; ops that had none (NULL edit_seq) are still sent, by time", async () => {
      const { db } = profile({ turnOn: false });
      db.prepare(
        "INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at, notice_version, accepted_at) VALUES (?, ?, 1, 'x', 1, '2026-11-01T00:00:00.000Z')",
      ).run(PROJECT, USER_A);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter")).toBe(0);
      const e = engine(db);
      await startAndPass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter")).toBe(1);
      expect(outbox(db)).toEqual([]);
      expect(e.server.todos).toHaveLength(4);
    });
  });

  // ================================================================ the premise of the initial scan (coordinator 2026-11-17)
  describe("P: the initial scan never duplicates a todo or overwrites a newer cloud value", () => {
    async function onlineBeforeThisBuild() {
      // The old one-way path uploaded the todos; PR-2's backfill gave them desktop:<install> parts, no edit_seq.
      const { db } = profile({ turnOn: false });
      db.prepare(
        "INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at, notice_version, accepted_at) VALUES (?, ?, 1, 'x', 1, '2026-11-01T00:00:00.000Z')",
      ).run(PROJECT, USER_A);
      const e = engine(db);
      await startAndPass(e);
      for (const t of e.server.todos) for (const p of Object.values(t.parts)) p.edit_seq = null;
      e.server.todoLedger.clear();
      // forget everything locally, as a pre-4a profile has no shadow
      db.exec("DELETE FROM cloud_sync_todo_state; DELETE FROM cloud_sync_todo_outbox; DELETE FROM cloud_sync_todo_cursor");
      return { db, e };
    }

    it("todos already online from this computer: the scan's creates answer exists, the count is unchanged, the local values stand (same install)", async () => {
      const { db, e } = await onlineBeforeThisBuild();
      db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, 'x')").run();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("edited here, never sent", I1);
      db.exec("DELETE FROM cloud_sync_applying");
      await pass(e);
      expect(e.server.todos).toHaveLength(4);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("edited here, never sent");
      expect(outbox(db)).toEqual([]);
    });

    it("a part another side changed online (from PR-5: an AI app): the scan's create loses (unknowable time), the cloud value stays online and is written locally", async () => {
      const { db, e } = await onlineBeforeThisBuild();
      const t = onlineItem(e, I1)!;
      t.parts.note = { rev: t.parts.note.rev + 1, value: "set by an AI app", at: Date.now() - 3_600_000, by: "ai_app:conn-1", edit_seq: null };
      await pass(e);
      expect(e.server.todos).toHaveLength(4);
      expect(onlineItem(e, I1)!.parts.note.value).toBe("set by an AI app");
      expect(item(db, I1).note).toBe("set by an AI app");
      expect(shadow(db, I1)!.note_rev).toBe(t.parts.note.rev);
    });

    it("two local users (PR-4b order): one user's turn-on owes only that user's full pull; the scan that pull ends with queues only that user's todos", () => {
      const { db } = profile();
      const deal = dealId();
      insertDeal(db, deal, USER_B);
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 80), deal, "tpl-b", "B list", 0);
      todos.scanTodos(db, PROJECT, USER_A, new Date());
      const aRows = outbox(db).map((r) => `${r.op_id}#${r.generation}`);
      expect(outbox(db, USER_B)).toEqual([]);
      turnOn(db, USER_B);
      expect(outbox(db, USER_B)).toEqual([]);
      expect(todos.getTodoCursor(db, PROJECT, USER_B)).toMatchObject({ full_pull_owed: 1 });
      // B's (empty) full pull, through the real page applier
      const counts = applyTodoPage(db, { projectRef: PROJECT, userId: USER_B, installId: INSTALL, now: new Date() }, { rows: [], next_after: 0, horizon: 0, install_max_edit_seq: null }, 500);
      expect(counts).toMatchObject({ complete: true, fullPullDone: true, scanned: 1 });
      expect(keys(outbox(db, USER_B))).toEqual([`checklist:${fid(3, 80)}:create`]);
      expect(outbox(db).map((r) => `${r.op_id}#${r.generation}`)).toEqual(aRows);
    });
  });

  // ================================================================ My items (contract my_items @ 00bd934db)
  describe("My items: mapped to the live list online; never removed except with its deal", () => {
    it("a My items list already live online under another local id: the create answers mapped, the shadow takes that cloud id, the local list stays, its items are added to the online list, no second list", async () => {
      const { db, deal } = profile({ turnOn: false });
      const e = engine(db);
      // the deal online with a My items list made elsewhere (as an AI app will from PR-5)
      e.server.override = null;
      db.prepare(
        "INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at, notice_version, accepted_at) VALUES (?, ?, 1, 'x', 1, '2026-11-01T00:00:00.000Z')",
      ).run(PROJECT, USER_A);
      const real = e.server.transport;
      let seeded = false;
      setTransport(e, async (f, a, sig) => {
        const r = await real(f, a, sig);
        if (f === "cloud_upsert_deal" && !seeded) {
          seeded = true;
          const d = e.server.deals.find((x) => x.localId === deal)!;
          e.server.todos.push({
            id: fid(70, 1), owner: USER_A, dealId: d.id, entity: "checklist", localId: fid(70, 1), checklistId: null, templateId: MY_ITEMS_TEMPLATE_ID, removed: false,
            parts: { order: { rev: 1, value: 0, at: -Infinity, by: "ai_app:conn-1", edit_seq: null }, removed: { rev: 1, value: { removed_at: null, kind: null }, at: -Infinity, by: "ai_app:conn-1", edit_seq: null } },
          });
        }
        return r;
      });
      await startAndPass(e);
      const answers = [...e.server.todoLedger.values()] as Array<Record<string, unknown>>;
      expect(answers.find((x) => x.cloud_id === fid(70, 1))?.status).toBe("mapped");
      expect(shadow(db, MY)!.cloud_id).toBe(fid(70, 1));
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_checklists WHERE id = ?", MY)).toBe(1);
      expect(e.server.todos.filter((t) => t.entity === "checklist" && t.templateId === MY_ITEMS_TEMPLATE_ID)).toHaveLength(1);
      expect(onlineItem(e, I2)!.checklistId).toBe(fid(70, 1));
      expect(outbox(db)).toEqual([]);
    });

    it("a My items list removed locally by any path but its deal: the server's not_allowed is final (op dropped, notice kept), never retried", async () => {
      const { db, e } = await sentOnce();
      // the app's own delete statement refuses My items (BACKLOG-3966); a direct delete stands for any other writer
      db.prepare("DELETE FROM transaction_checklists WHERE id = ?").run(MY);
      expect(keys(outbox(db))).toContain(`checklist:${MY}:removed`);
      await pass(e);
      const remove = allOps(e).find((o) => o.kind === "remove" && o.local_id === MY);
      expect(remove).toBeDefined();
      expect(outbox(db).filter((r) => r.local_id === MY)).toEqual([]);
      expect(db.prepare("SELECT kind FROM cloud_sync_todo_notices WHERE local_id = ?").all(MY)).toEqual([{ kind: "not_allowed" }]);
      const calls = pushes(e).length;
      await pass(e);
      expect(pushes(e)).toHaveLength(calls);
      expect(e.server.todos.find((t) => t.localId === MY)!.removed).toBe(false);
    });
  });

  // ================================================================ users on one computer
  describe("U: another local user's ops; a never-on user", () => {
    it("the signed-in user's pass sends only that user's ops; another enabled user's (whose deal is online) wait for that user's own pass", async () => {
      const { db } = profile();
      const deal = dealId();
      insertDeal(db, deal, USER_B);
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 81), deal, "tpl-b", "B list", 0);
      turnOn(db, USER_B);
      // B's own pass uploads B's deal and todos (B signed in)
      const eb = makeEngine(db, { user: USER_B });
      eb.clock.now = new Date();
      await startAndPass(eb);
      expect(outbox(db, USER_B)).toEqual([]);
      eb.service.refreshSchedule();
      // B edits, then A signs in on the same computer
      db.prepare("UPDATE transaction_checklists SET sort_order = 3 WHERE id = ?").run(fid(3, 81));
      expect(outbox(db, USER_B)).toHaveLength(1);
      const e = engine(db);
      await startAndPass(e);
      expect(allOps(e).map((o) => o.local_id)).not.toContain(fid(3, 81));
      expect(outbox(db, USER_B)).toHaveLength(1);
      expect(pushes(e).every((c) => c.args.p_expected_user_id === USER_A)).toBe(true);
    });

    it("a never-on user's outbox (even a stray row) is never read, dropped or sent by another user's pass", async () => {
      const { db } = profile();
      db.prepare(
        "INSERT INTO cloud_sync_todo_outbox (project_ref, owner_user_id, entity, local_id, part, value_json, edited_at, op_id) VALUES (?, ?, 'item', ?, 'note', '{}', 'x', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')",
      ).run(PROJECT, USER_B, I1);
      const e = engine(db);
      await startAndPass(e);
      expect(allOps(e).map((o) => normOpId(o.op_id))).not.toContain("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      expect(outbox(db, USER_B)).toHaveLength(1);
    });

    it("a profile with nobody on makes no todo call", async () => {
      const { db } = profile({ turnOn: false });
      const e = engine(db);
      await startAndPass(e);
      expect(pushes(e)).toHaveLength(0);
    });
  });

  // ================================================================ clock (E2)
  describe("E2: what the desktop sends for the clock", () => {
    it("ops of an earlier epoch (and scan ops) are sent clock_stepped; current-epoch and counter-less ops are not; a backward step seen at send time bumps the epoch", async () => {
      const { db, e } = await sentOnce();
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("before the step", I1);
      expect(outbox(db)[0].clock_epoch).toBe(0);
      // the wall clock had been 10 minutes ahead (max_wall_seen) and was set back
      db.prepare("UPDATE cloud_sync_todo_counter SET max_wall_seen = ?").run(new Date(Date.now() + 600_000).toISOString());
      await pass(e);
      expect(db.prepare("SELECT clock_epoch FROM cloud_sync_todo_counter").get()).toEqual({ clock_epoch: 1 });
      expect(opsOf(e)[0]).toMatchObject({ clock_stepped: true, edited_at: expect.stringMatching(/Z$/) });
      const r = (epoch: number | null) => ({ clock_epoch: epoch }) as OutboxRow;
      expect([r(1), r(null), r(0), r(SCAN_EPOCH)].map((x) => (encodeOp({ ...x, entity: "item", part: "note", local_id: "i", op_id: "a".repeat(32), edited_at: "x", value_json: "{}" } as OutboxRow, { cloudDealId: "d", currentEpoch: 1 }) as Row).clock_stepped)).toEqual([false, false, true, true]);
    });
  });

  // ================================================================ deals and waiting
  describe("ops wait for their deal; ops of a deal gone everywhere are dropped", () => {
    it("a deal deleted online and purged there (30 days), then eligible again under a NEW online id: its todos are created on the new deal", async () => {
      const { db, deal, e } = await sentOnce();
      db.prepare("UPDATE transactions SET status = 'rejected' WHERE id = ?").run(deal);
      await pass(e);
      const oldId = e.server.softRemovedDeals.find((d) => d.localId === deal)!.id;
      // the purge: the deal and its todos are gone online
      e.server.softRemovedDeals = [];
      e.server.todos = [];
      db.prepare("UPDATE transactions SET status = 'active' WHERE id = ?").run(deal);
      await pass(e);
      const newDeal = e.server.deals.find((d) => d.localId === deal)!;
      expect(newDeal.id).not.toBe(oldId);
      expect(e.server.todos.filter((t) => t.dealId === newDeal.id).map((t) => `${t.entity}:${t.localId}`).sort()).toEqual(
        [`checklist:${CL}`, `checklist:${MY}`, `item:${I1}`, `item:${I2}`],
      );
      expect(outbox(db)).toEqual([]);
    });

    it("a deal deleted online (no longer eligible), then eligible again (un-removed under the same online id): its todos are sent again and answer exists, none duplicated", async () => {
      const { db, deal, e } = await sentOnce();
      db.prepare("UPDATE transactions SET status = 'rejected' WHERE id = ?").run(deal);
      await pass(e);
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(1);
      db.prepare("UPDATE transactions SET status = 'active' WHERE id = ?").run(deal);
      await pass(e);
      const newDeal = e.server.deals.find((d) => d.localId === deal)!;
      expect(newDeal).toBeDefined();
      expect(e.server.todos).toHaveLength(4);
      expect(e.server.todos.filter((t) => t.dealId === newDeal.id).map((t) => `${t.entity}:${t.localId}`).sort()).toEqual(
        [`checklist:${CL}`, `checklist:${MY}`, `item:${I1}`, `item:${I2}`],
      );
      expect(outbox(db)).toEqual([]);
    });

    it("a deal not online yet (not eligible): its todos wait; once it is uploaded they go", async () => {
      const { db, e } = await sentOnce();
      const deal = dealId();
      insertDeal(db, deal, USER_A, { status: "rejected" });
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 90), deal, "tpl-9", "Nine", 0);
      await pass(e);
      expect(keys(outbox(db))).toEqual([`checklist:${fid(3, 90)}:create`]);
      db.prepare("UPDATE transactions SET status = 'active' WHERE id = ?").run(deal);
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(e.server.todos.some((t) => t.localId === fid(3, 90))).toBe(true);
    });

    it("a deal deleted here that was never online: its waiting ops are dropped, nothing is sent", async () => {
      const { db, e } = await sentOnce();
      const deal = dealId();
      insertDeal(db, deal, USER_A, { status: "rejected" });
      db.prepare(INSERT_CHECKLIST_SQL).run(fid(3, 91), deal, "tpl-9", "Nine", 0);
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM transactions WHERE id = ?").run(deal);
      db.pragma("foreign_keys = ON");
      const before = pushes(e).length;
      await pass(e);
      expect(outbox(db)).toEqual([]);
      expect(pushes(e)).toHaveLength(before);
    });
  });
});
