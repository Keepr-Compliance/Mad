/**
 * @jest-environment node
 *
 * BACKLOG-4263 P2 (SR review N1) — todo changes made on a computer while another computer was the account's active
 * one, then "Delete them" on the active computer removed this computer's online copy, then this computer moved back
 * ("Use this computer instead", the reclaim path of the move). Per kind of change: does it reach the server, and is
 * the local row as the user left it? The fake server's answers: helpers/fakeServer.ts.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, USER_A } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, DEVICE_1, type Engine } from "./helpers/engine";
import { FakeServer } from "./helpers/fakeServer";
import { enableForUser, ensureInstall } from "../../db/cloudSyncDbService";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  DELETE_CHECKLIST_IN_TRANSACTION_SQL,
  DELETE_PRIVATE_ITEM_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  RENAME_PRIVATE_ITEM_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_DUE_DATE_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  SET_ITEM_SORT_ORDER_SQL,
} from "../../db/checklistSql";

const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const CL = fid(3, 1);
const MY = fid(3, 2);
const I1 = fid(4, 1);
const I2 = fid(4, 2);
const NEW_ITEM = fid(4, 9);

type Row = Record<string, unknown>;

/** B was active and saved its deal and todos; A took over; A's "Delete them" removed B's online copy; B is refused. */
async function refusedAndRemoved() {
  const server = new FakeServer(USER_A);
  server.oneComputer = true;
  const clock = { t: Date.parse("2026-11-14T12:00:05.000Z") };
  server.serverNow = () => clock.t;
  const db: TestDb = freshDb();
  const deal = dealId();
  insertDeal(db, deal);
  db.prepare(INSERT_CHECKLIST_SQL).run(CL, deal, "tpl-1", "Purchase", 0);
  db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(MY, deal, MY_ITEMS_TEMPLATE_ID, "My items", 1);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I1, CL, "Inspection", null, 1, "inspection", 0);
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(I2, MY, "Call lender", null, 0, null, 0);
  const b = makeEngine(db, { server });
  ensureInstall(db, PROJECT, DEVICE_1);
  enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" });
  await startAndPass(b);
  await pass(b);
  expect(server.todos.filter((t) => !t.removed).length).toBe(4);
  const adb = freshDb();
  insertDeal(adb, dealId());
  const a: Engine = makeEngine(adb, { server });
  clock.t += 61_000;
  expect(await a.service.useThisComputer()).toEqual({ success: true });
  await a.service.runner!.whenIdle();
  expect(await a.service.deleteOldInstalls()).toEqual({ success: true });
  expect((await pass(b)).outcome).toBe("other_computer");
  return { server, clock, db, b, deal };
}

async function moveBack(h: Awaited<ReturnType<typeof refusedAndRemoved>>) {
  h.clock.t += 61_000;
  expect(await h.b.service.useThisComputer()).toEqual({ success: true });
  await h.b.service.runner!.whenIdle();
  for (let i = 0; i < 4; i++) await pass(h.b);
}

const online = (s: FakeServer, entity: string, local: string) => s.todos.find((t) => t.entity === entity && t.localId === local);
const part = (s: FakeServer, local: string, p: string) => online(s, "item", local)?.parts[p]?.value ?? null;
const localItem = (db: TestDb, id: string) => db.prepare("SELECT * FROM transaction_checklist_items WHERE id = ?").get(id) as Row | undefined;

describe(`Keepr Cloud: todo changes made while refused survive moving back after "Delete them" [${DRIVER}]`, () => {
  it("tick: reaches the server; the local row stays ticked", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I1);
    await moveBack(h);
    const done = part(h.server, I1, "done") as unknown;
    expect(done === true || (done as { is_checked?: boolean } | null)?.is_checked === true).toBe(true);
    expect(localItem(h.db, I1)?.is_checked).toBe(1);
  });

  it("note: reaches the server; the local row keeps it", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("call back", I1);
    await moveBack(h);
    expect(part(h.server, I1, "note")).toBe("call back");
    expect(localItem(h.db, I1)?.note).toBe("call back");
  });

  it("name (My item rename): reaches the server; the local row keeps it", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Call the lender", I2, h.deal, MY_ITEMS_TEMPLATE_ID);
    await moveBack(h);
    expect(part(h.server, I2, "title")).toBe("Call the lender");
    expect(localItem(h.db, I2)?.title).toBe("Call the lender");
  });

  it("due date: reaches the server; the local row keeps it", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(SET_CHECKLIST_ITEM_DUE_DATE_SQL).run("2026-12-01", I1, "2026-12-01");
    await moveBack(h);
    expect(part(h.server, I1, "due")).toBe("2026-12-01");
    expect(localItem(h.db, I1)?.due_date).toBe("2026-12-01");
  });

  it("reorder (My items): reaches the server; the local row keeps it", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(SET_ITEM_SORT_ORDER_SQL).run(5, I2, MY);
    await moveBack(h);
    expect(part(h.server, I2, "order")).toBe(5);
    expect(localItem(h.db, I2)?.sort_order).toBe(5);
  });

  it("create (a new My item): reaches the server; the local row stays", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(NEW_ITEM, MY, "New", null, 1, null, 1);
    await moveBack(h);
    expect(online(h.server, "item", NEW_ITEM)?.removed).toBe(false);
    expect(localItem(h.db, NEW_ITEM)).toBeDefined();
  });

  it("deletion (a My item): removed online; the local row does not come back", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I2, h.deal, MY_ITEMS_TEMPLATE_ID);
    await moveBack(h);
    expect(online(h.server, "item", I2)?.removed).toBe(true);
    expect(localItem(h.db, I2)).toBeUndefined();
  });

  it("deletion (a checklist with its item): removed online; the local rows do not come back", async () => {
    const h = await refusedAndRemoved();
    h.db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL, h.deal);
    await moveBack(h);
    expect(online(h.server, "checklist", CL)?.removed).toBe(true);
    expect(h.db.prepare("SELECT id FROM transaction_checklists WHERE id = ?").get(CL)).toBeUndefined();
    expect(localItem(h.db, I1)).toBeUndefined();
  });
});
