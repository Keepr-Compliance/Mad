/**
 * BACKLOG-4263 PR-11c — who last wrote an item's done and note parts (local v85 columns) and the two snapshot keys.
 *
 *   UI      the tick and note writers record the agent in the same statement; a cleared note clears the author; the
 *           same text keeps its author; an older build's write leaves the author not recorded
 *   CAP     author-only changes create no todo op; a note save with unchanged text creates none and keeps the author
 *   PULL    writeLocal / insertItem take the author from the pulled part (`by`, `app`, `at`); the stamp is the
 *           checked_at of the same statement; a server without the part's `app` stores an AI author with app NULL
 *   CONF    the confirm write-back writes the answer part's author with the value; a failed write-back re-applied
 *           later lands the value with every author column NULL
 *   DEL     turn-off, turn-on, reclaim, rebind, deal reset and the backup-restore reset leave the columns as they are
 *   SNAP    every item carries attribution_v 1; note_by only for a non-blank note with a valid author; kind is never
 *           defaulted; no tick author; the old snapshot function (keys read one by one) accepts the payload
 *
 * Ids are all-zero-style fakes.
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { dealId, freshDb, insertDeal, PROJECT, USER_A } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { FakeServer, type FakeTodo } from "./helpers/fakeServer";
import { disableForUser, enableForUser, reclaimInstallForUser } from "../../db/cloudSyncDbService";
import * as todos from "../../db/cloudSyncTodoDbService";
import { actionFor } from "../todos/answers";
import type { OutboxRow } from "../todos/wire";
import { MY_ITEMS_TEMPLATE_ID } from "../../db/checklistPrivacy";
import {
  INSERT_CHECKLIST_ITEM_SQL,
  INSERT_CHECKLIST_SQL,
  INSERT_PRIVATE_CHECKLIST_SQL,
  SET_CHECKLIST_ITEM_CHECKED_SQL,
  SET_CHECKLIST_ITEM_NOTE_SQL,
  checkedItemArgs,
  noteItemArgs,
} from "../../db/checklistSql";
import { ITEM_AUTHOR_COLUMNS, noteDigest, validDoneBy, validNoteBy } from "../../db/checklistItemAuthor";

let current: TestDb | null = null;
jest.mock("../../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => current!.prepare(sql).get(...params),
  dbAll: (sql: string, params: unknown[] = []) => current!.prepare(sql).all(...params),
  dbRun: (sql: string, params: unknown[] = []) => current!.prepare(sql).run(...params),
  dbTransaction: (fn: () => unknown) => current!.transaction(fn)(),
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../../logService", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { buildChecklistSnapshotPayload, snapshotSubmissionChecklists, SNAPSHOT_RPC, type SnapshotRpcClient } from "../../submissionChecklistSnapshot";
import { getChecklistNoteAuthors, getChecklistsForTransaction } from "../../db/checklistDbService";

type Row = Record<string, unknown>;
const fid = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;
const INSTALL = fid(98, 4263);
const CL = fid(3, 1);
const MY = fid(3, 2);
const I1 = fid(4, 1);
const I2 = fid(4, 2);
const SUBMISSION = fid(7, 1);

const outbox = (db: TestDb) => db.prepare("SELECT * FROM cloud_sync_todo_outbox ORDER BY local_id, part").all() as Row[];
const item = (db: TestDb, id: string) => db.prepare("SELECT * FROM transaction_checklist_items WHERE id = ?").get(id) as Row;
const authors = (db: TestDb, id: string) => Object.fromEntries(ITEM_AUTHOR_COLUMNS.map((c) => [c, item(db, id)[c]]));
const ALL_NULL = Object.fromEntries(ITEM_AUTHOR_COLUMNS.map((c) => [c, null]));
const NOTE_NULL = { note_by_kind: null, note_by_app: null, note_by_at: null, note_by_digest: null };
const DONE_NULL = { done_by_kind: null, done_by_app: null, done_by_at: null, done_by_stamp: null };
const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c]]));
const NOTE_COLS = ["note_by_kind", "note_by_app", "note_by_at", "note_by_digest"];
const DONE_COLS = ["done_by_kind", "done_by_app", "done_by_at", "done_by_stamp"];
const onlineItem = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "item" && t.localId === local) as FakeTodo;
const onlineList = (e: Engine, local: string) => e.server.todos.find((t) => t.entity === "checklist" && t.localId === local) as FakeTodo;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

async function synced(server?: FakeServer): Promise<{ db: TestDb; deal: string; e: Engine }> {
  const { db, deal } = profile();
  const e = engine(db, server);
  await startAndPass(e);
  expect(outbox(db)).toEqual([]);
  return { db, deal, e };
}

const tick = (db: TestDb, id: string, checked: boolean) => db.prepare(SET_CHECKLIST_ITEM_CHECKED_SQL).run(...checkedItemArgs(checked, id));
const writeNote = (db: TestDb, id: string, note: string | null) => db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs(note, id));

/** The v2.48.0 / b5fdc730c statement text of the UI tick and note (git show b5fdc730c:electron/services/db/checklistSql.ts). */
const OLD_TICK_SQL = `
  UPDATE transaction_checklist_items
  SET is_checked = ?,
      checked_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
  WHERE id = ?
`;
const OLD_NOTE_SQL = "\n  UPDATE transaction_checklist_items SET note = ? WHERE id = ?\n";

/** Runs fn with every argument-less Date 1 ms apart, so a time computed by a second call never equals the first. */
async function withTickingDate<T>(fn: () => T | Promise<T>): Promise<T> {
  const RealDate = Date;
  let tickMs = RealDate.parse("2026-11-19T11:00:00.000Z");
  class TickDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(tickMs++);
      else super(...(a as [string]));
    }
    static now(): number {
      return tickMs++;
    }
  }
  global.Date = TickDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    global.Date = RealDate;
  }
}

afterEach(() => {
  current = null;
});

describe(`item authors (v85) [${DRIVER}]`, () => {
  // ================================================================ UI
  describe("UI: the tick and note writers", () => {
    it("a tick records the agent; done_by_stamp equals checked_at; an untick leaves the stamp NULL and no valid author", () => {
      const { db } = profile(false);
      tick(db, I1, true);
      const r = item(db, I1);
      expect(r.checked_at).not.toBeNull();
      expect(pick(r, DONE_COLS)).toEqual({ done_by_kind: "agent", done_by_app: null, done_by_at: expect.stringMatching(ISO), done_by_stamp: r.checked_at });
      expect(validDoneBy(r as never)).toEqual({ kind: "agent", app: null });
      tick(db, I1, false);
      const u = item(db, I1);
      expect([u.is_checked, u.checked_at, u.done_by_stamp, u.done_by_kind]).toEqual([0, null, null, "agent"]);
      expect(validDoneBy(u as never)).toBeNull();
      expect(pick(u, NOTE_COLS)).toEqual(NOTE_NULL);
    });

    it("a note records the agent with the sha256 of the exact text", () => {
      const { db } = profile(false);
      writeNote(db, I1, "  Booked for Tuesday ");
      const r = item(db, I1);
      expect(pick(r, NOTE_COLS)).toEqual({ note_by_kind: "agent", note_by_app: null, note_by_at: expect.stringMatching(ISO), note_by_digest: noteDigest("  Booked for Tuesday ") });
      expect(validNoteBy(r as never)).toEqual({ kind: "agent", app: null });
      expect(pick(r, DONE_COLS)).toEqual(DONE_NULL);
    });

    it("a cleared note (NULL or blank) clears all four note author columns, whoever wrote it", () => {
      const { db } = profile(false);
      for (const cleared of [null, "", "   "]) {
        db.prepare("UPDATE transaction_checklist_items SET note = 'x', note_by_kind = 'ai_app', note_by_app = 'openai', note_by_at = '2026-11-01T00:00:00.000Z', note_by_digest = ? WHERE id = ?").run(noteDigest("x"), I1);
        writeNote(db, I1, cleared);
        expect([cleared, pick(item(db, I1), NOTE_COLS)]).toEqual([cleared, NOTE_NULL]);
      }
    });

    it("saving the same text keeps the author it had (an AI app's note stays the AI app's)", () => {
      const { db } = profile(false);
      const ai = { note_by_kind: "ai_app", note_by_app: "anthropic", note_by_at: "2026-11-01T00:00:00.000Z", note_by_digest: noteDigest("from Claude") };
      db.prepare("UPDATE transaction_checklist_items SET note = 'from Claude', note_by_kind = ?, note_by_app = ?, note_by_at = ?, note_by_digest = ? WHERE id = ?").run(
        ai.note_by_kind, ai.note_by_app, ai.note_by_at, ai.note_by_digest, I1,
      );
      writeNote(db, I1, "from Claude");
      expect(pick(item(db, I1), NOTE_COLS)).toEqual(ai);
      writeNote(db, I1, "from Claude, edited");
      expect(pick(item(db, I1), NOTE_COLS)).toMatchObject({ note_by_kind: "agent", note_by_app: null, note_by_digest: noteDigest("from Claude, edited") });
    });

    it("after an older build's tick or note (the b5fdc730c / 2.48.0 statement text), the author reads as not recorded", () => {
      const { db } = profile(false);
      tick(db, I1, true);
      writeNote(db, I1, "mine");
      expect(validDoneBy(item(db, I1) as never)).toEqual({ kind: "agent", app: null });
      expect(validNoteBy(item(db, I1) as never)).toEqual({ kind: "agent", app: null });
      // an AI author was recorded; then the older build edits both parts
      db.prepare("UPDATE transaction_checklist_items SET done_by_kind = 'ai_app', done_by_app = 'openai', note_by_kind = 'ai_app', note_by_app = 'openai' WHERE id = ?").run(I1);
      db.prepare(OLD_TICK_SQL).run(0, 0, I1);
      db.prepare("UPDATE transaction_checklist_items SET checked_at = '2026-11-01 09:00:00', is_checked = 1 WHERE id = ?").run(I1);
      db.prepare(OLD_NOTE_SQL).run("written by the older build", I1);
      const r = item(db, I1);
      expect(r.done_by_kind).toBe("ai_app");
      expect(r.note_by_kind).toBe("ai_app");
      expect(validDoneBy(r as never)).toBeNull();
      expect(validNoteBy(r as never)).toBeNull();
    });
  });

  // ================================================================ CAP
  describe("CAP: no todo op from an author column", () => {
    it("a note save with unchanged text creates no outbox row and keeps the author", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", Date.now(), "conn-1", "anthropic");
      await pass(e);
      const kept = pick(item(db, I1), NOTE_COLS);
      expect(kept).toMatchObject({ note_by_kind: "ai_app", note_by_app: "anthropic" });
      const counter = db.prepare("SELECT * FROM cloud_sync_todo_counter").all();
      writeNote(db, I1, "from Claude");
      expect(outbox(db)).toEqual([]);
      expect(pick(item(db, I1), NOTE_COLS)).toEqual(kept);
      expect(db.prepare("SELECT * FROM cloud_sync_todo_counter").all()).toEqual(counter);
    });

    it("no capture trigger names an author column", async () => {
      const { db } = await synced();
      const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'transaction_checklist_items'").all() as Array<{ name: string; sql: string }>;
      expect(triggers.length).toBeGreaterThan(0);
      expect(triggers.filter((t) => ITEM_AUTHOR_COLUMNS.some((c) => t.sql.includes(c))).map((t) => t.name)).toEqual([]);
    });

    it("a change of the author columns alone creates no outbox op and does not step the counter", async () => {
      const { db } = await synced();
      const counter = db.prepare("SELECT * FROM cloud_sync_todo_counter").all();
      db.prepare(
        "UPDATE transaction_checklist_items SET done_by_kind = 'ai_app', done_by_app = 'openai', done_by_at = 'x', done_by_stamp = 'y', note_by_kind = 'agent', note_by_app = NULL, note_by_at = 'z', note_by_digest = 'd' WHERE id = ?",
      ).run(I1);
      expect(outbox(db)).toEqual([]);
      expect(db.prepare("SELECT * FROM cloud_sync_todo_counter").all()).toEqual(counter);
    });
  });

  // ================================================================ PULL
  describe("PULL: the author comes from the pulled part", () => {
    it("an AI app's note: ai_app with the part's app, the server's time and the digest of the pulled text; same statement as the value", async () => {
      const { db, e } = await synced();
      const at = Date.parse("2026-11-19T10:00:00.000Z");
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", at, "conn-1", "anthropic");
      await pass(e);
      expect(item(db, I1).note).toBe("from Claude");
      expect(pick(item(db, I1), NOTE_COLS)).toEqual({
        note_by_kind: "ai_app",
        note_by_app: "anthropic",
        note_by_at: new Date(Math.max(at, onlineItem(e, I1).parts.note.at)).toISOString(),
        note_by_digest: noteDigest("from Claude"),
      });
      expect(validNoteBy(item(db, I1) as never)).toEqual({ kind: "ai_app", app: "anthropic" });
    });

    it("an app outside the vocabulary is stored as NULL; the kind stays ai_app", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "from an app", Date.now(), "conn-1", "Claude<b>");
      e.server.aiSet(onlineItem(e, I2), "note", "from another", Date.now(), "conn-1", "evil");
      await pass(e);
      for (const id of [I1, I2]) expect(pick(item(db, id), ["note_by_kind", "note_by_app"])).toEqual({ note_by_kind: "ai_app", note_by_app: null });
    });

    it("another desktop's write is the agent; an actor that is neither an AI app nor a desktop has no author", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "typed on the laptop", Date.now(), "conn-1", "openai");
      onlineItem(e, I1).parts.note.by = `desktop:${fid(98, 9)}`;
      e.server.aiSet(onlineItem(e, I2), "note", "from somewhere", Date.now(), "conn-1", "openai");
      onlineItem(e, I2).parts.note.by = "system:restore";
      await pass(e);
      expect(pick(item(db, I1), NOTE_COLS)).toMatchObject({ note_by_kind: "agent", note_by_app: null, note_by_digest: noteDigest("typed on the laptop") });
      expect(item(db, I2).note).toBe("from somewhere");
      expect(pick(item(db, I2), NOTE_COLS)).toEqual(NOTE_NULL);
    });

    it("an AI tick: done_by_stamp is the checked_at the same statement wrote, also when the server sent no time", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "done", { is_checked: true, checked_at: null }, Date.now(), "conn-1", "openai");
      e.server.aiSet(onlineItem(e, I2), "done", { is_checked: true, checked_at: "2026-11-19T10:00:00+00:00" }, Date.now(), "conn-1", "anthropic");
      // every argument-less Date differs by 1 ms, so a stamp computed by a second call can never equal checked_at
      await withTickingDate(() => pass(e));
      for (const [id, app] of [[I1, "openai"], [I2, "anthropic"]] as const) {
        const r = item(db, id);
        expect([id, r.is_checked, r.done_by_kind, r.done_by_app, r.done_by_stamp === r.checked_at, typeof r.checked_at]).toEqual([id, 1, "ai_app", app, true, "string"]);
        expect(validDoneBy(r as never)).toEqual({ kind: "ai_app", app });
      }
    });

    it("an item an AI app added with a note and a tick is inserted with both authors; parts it did not send are NULL", async () => {
      const { db, e } = await synced();
      const t = e.server.aiAdd(onlineList(e, MY), "Order the survey");
      e.server.aiSet(t, "note", "ordered", Date.now(), "conn-1", "anthropic");
      e.server.aiSet(t, "done", { is_checked: true, checked_at: "2026-11-19T10:00:00.000Z" }, Date.now(), "conn-1", "anthropic");
      await pass(e);
      const r = item(db, t.localId);
      expect(r.note).toBe("ordered");
      expect(pick(r, ["note_by_kind", "note_by_app", "note_by_digest"])).toEqual({ note_by_kind: "ai_app", note_by_app: "anthropic", note_by_digest: noteDigest("ordered") });
      expect(pick(r, ["done_by_kind", "done_by_app"])).toEqual({ done_by_kind: "ai_app", done_by_app: "anthropic" });
      expect(r.done_by_stamp).toBe(r.checked_at);
      const noTime = e.server.aiAdd(onlineList(e, MY), "Book the movers");
      e.server.aiSet(noTime, "done", { is_checked: true, checked_at: null }, Date.now(), "conn-1", "openai");
      await withTickingDate(() => pass(e));
      expect(item(db, noTime.localId).checked_at).toEqual(expect.any(String));
      expect(item(db, noTime.localId).done_by_stamp).toBe(item(db, noTime.localId).checked_at);
      const plain = e.server.aiAdd(onlineList(e, MY), "Call the inspector");
      await pass(e);
      // a NULL note has no author; the unticked done part records its writer with no stamp
      expect(pick(item(db, plain.localId), NOTE_COLS)).toEqual(NOTE_NULL);
      expect(pick(item(db, plain.localId), DONE_COLS)).toMatchObject({ done_by_kind: "ai_app", done_by_stamp: null });
    });

    it("OLD SERVER (no 'app' on the parts, the 20261118110000 shape): an AI note is stored as ai_app with app NULL and nothing throws", async () => {
      const server = new FakeServer(USER_A);
      server.partApp = false;
      const { db, e } = await synced(server);
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", Date.now(), "conn-1", "anthropic");
      const before = e.server.calls.length;
      await pass(e);
      const pulled = e.server.calls.slice(before).filter((c) => c.fn === "cloud_todo_pull");
      expect(pulled.length).toBeGreaterThan(0);
      expect(item(db, I1).note).toBe("from Claude");
      expect(pick(item(db, I1), ["note_by_kind", "note_by_app"])).toEqual({ note_by_kind: "ai_app", note_by_app: null });
      expect(validNoteBy(item(db, I1) as never)).toEqual({ kind: "ai_app", app: null });
    });

    it("a re-delivered full pull leaves every author column as it was", async () => {
      const { db, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", Date.now(), "conn-1", "anthropic");
      await pass(e);
      const row = item(db, I1);
      db.prepare("UPDATE cloud_sync_todo_cursor SET full_pull_owed = 1, last_seq = 0, horizon = NULL").run();
      await pass(e);
      expect(item(db, I1)).toEqual(row);
    });
  });

  // ================================================================ CONF
  describe("CONF: the confirm write-back and its re-apply", () => {
    function pendingNote(db: TestDb, text: string): OutboxRow {
      writeNote(db, I1, text);
      return (db.prepare("SELECT * FROM cloud_sync_todo_outbox WHERE local_id = ? AND part = 'note'").get(I1) as unknown) as OutboxRow;
    }
    const lostAnswer = (row: OutboxRow, rev: number, value: string) => ({
      op_id: row.op_id,
      status: "lost",
      entity: "item",
      cloud_id: "c-1",
      parts: { note: { rev, value, by: "ai_app:conn-1", app: "openai", at: "2026-11-19T10:00:00.000Z", edit_seq: null } },
    });

    it("a lost answer writes the winner and its author (from the answer part) together", async () => {
      const { db } = await synced();
      const row = pendingNote(db, "mine");
      const shadowRev = (db.prepare("SELECT note_rev FROM cloud_sync_todo_state WHERE local_id = ?").get(I1) as { note_rev: number }).note_rev;
      const answer = lostAnswer(row, shadowRev + 1, "the AI's winner");
      todos.confirmTodoAnswer(db, row, answer, actionFor(answer), new Date());
      const r = item(db, I1);
      expect(r.note).toBe("the AI's winner");
      expect(pick(r, NOTE_COLS)).toEqual({ note_by_kind: "ai_app", note_by_app: "openai", note_by_at: "2026-11-19T10:00:00.000Z", note_by_digest: noteDigest("the AI's winner") });
    });

    it("a lost tick answer with no time: done_by_stamp is the checked_at the same UPDATE wrote", async () => {
      const { db } = await synced();
      tick(db, I1, false);
      tick(db, I1, true);
      tick(db, I1, false);
      const row = (db.prepare("SELECT * FROM cloud_sync_todo_outbox WHERE local_id = ? AND part = 'done'").get(I1) as unknown) as OutboxRow;
      const shadowRev = (db.prepare("SELECT done_rev FROM cloud_sync_todo_state WHERE local_id = ?").get(I1) as { done_rev: number }).done_rev;
      const answer = {
        op_id: row.op_id,
        status: "lost",
        entity: "item",
        cloud_id: "c-1",
        parts: { done: { rev: shadowRev + 1, value: { is_checked: true, checked_at: null }, by: "ai_app:conn-1", app: "anthropic", at: "2026-11-19T10:00:00.000Z", edit_seq: null } },
      };
      await withTickingDate(() => todos.confirmTodoAnswer(db, row, answer, actionFor(answer), new Date()));
      const r = item(db, I1);
      expect([r.is_checked, r.done_by_kind, r.done_by_app, typeof r.checked_at, r.done_by_stamp === r.checked_at]).toEqual([1, "ai_app", "anthropic", "string", true]);
    });

    it("a write-back the local row refuses keeps the old value; the re-apply lands the winner with every note author column NULL", async () => {
      const { db, e } = await synced();
      const row = pendingNote(db, "mine");
      const mine = pick(item(db, I1), NOTE_COLS);
      expect(mine).toMatchObject({ note_by_kind: "agent" });
      const shadowRev = (db.prepare("SELECT note_rev FROM cloud_sync_todo_state WHERE local_id = ?").get(I1) as { note_rev: number }).note_rev;
      // the fixture: a row-level refusal of exactly this value (as a CHECK refuses a value)
      db.exec("CREATE TRIGGER fixture_refuse_note BEFORE UPDATE OF note ON transaction_checklist_items WHEN NEW.note = 'refused here' BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: fixture'); END;");
      const answer = lostAnswer(row, shadowRev + 1, "refused here");
      todos.confirmTodoAnswer(db, row, answer, actionFor(answer), new Date());
      expect(item(db, I1).note).toBe("mine");
      expect(pick(item(db, I1), NOTE_COLS)).toEqual(mine);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_todo_notices WHERE kind = 'local_write_failed' AND dismissed_at IS NULL").get()).toEqual({ n: 1 });
      db.exec("DROP TRIGGER fixture_refuse_note");
      onlineItem(e, I1).parts.note = { ...onlineItem(e, I1).parts.note, rev: shadowRev + 1, value: "refused here", by: "ai_app:conn-1", app: "openai" };
      await pass(e);
      expect(item(db, I1).note).toBe("refused here");
      expect(pick(item(db, I1), NOTE_COLS)).toEqual(NOTE_NULL);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_todo_notices WHERE kind = 'local_write_failed' AND dismissed_at IS NULL").get()).toEqual({ n: 0 });
    });
  });

  // ================================================================ DEL
  describe("DEL: the todo resets never touch the author columns", () => {
    it("turn-off, turn-on, reclaim, rebind, deal reset and the backup-restore reset leave every column of every item as it was", async () => {
      const { db, deal, e } = await synced();
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", Date.now(), "conn-1", "anthropic");
      await pass(e);
      tick(db, I2, true);
      writeNote(db, I2, "mine");
      const rows = () => db.prepare("SELECT * FROM transaction_checklist_items ORDER BY id").all();
      const before = rows();
      expect(authors(db, I1)).not.toEqual(ALL_NULL);
      expect(authors(db, I2)).not.toEqual(ALL_NULL);
      const steps: Array<[string, () => void]> = [
        ["turn-off", () => disableForUser(db, PROJECT, USER_A, false, new Date())],
        ["turn-on", () => enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date())],
        ["reclaim", () => reclaimInstallForUser(db, PROJECT, USER_A, new Date())],
        ["rebind", () => todos.clearTodoStateEverywhere(db)],
        ["deal reset", () => void todos.resetTodoDeal(db, PROJECT, USER_A, deal, new Date())],
        ["backup-restore reset", () => void todos.resetTodosAfterRestore(db, new Date())],
      ];
      for (const [name, run] of steps) {
        run();
        expect([name, rows()]).toEqual([name, before]);
      }
    });
  });

  // ================================================================ SNAP
  describe("SNAP: the two snapshot keys", () => {
    /** The old snapshot function (BACKLOG-3968): reads the keys it knows, one by one, and ignores the rest. */
    function oldFunctionClient(stored: Row[]): SnapshotRpcClient {
      return {
        rpc: (fn: string, args: Record<string, unknown>) => {
          if (fn !== SNAPSHOT_RPC) return Promise.resolve({ data: null, error: { code: "PGRST202", message: "no such function" } });
          let items = 0;
          for (const cl of args.p_checklists as Row[]) {
            for (const it of cl.items as Row[]) {
              stored.push({ title: it.title, local_item_id: it.local_item_id, note: it.note ?? null, is_checked: it.is_checked });
              items++;
            }
          }
          return Promise.resolve({ data: { checklists: (args.p_checklists as Row[]).length, items, links: 0, members: 0, dropped_members: 0, dropped_links: 0 }, error: null });
        },
      };
    }

    it("attribution_v 1 on every item; note_by only for a non-blank note with a valid author; never done_by", async () => {
      const { db, deal, e } = await synced();
      current = db;
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", Date.now(), "conn-1", "anthropic");
      await pass(e);
      tick(db, I1, true);
      const local = await getChecklistsForTransaction(deal, "broker");
      const payload = buildChecklistSnapshotPayload(local, undefined, undefined, getChecklistNoteAuthors(deal));
      const items = payload.flatMap((c) => c.items);
      expect(items.map((i) => [i.local_item_id, i.attribution_v, i.note_by])).toEqual([[I1, 1, { kind: "ai_app", app: "anthropic" }]]);
      for (const i of items) expect(Object.keys(i)).not.toContain("done_by");
    });

    it("kind is never defaulted: a NULL author, a blank note or a digest that no longer matches all send note_by null", async () => {
      const { db, deal } = profile(false);
      current = db;
      const send = async () => {
        const local = await getChecklistsForTransaction(deal, "agent");
        return buildChecklistSnapshotPayload(local, undefined, undefined, getChecklistNoteAuthors(deal)).flatMap((c) => c.items).find((i) => i.local_item_id === I1)!;
      };
      db.prepare(OLD_NOTE_SQL).run("no author recorded", I1);
      expect((await send()).note_by).toBeNull();
      writeNote(db, I1, "mine");
      expect((await send()).note_by).toEqual({ kind: "agent", app: null });
      db.prepare("UPDATE transaction_checklist_items SET note = 'changed by a raw write' WHERE id = ?").run(I1);
      expect((await send()).note_by).toBeNull();
      db.prepare("UPDATE transaction_checklist_items SET note = '   ', note_by_kind = 'agent', note_by_digest = ? WHERE id = ?").run(noteDigest("   "), I1);
      expect((await send()).note_by).toBeNull();
      db.prepare("UPDATE transaction_checklist_items SET note = 'x', note_by_kind = NULL, note_by_app = 'openai', note_by_digest = ? WHERE id = ?").run(noteDigest("x"), I1);
      expect((await send()).note_by).toBeNull();
      expect((await send()).attribution_v).toBe(1);
    });

    it("an author is sent only with the note text it was read with", async () => {
      const { db, deal } = profile(false);
      current = db;
      writeNote(db, I1, "mine");
      const local = await getChecklistsForTransaction(deal, "agent");
      const authorsLater = new Map([[I1, { note: "something else", noteBy: { kind: "agent" as const, app: null } }]]);
      expect(buildChecklistSnapshotPayload(local, undefined, undefined, authorsLater).flatMap((c) => c.items).find((i) => i.local_item_id === I1)!.note_by).toBeNull();
      expect(buildChecklistSnapshotPayload(local).flatMap((c) => c.items).every((i) => i.note_by === null && i.attribution_v === 1)).toBe(true);
    });

    it("OLD SERVER end to end: an AI note pulled without 'app', then the snapshot to the old function succeeds and sends the two keys", async () => {
      const server = new FakeServer(USER_A);
      server.partApp = false;
      const { db, deal, e } = await synced(server);
      current = db;
      e.server.aiSet(onlineItem(e, I1), "note", "from Claude", Date.now(), "conn-1", "anthropic");
      await pass(e);
      const stored: Row[] = [];
      const sent: Array<Record<string, unknown>> = [];
      const client = oldFunctionClient(stored);
      const spy: SnapshotRpcClient = { rpc: (fn, args) => (sent.push(args), client.rpc(fn, args)) };
      const outcome = await snapshotSubmissionChecklists(spy, SUBMISSION, deal);
      expect(outcome.status).toBe("written");
      const sentItem = (sent[0].p_checklists as Row[]).flatMap((c) => c.items as Row[]).find((i) => i.local_item_id === I1)!;
      expect([sentItem.attribution_v, sentItem.note_by]).toEqual([1, { kind: "ai_app", app: null }]);
      // the old function keeps none of it: the author is lost on that server
      expect(stored.find((s) => s.local_item_id === I1)).toEqual({ title: "Inspection", local_item_id: I1, note: "from Claude", is_checked: false });
    });
  });
});
