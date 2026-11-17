/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-3 — the todo capture triggers (cloudSyncTodoSql.ts), driven by the app's own
 * checklist statements (checklistSql.ts). Driver: see helpers/sqlite.ts (the title names the one
 * that ran). Neither driver registers any app SQL function, so every test here also runs the
 * triggers on a plain connection (D1).
 *
 *   T1  each kind of change records exactly one outbox row for its part (add, tick, untick, title,
 *       note, due date, reorder, remove; checklist add, reorder, remove)
 *   T2  an UPDATE that leaves a part's value unchanged records nothing
 *   T3  a re-edit of a part still waiting: one row, new op_id, generation + 1, base_rev kept
 *   T4  edit_seq rises by one per recorded change (R3); the counter holds the last one
 *   T5  epoch (E2): a backward step of more than 120 s bumps it; a step under 120 s does not
 *   T6  no counter row: the write succeeds, one row, NULL edit_seq and clock_epoch
 *   T7  W24: a second local user who never turned Keepr Cloud on records nothing and never raises
 *   T8  D7 / W10: the apply guard stops every op and the counter, never the trash archive
 *   T9  R7 cascades: direct item delete, checklist delete, deal delete
 *   T10 ACID: a rolled-back user write leaves no op and the counter where it was
 *   C32 no trigger names an app-registered function: plain connection run + static check
 */
import fs from "fs";
import path from "path";
import { CLOUD_SYNC_TRIGGERS } from "../../db/cloudSyncSql";
import { CLOUD_SYNC_TODO_TABLES, CLOUD_SYNC_TODO_TRIGGERS } from "../../db/cloudSyncTodoSql";
import { enableForUser } from "../../db/cloudSyncDbService";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  DELETE_CHECKLIST_IN_TRANSACTION_SQL,
  DELETE_PRIVATE_ITEM_SQL,
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_LINK_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_EMAIL_MEMBER_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  RENAME_PRIVATE_ITEM_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  SET_ITEM_SORT_ORDER_SQL,
} from "../../db/checklistSql";
import { DRIVER, openTestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, SCHEMA_SQL, seedUser, USER_A, USER_B } from "./helpers/fixtures";
import type { TestDb } from "./helpers/sqlite";

type Row = Record<string, unknown>;
/** Invented all-zero-pattern ids: 00000000-0000-0000-<kind>-<n>. */
const fakeId = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const INSTALL = fakeId(98, 1);
const DEAL_A = dealId(4263001);
const DEAL_B = dealId(4263002);
const CL = fakeId(3, 4263);
const MY = fakeId(3, 4264);
const CL_B = fakeId(3, 4265);
const MY_B = fakeId(3, 4266);
const item = (n: number) => fakeId(4, n);

/** USER_A has Keepr Cloud on (the engine's own turn-on writer, install row first); USER_B never did. */
function setup(opts: { install?: boolean } = {}): TestDb {
  const db = freshDb();
  if (opts.install !== false) {
    db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, NULL, '2026-11-01T00:00:00.000Z')").run(
      PROJECT,
      INSTALL,
    );
  }
  enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" });
  insertDeal(db, DEAL_A, USER_A);
  insertDeal(db, DEAL_B, USER_B);
  db.prepare(INSERT_CHECKLIST_SQL).run(CL, DEAL_A, "tpl-1", "Purchase", 0);
  db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(MY, DEAL_A, MY_ITEMS_TEMPLATE_ID, "My items", 1);
  db.prepare(INSERT_CHECKLIST_SQL).run(CL_B, DEAL_B, "tpl-1", "Purchase", 0);
  db.prepare(INSERT_PRIVATE_CHECKLIST_SQL).run(MY_B, DEAL_B, MY_ITEMS_TEMPLATE_ID, "My items", 1);
  return db;
}

const addItem = (db: TestDb, id: string, checklist: string, title = "Inspection", sort = 0) =>
  db.prepare(INSERT_CHECKLIST_ITEM_SQL).run(id, checklist, title, null, 0, null, sort);

const outbox = (db: TestDb) =>
  db.prepare("SELECT * FROM cloud_sync_todo_outbox ORDER BY rowid").all() as Row[];
const keyOf = (r: Row) => `${r.entity}:${r.local_id}:${r.part}`;
const fingerprint = (db: TestDb) => new Map(outbox(db).map((r) => [keyOf(r), `${r.op_id}#${r.generation}`]));
const trash = (db: TestDb) => db.prepare("SELECT * FROM cloud_sync_todo_trash ORDER BY entity, local_id").all() as Row[];
const counter = (db: TestDb) => db.prepare("SELECT edit_seq, clock_epoch, max_wall_seen FROM cloud_sync_todo_counter").get() as Row | undefined;
const n = (db: TestDb, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

/** The outbox keys a write added or changed. */
function opsOf(db: TestDb, run: () => void): string[] {
  const before = fingerprint(db);
  run();
  return [...fingerprint(db)].filter(([k, v]) => before.get(k) !== v).map(([k]) => k).sort();
}

describe(`Keepr Cloud todo capture [${DRIVER}]`, () => {
  it("there are 6 todo triggers, all in CLOUD_SYNC_TRIGGERS under the trg_cloud_sync_ prefix (28 in all)", () => {
    expect(CLOUD_SYNC_TODO_TRIGGERS.map((t) => t.name).sort()).toEqual([
      "trg_cloud_sync_todo_checklist_delete",
      "trg_cloud_sync_todo_checklist_insert",
      "trg_cloud_sync_todo_checklist_update",
      "trg_cloud_sync_todo_item_delete",
      "trg_cloud_sync_todo_item_insert",
      "trg_cloud_sync_todo_item_update",
    ]);
    const db = setup();
    const live = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%'").all() as Row[];
    expect(live).toHaveLength(28);
    expect(live.map((r) => r.name).sort()).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.close();
  });

  it("T1 each kind of change records exactly one outbox row for its part", () => {
    const db = setup();
    // setup's two checklist inserts on DEAL_A were recorded as creates (and DEAL_B's were not).
    expect(outbox(db).map(keyOf).sort()).toEqual([`checklist:${CL}:create`, `checklist:${MY}:create`]);
    const I = item(1);
    expect(opsOf(db, () => addItem(db, I, MY, "Call lender"))).toEqual([`item:${I}:create`]);
    expect(opsOf(db, () => db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, I))).toEqual([`item:${I}:done`]);
    expect(opsOf(db, () => db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(0, 0, I))).toEqual([`item:${I}:done`]);
    expect(opsOf(db, () => db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Call the lender", I, DEAL_A, MY_ITEMS_TEMPLATE_ID))).toEqual([`item:${I}:title`]);
    expect(opsOf(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("Tuesday", I))).toEqual([`item:${I}:note`]);
    expect(opsOf(db, () => db.prepare("UPDATE transaction_checklist_items SET due_date = ? WHERE id = ?").run("2026-12-01", I))).toEqual([`item:${I}:due`]);
    expect(opsOf(db, () => db.prepare(SET_ITEM_SORT_ORDER_SQL).run(3, I, MY))).toEqual([`item:${I}:order`]);
    expect(opsOf(db, () => db.prepare("UPDATE transaction_checklists SET sort_order = 5 WHERE id = ?").run(CL))).toEqual([`checklist:${CL}:order`]);
    const values = Object.fromEntries(outbox(db).map((r) => [keyOf(r), JSON.parse(r.value_json as string)]));
    expect(values[`item:${I}:done`]).toEqual({ is_checked: 0, checked_at: null });
    expect(values[`item:${I}:title`]).toEqual({ title: "Call the lender" });
    expect(values[`item:${I}:note`]).toEqual({ note: "Tuesday" });
    expect(values[`item:${I}:due`]).toEqual({ due_date: "2026-12-01" });
    expect(values[`item:${I}:order`]).toEqual({ sort_order: 3 });
    expect(values[`item:${I}:create`]).toMatchObject({ id: I, checklist_id: MY, title: "Call lender", is_checked: 0 });
    expect(outbox(db).every((r) => r.transaction_id === DEAL_A && r.owner_user_id === USER_A && r.project_ref === PROJECT)).toBe(true);
    expect(opsOf(db, () => db.prepare(DELETE_PRIVATE_ITEM_SQL).run(I, DEAL_A, MY_ITEMS_TEMPLATE_ID))).toEqual([`item:${I}:removed`]);
    expect(opsOf(db, () => db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL, DEAL_A))).toEqual([`checklist:${CL}:removed`]);
    db.close();
  });

  it("T2 an UPDATE that leaves a part's value unchanged records nothing", () => {
    const db = setup();
    const I = item(2);
    addItem(db, I, MY, "Same", 4);
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("Same note", I);
    expect(opsOf(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("Same note", I))).toEqual([]);
    expect(opsOf(db, () => db.prepare(SET_ITEM_SORT_ORDER_SQL).run(4, I, MY))).toEqual([]);
    expect(opsOf(db, () => db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Same", I, DEAL_A, MY_ITEMS_TEMPLATE_ID))).toEqual([]);
    expect(opsOf(db, () => db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(0, 0, I))).toEqual([]);
    db.close();
  });

  it("T3 a re-edit of a part still waiting replaces its value with a new op_id and edit_seq, bumps generation, and keeps base_rev", () => {
    const db = setup();
    const I = item(3);
    addItem(db, I, MY);
    db.prepare(
      "INSERT INTO cloud_sync_todo_state (project_ref, owner_user_id, entity, local_id, note_rev, updated_at) VALUES (?, ?, 'item', ?, 7, 'x')",
    ).run(PROJECT, USER_A, I);
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("first", I);
    const first = outbox(db).find((r) => keyOf(r) === `item:${I}:note`)!;
    expect(first).toMatchObject({ base_rev: 7, generation: 1 });
    // A pull may not move the shadow of a part with a pending op; even if it did, the base stays.
    db.prepare("UPDATE cloud_sync_todo_state SET note_rev = 9 WHERE local_id = ?").run(I);
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("second", I);
    const rows = outbox(db).filter((r) => keyOf(r) === `item:${I}:note`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ base_rev: 7, generation: 2, value_json: JSON.stringify({ note: "second" }) });
    expect(rows[0].op_id).not.toBe(first.op_id);
    expect(rows[0].edit_seq as number).toBeGreaterThan(first.edit_seq as number);
    // A part never sent before has no base.
    expect(outbox(db).find((r) => keyOf(r) === `item:${I}:create`)!.base_rev).toBeNull();
    db.close();
  });

  it("T4 edit_seq rises by exactly one per recorded change, across items and checklists; the counter holds the last", () => {
    const db = setup();
    expect(counter(db)).toMatchObject({ edit_seq: 2, clock_epoch: 0 }); // the two checklist creates
    addItem(db, item(41), CL, "A");
    addItem(db, item(42), CL, "B");
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("n", item(41));
    // One UPDATE changing two parts of one item is one change: both parts share its edit_seq.
    db.prepare("UPDATE transaction_checklist_items SET note = 'm', sort_order = 9 WHERE id = ?").run(item(42));
    const seqs = outbox(db).map((r) => [keyOf(r), r.edit_seq]);
    expect(seqs).toEqual([
      [`checklist:${CL}:create`, 1],
      [`checklist:${MY}:create`, 2],
      [`item:${item(41)}:create`, 3],
      [`item:${item(42)}:create`, 4],
      [`item:${item(41)}:note`, 5],
      [`item:${item(42)}:note`, 6],
      [`item:${item(42)}:order`, 6],
    ]);
    expect(counter(db)).toMatchObject({ edit_seq: 6 });
    db.close();
  });

  it("T5 epoch: a backward wall-clock step of more than 120 s bumps it; a step under 120 s does not (driven through max_wall_seen; the exact 120 s boundary needs an injected clock and is not hit here)", () => {
    const db = setup();
    const ahead = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    addItem(db, item(51), CL);
    expect(counter(db)).toMatchObject({ clock_epoch: 0 });
    // The clock is now 60 s behind the highest time seen: not a step.
    const at60 = ahead(60);
    db.prepare("UPDATE cloud_sync_todo_counter SET max_wall_seen = ?").run(at60);
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("a", item(51));
    expect(counter(db)).toMatchObject({ clock_epoch: 0, max_wall_seen: at60 });
    expect(outbox(db).find((r) => keyOf(r) === `item:${item(51)}:note`)!.clock_epoch).toBe(0);
    // 10 minutes behind: a step. The epoch moves, the op carries the new one, and the clock is re-anchored.
    db.prepare("UPDATE cloud_sync_todo_counter SET max_wall_seen = ?").run(ahead(600));
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("b", item(51));
    const c = counter(db)!;
    expect(c.clock_epoch).toBe(1);
    expect(Date.parse(c.max_wall_seen as string)).toBeLessThanOrEqual(Date.now());
    expect(outbox(db).find((r) => keyOf(r) === `item:${item(51)}:note`)!.clock_epoch).toBe(1);
    // An earlier op keeps its older epoch (the runner flags it, PR-4a).
    expect(outbox(db).find((r) => keyOf(r) === `item:${item(51)}:create`)!.clock_epoch).toBe(0);
    // Moving forward again: no bump; max_wall_seen follows the clock.
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("c", item(51));
    expect(counter(db)!.clock_epoch).toBe(1);
    db.close();
  });

  it("T6 with no counter row (no install row at turn-on, or cleared by a rebind) every write succeeds and records one row with NULL edit_seq and clock_epoch", () => {
    for (const how of ["no install", "row deleted"] as const) {
      const db = setup({ install: how !== "no install" });
      if (how === "row deleted") db.exec("DELETE FROM cloud_sync_todo_counter");
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter")).toBe(0);
      expect(opsOf(db, () => addItem(db, item(61), MY))).toEqual([`item:${item(61)}:create`]);
      expect(opsOf(db, () => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("x", item(61)))).toEqual([`item:${item(61)}:note`]);
      expect(opsOf(db, () => db.prepare(DELETE_PRIVATE_ITEM_SQL).run(item(61), DEAL_A, MY_ITEMS_TEMPLATE_ID))).toEqual([`item:${item(61)}:removed`]);
      expect(outbox(db).filter((r) => (r.local_id as string) === item(61)).every((r) => r.edit_seq === null && r.clock_epoch === null)).toBe(true);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_counter")).toBe(0);
      db.close();
    }
  });

  it("T7 W24: a second local user who never turned Keepr Cloud on (triggers present) ticks, notes, adds, removes: every write succeeds, nothing is recorded, the counter does not move", () => {
    const db = setup();
    const before = { ops: outbox(db).length, trash: trash(db).length, counter: counter(db) };
    expect(() => {
      addItem(db, item(71), MY_B, "Theirs");
      addItem(db, item(72), CL_B, "Template item");
      db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(1, 1, item(72));
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("mine", item(72));
      db.prepare(RENAME_PRIVATE_ITEM_SQL).run("Theirs 2", item(71), DEAL_B, MY_ITEMS_TEMPLATE_ID);
      db.prepare(SET_ITEM_SORT_ORDER_SQL).run(2, item(72), CL_B);
      db.prepare(DELETE_PRIVATE_ITEM_SQL).run(item(71), DEAL_B, MY_ITEMS_TEMPLATE_ID);
      db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL_B, DEAL_B);
      db.prepare("DELETE FROM transactions WHERE id = ?").run(DEAL_B);
    }).not.toThrow();
    expect({ ops: outbox(db).length, trash: trash(db).length, counter: counter(db) }).toEqual(before);
    db.close();
  });

  /** An item with one email link carrying one member. */
  function linkedItem(db: TestDb, id: string, checklist: string, k: number): void {
    addItem(db, id, checklist, `Linked ${k}`, k);
    db.prepare("INSERT INTO emails (id, user_id, external_id, source, subject, sender) VALUES (?, ?, ?, 'gmail', 'Offer', 'agent@example.test')").run(
      `email-${k}`,
      USER_A,
      `ext-${k}`,
    );
    db.prepare(INSERT_CHECKLIST_LINK_SQL).run(`link-${k}`, id, "email", `Offer ${k}`, 0, 0);
    db.prepare(INSERT_EMAIL_MEMBER_SQL).run(`member-${k}`, `link-${k}`, `email-${k}`);
  }
  const payloadOf = (r: Row) => JSON.parse(r.payload_json as string);

  it("T8 D7 / W10: with the apply guard set, no op is recorded and the counter does not move, but every removal is still archived with its links and members", () => {
    const db = setup();
    linkedItem(db, item(81), CL, 1);
    linkedItem(db, item(82), MY, 2);
    addItem(db, item(83), CL, "Other", 9);
    const opsBefore = fingerprint(db);
    const counterBefore = counter(db);
    db.prepare("INSERT INTO cloud_sync_applying (id, started_at) VALUES (1, '2026-11-17T00:00:00.000Z')").run();
    addItem(db, item(84), CL, "Pulled");
    db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("pulled", item(83));
    db.prepare("UPDATE transaction_checklists SET sort_order = 7 WHERE id = ?").run(CL);
    db.prepare(DELETE_PRIVATE_ITEM_SQL).run(item(82), DEAL_A, MY_ITEMS_TEMPLATE_ID);
    db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL, DEAL_A);
    expect(fingerprint(db)).toEqual(opsBefore);
    expect(counter(db)).toEqual(counterBefore);
    const t = trash(db);
    expect(t.map((r) => `${r.entity}:${r.local_id}:${r.removed_with ?? "-"}`).sort()).toEqual(
      [`checklist:${CL}:-`, `item:${item(81)}:${CL}`, `item:${item(82)}:-`, `item:${item(83)}:${CL}`, `item:${item(84)}:${CL}`].sort(),
    );
    expect(payloadOf(t.find((r) => r.local_id === item(82))!).links).toEqual([
      expect.objectContaining({ id: "link-2", kind: "email", members: [expect.objectContaining({ id: "member-2", email_id: "email-2" })] }),
    ]);
    // The guard row gone: capture resumes.
    db.exec("DELETE FROM cloud_sync_applying");
    expect(opsOf(db, () => addItem(db, item(85), MY))).toEqual([`item:${item(85)}:create`]);
    db.close();
  });

  it("T9 R7: a direct item delete records one removal and one trash row; a checklist delete one checklist removal, no item removal, its items archived; a deal delete nothing", () => {
    const db = setup();
    linkedItem(db, item(91), MY, 1);
    linkedItem(db, item(92), CL, 2);
    linkedItem(db, item(93), CL, 3);
    // Direct item delete.
    expect(opsOf(db, () => db.prepare(DELETE_PRIVATE_ITEM_SQL).run(item(91), DEAL_A, MY_ITEMS_TEMPLATE_ID))).toEqual([`item:${item(91)}:removed`]);
    expect(trash(db).map((r) => `${r.entity}:${r.local_id}`)).toEqual([`item:${item(91)}`]);
    const direct = trash(db)[0];
    expect(direct).toMatchObject({ transaction_id: DEAL_A, checklist_id: MY, removed_with: null, owner_user_id: USER_A });
    expect(payloadOf(direct)).toMatchObject({
      item: { id: item(91), title: "Linked 1" },
      links: [{ id: "link-1", members: [{ id: "member-1", email_id: "email-1", kind: "email" }] }],
    });
    // Checklist delete.
    expect(opsOf(db, () => db.prepare(DELETE_CHECKLIST_IN_TRANSACTION_SQL).run(CL, DEAL_A))).toEqual([`checklist:${CL}:removed`]);
    expect(trash(db).map((r) => `${r.entity}:${r.local_id}:${r.removed_with ?? "-"}`).sort()).toEqual(
      [`checklist:${CL}:-`, `item:${item(91)}:-`, `item:${item(92)}:${CL}`, `item:${item(93)}:${CL}`].sort(),
    );
    expect(payloadOf(trash(db).find((r) => r.local_id === item(93))!).links[0].members[0]).toMatchObject({ id: "member-3" });
    expect(outbox(db).filter((r) => r.part === "removed").map(keyOf).sort()).toEqual([`checklist:${CL}:removed`, `item:${item(91)}:removed`].sort());
    // Deal delete (its My items checklist and an item on it).
    addItem(db, item(94), MY);
    const ops = fingerprint(db);
    const trashCount = trash(db).length;
    const seq = counter(db);
    db.prepare("DELETE FROM transactions WHERE id = ?").run(DEAL_A);
    expect(fingerprint(db)).toEqual(ops);
    expect(trash(db)).toHaveLength(trashCount);
    expect(counter(db)).toEqual(seq);
    db.close();
  });

  it("T10 ACID: a user write whose transaction rolls back leaves no op and the counter where it was; one that commits leaves both", () => {
    const db = setup();
    addItem(db, item(101), MY);
    const ops = fingerprint(db);
    const seq = counter(db);
    expect(() =>
      db.transaction(() => {
        db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("lost", item(101));
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(fingerprint(db)).toEqual(ops);
    expect(counter(db)).toEqual(seq);
    db.transaction(() => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run("kept", item(101)))();
    expect(outbox(db).find((r) => keyOf(r) === `item:${item(101)}:note`)!.edit_seq).toBe((seq!.edit_seq as number) + 1);
    db.close();
  });
});

// ------------------------------------------------------------------ C32 (D1)

/** SQLite built-ins and keywords that may appear before "(" in trigger SQL. */
const SQL_BUILTINS = new Set([
  "strftime",
  "julianday",
  "json_object",
  "json_group_array",
  "json",
  "randomblob",
  "hex",
  "lower",
  "coalesce",
]);
const SQL_KEYWORDS = new Set(["EXISTS", "IN", "VALUES", "CONFLICT", "AND", "OR", "NOT", "THEN", "ELSE", "WHEN", "SELECT", "WHERE", "AS"]);

/** Every identifier written as a call (`name(`) in some SQL, excluding table names given. */
function calledNames(sqlText: string, tables: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of sqlText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = m[1];
    if (SQL_KEYWORDS.has(name.toUpperCase()) || tables.has(name)) continue;
    out.add(name);
  }
  return [...out].sort();
}

/** Names registered with `.function("name"` / `.aggregate("name"` in a source text. */
function registeredFunctionNames(source: string): string[] {
  return [...source.matchAll(/\.(?:function|aggregate)\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g)].map((m) => m[1]);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe(`C32 no trigger names an app-registered SQL function [${DRIVER}]`, () => {
  const ROOT = path.join(__dirname, "..", "..", "..", "..");

  it("every one of the 28 triggers is created and fires on a plain connection with no app function registered; no insert, update or delete on any table they watch raises", () => {
    const db = openTestDb(); // a bare connection: nothing registered
    db.exec(SCHEMA_SQL);
    db.pragma("foreign_keys = ON");
    for (const t of CLOUD_SYNC_TRIGGERS) db.exec(t.sql);
    seedUser(db, USER_A, "a@example.test");
    db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, created_at) VALUES (?, ?, 'x')").run(PROJECT, INSTALL);
    db.prepare("INSERT INTO cloud_sync_settings (project_ref, user_id, enabled) VALUES (?, ?, 1)").run(PROJECT, USER_A);
    db.prepare("INSERT INTO cloud_sync_todo_counter (project_ref, install_id) VALUES (?, ?)").run(PROJECT, INSTALL);
    const deal = dealId(4263099);
    expect(() => {
      insertDeal(db, deal, USER_A);
      db.prepare("UPDATE transactions SET property_city = 'Elsewhere' WHERE id = ?").run(deal);
      db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES ('c32-c', ?, 'P', 'manual')").run(USER_A);
      db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES ('c32-tc', ?, 'c32-c', 'buyer')").run(deal);
      db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES ('c32-e', 'c32-c', 'p@example.test')").run();
      db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES ('c32-p', 'c32-c', '+12125550100')").run();
      db.prepare("INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method) VALUES ('c32-l', ?, 'c32-c', 'manual', 'r', 'manual')").run(USER_A);
      db.prepare("UPDATE contacts SET display_name = 'Q' WHERE id = 'c32-c'").run();
      db.prepare("UPDATE contact_emails SET email = 'q@example.test' WHERE id = 'c32-e'").run();
      db.prepare("UPDATE contact_phones SET phone_e164 = '+12125550101' WHERE id = 'c32-p'").run();
      db.prepare("UPDATE contact_source_links SET source_record_id = 's' WHERE id = 'c32-l'").run();
      db.prepare("UPDATE transaction_contacts SET role = 'seller' WHERE id = 'c32-tc'").run();
      db.prepare(INSERT_CHECKLIST_SQL).run("c32-cl", deal, "tpl", "List", 0);
      db.prepare("UPDATE transaction_checklists SET sort_order = 1, template_name = 'L2' WHERE id = 'c32-cl'").run();
      addItem(db, "c32-i", "c32-cl");
      db.prepare("UPDATE transaction_checklist_items SET is_checked = 1, checked_at = '2026-11-01', title = 'T', note = 'N', due_date = '2026-12-01', sort_order = 2 WHERE id = 'c32-i'").run();
      addItem(db, "c32-j", "c32-cl", "J", 3);
      db.prepare("DELETE FROM transaction_checklist_items WHERE id = 'c32-i'").run();
      db.prepare("DELETE FROM transaction_checklists WHERE id = 'c32-cl'").run();
      db.prepare("DELETE FROM contact_emails WHERE id = 'c32-e'").run();
      db.prepare("DELETE FROM contact_phones WHERE id = 'c32-p'").run();
      db.prepare("DELETE FROM contact_source_links WHERE id = 'c32-l'").run();
      db.prepare("DELETE FROM transaction_contacts WHERE id = 'c32-tc'").run();
      db.prepare("DELETE FROM transactions WHERE id = ?").run(deal);
    }).not.toThrow();
    // The todo triggers really ran on this connection (not a vacuous pass).
    expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_outbox")).toBeGreaterThanOrEqual(8);
    expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_trash")).toBe(3);
    db.close();
  });

  it("the trigger SQL calls only SQLite built-ins (allow-list), and none of the functions the app registers", () => {
    const db = freshDb({ triggers: false });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => r.name as string),
    );
    db.close();
    for (const t of CLOUD_SYNC_TODO_TABLES) expect(tables.has(t)).toBe(true);
    const called = calledNames(CLOUD_SYNC_TRIGGERS.map((t) => t.sql).join("\n"), tables);
    expect(called.filter((c) => !SQL_BUILTINS.has(c))).toEqual([]);
    // Positive control for the allow-list: a planted app function is reported.
    expect(calledNames("SELECT CASE WHEN 0 THEN keepr_mono_ns() ELSE NULL END", tables)).toEqual(["keepr_mono_ns"]);

    const registered = [path.join(ROOT, "electron"), path.join(ROOT, "src")]
      .flatMap(sourceFiles)
      .flatMap((f) => registeredFunctionNames(fs.readFileSync(f, "utf8")));
    // Positive control for the scanner: it finds the names a real test file registers.
    const timing = fs.readFileSync(path.join(ROOT, "electron", "services", "db", "core", "__tests__", "dbTiming.realDriver-2960.test.ts"), "utf8");
    expect(registeredFunctionNames(timing)).toEqual(expect.arrayContaining(["keepr_busy_wait", "keepr_busy_wait_tx"]));
    const allSql = CLOUD_SYNC_TRIGGERS.map((t) => t.sql).join("\n");
    expect(registered.filter((name) => new RegExp(`\\b${name}\\b`).test(allSql))).toEqual([]);
  });
});
