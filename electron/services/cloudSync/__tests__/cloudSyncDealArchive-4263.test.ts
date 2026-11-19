/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-4c — a deal deleted on this computer by a Keepr Cloud user is restorable here for 30 days
 * (plan §14, F1–F9; Q3, Q7, Q8), driven through the real runner pass, the real capture triggers and the fake server
 * (helpers/fakeServer.ts; its removed-deal answers observed by supabase/tests/backlog-4263-pr4c/harness-4c.sql).
 * The delete is the handler's own step on this handle (helpers/dealArchiveFixtures.deleteLikeTheHandler); that the
 * handlers call it, inside one transaction with their audit entry, is pinned in electron/__tests__/dealArchive-4263.test.ts.
 *
 *   ROUND   full-row equality of the deal and all 15 tables before the delete and after the restore; the SET NULL rows
 *   SKIP    a link whose email/text/attachment/contact is gone is skipped and counted (W35); SET NULL-type refs -> NULL
 *   COLS    an archive missing a column restores with the current default
 *   REFUSE  second click, another local user, Delete for good owed, deal already here, Keepr Cloud off: nothing changes
 *   SYNC    restore before the removal was sent / after it / after the online purge (W33); no op echoes (C40)
 *   ONLINE  a deal restored online is restored here by the pull, from the archive (W33)
 *   PURGE   the 30-day boundary; at open and on the timer; turn-off, other project, backup restore, user delete
 *   GOOD    Delete for good: server first, the owed mark, retry, not_removed, a crash between (W36)
 *   USERS   two local users on one profile
 */
import { DRIVER, type TestDb } from "./helpers/sqlite";
import { freshDb, PROJECT, USER_A, USER_B, OTHER_PROJECT } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass, type Engine } from "./helpers/engine";
import { FakeServer } from "./helpers/fakeServer";
import { deleteLikeTheHandler, fz, seedFullDeal, snapshotDeal, type DealFixture } from "./helpers/dealArchiveFixtures";
import * as archive from "../../db/cloudSyncDealArchive";
import { enableForUser, disableForUser, forgetOtherProjects } from "../../db/cloudSyncDbService";
import { prepareCloudSyncAfterOpen, prepareRestoredFile } from "../../db/cloudSyncTriggers";
import { SET_CHECKLIST_ITEM_NOTE_SQL, noteItemArgs } from "../../db/checklistSql";
import { applyTodoPage } from "../../db/cloudSyncTodoPullDb";

type Row = Record<string, unknown>;
const INSTALL = fz(98, 4264);
const DEAL = fz(50, 1);
const DAY = 24 * 60 * 60 * 1000;

const n = (db: TestDb, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const archiveRows = (db: TestDb) => n(db, `SELECT COUNT(*) AS n FROM ${archive.DEAL_ARCHIVE_TABLE}`);
const outbox = (db: TestDb) => db.prepare("SELECT entity, local_id, part FROM cloud_sync_todo_outbox ORDER BY entity, local_id, part").all() as Row[];
const shadowRows = (db: TestDb, deal: string) => n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_state WHERE transaction_id = ?", deal);

function engine(db: TestDb, server?: FakeServer, user = USER_A): Engine {
  const e = makeEngine(db, { server, user });
  Object.defineProperty(e.clock, "now", { get: () => new Date(), set: () => undefined, configurable: true });
  e.server.serverNow = () => Date.now();
  return e;
}

function profile(opts: { cloud?: boolean } = {}): { db: TestDb; fx: DealFixture } {
  const db = freshDb();
  db.prepare("INSERT INTO cloud_sync_install (project_ref, install_id, machine_hash, created_at) VALUES (?, ?, NULL, '2026-11-01T00:00:00.000Z')").run(PROJECT, INSTALL);
  const fx = seedFullDeal(db, USER_A, DEAL);
  if (opts.cloud !== false) enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
  return { db, fx };
}

/** The service's own actions start a pass (kick); wait for it before the test's next pass. */
const idle = (e: Engine) => e.service.runner!.whenIdle();

const del = (db: TestDb, deal = DEAL, now = new Date(), flag = true) => deleteLikeTheHandler(db, deal, archive.archiveDealBeforeDelete, now, flag);

/** Rewrites the (only) archive row's payload. */
const editPayload = (db: TestDb, f: (p: archive.DealArchivePayload) => void) => {
  const row = db.prepare(`SELECT payload_json FROM ${archive.DEAL_ARCHIVE_TABLE}`).get() as { payload_json: string };
  const p = JSON.parse(row.payload_json) as archive.DealArchivePayload;
  f(p);
  db.prepare(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET payload_json = ?`).run(JSON.stringify(p));
};
/** A column name that would break the INSERT if it ever reached the SQL text. */
const HOSTILE = 'x") VALUES (1); DROP TABLE contacts; --';

const restore = (db: TestDb, user = USER_A, deal = DEAL, audits: Row[] = []) =>
  archive.restoreArchivedDeal(db, { userId: user, transactionId: deal, now: new Date(), audit: (e) => void audits.push(e) });

/** Turned on, one pass: the deal and its todos online, the full pull done. */
async function synced(): Promise<{ db: TestDb; fx: DealFixture; e: Engine }> {
  const { db, fx } = profile();
  const e = engine(db);
  await startAndPass(e);
  expect(outbox(db)).toEqual([]);
  expect(e.server.deals).toHaveLength(1);
  expect(e.server.todos.filter((t) => t.dealId === e.server.deals[0].id)).toHaveLength(2);
  return { db, fx, e };
}

describe(`Keepr Cloud deal archive and restore [${DRIVER}]`, () => {
  // ================================================================ ROUND
  describe("ROUND: restore brings back exactly what was removed", () => {
    it("every column of the deal and of every row in all 15 tables is equal before the delete and after the restore; the 2 SET NULL tables name the deal again", () => {
      const { db } = profile();
      const before = snapshotDeal(db, DEAL);
      for (const t of ["transactions", ...archive.DEAL_ARCHIVE_TABLES.map((x) => x.table), ...archive.DEAL_ARCHIVE_SET_NULL_TABLES]) {
        expect([t, before[t].length > 0]).toEqual([t, true]);
      }
      expect(del(db)).toBe(true);
      const gone = snapshotDeal(db, DEAL);
      for (const t of Object.keys(gone)) expect([t, gone[t].length]).toEqual([t, 0]);
      expect(archiveRows(db)).toBe(1);
      const audits: Row[] = [];
      const r = restore(db, USER_A, DEAL, audits);
      expect(r).toMatchObject({ ok: true, skippedTotal: 0, otherDealAtAddress: false });
      expect(snapshotDeal(db, DEAL)).toEqual(before);
      expect(archiveRows(db)).toBe(0);
      expect(audits).toEqual([expect.objectContaining({ userId: USER_A, transactionId: DEAL, via: "computer" })]);
    });

    it("the payload holds the deal, all 15 tables, only the ids of the 2 SET NULL tables, and the deal's todo records", () => {
      const { db, fx } = profile();
      del(db);
      const p = JSON.parse((db.prepare(`SELECT payload_json FROM ${archive.DEAL_ARCHIVE_TABLE}`).get() as { payload_json: string }).payload_json) as archive.DealArchivePayload;
      expect(Object.keys(p.tables).sort()).toEqual(archive.DEAL_ARCHIVE_TABLES.map((t) => t.table).sort());
      expect(archive.DEAL_ARCHIVE_TABLES).toHaveLength(15);
      expect(p.set_null).toEqual({ classification_feedback: [fx.feedback], messages: [fx.message] });
      expect(p.deal.id).toBe(DEAL);
      expect(p.cloud.project_ref).toBe(PROJECT);
    });

    it("a SET NULL row is set back only where it still names no deal: a text moved to another deal since stays there", () => {
      const { db, fx } = profile();
      del(db);
      const other = fz(50, 2);
      db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'Elsewhere 1', 'active', 'confirmed')").run(other, USER_A);
      db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(other, fx.message);
      db.prepare("UPDATE classification_feedback SET transaction_id = ? WHERE id = ?").run(other, fx.feedback);
      expect(restore(db)).toMatchObject({ ok: true });
      expect(n(db, "SELECT COUNT(*) AS n FROM messages WHERE id = ? AND transaction_id = ?", fx.message, other)).toBe(1);
      expect(n(db, "SELECT COUNT(*) AS n FROM classification_feedback WHERE id = ? AND transaction_id = ?", fx.feedback, other)).toBe(1);
    });
  });

  // ================================================================ SET
  describe("SET: the archived tables are exactly the schema's children of a deal (derived from schema.sql)", () => {
    type Fk = { from: string; to: string; onDelete: string };
    /** Every foreign key of every table of a database built from schema.sql (pragma_foreign_key_list). */
    function foreignKeys(db: TestDb): Fk[] {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      return tables.flatMap((t) =>
        (db.prepare(`SELECT "table" AS ref, on_delete FROM pragma_foreign_key_list('${t}')`).all() as Array<{ ref: string; on_delete: string }>).map((f) => ({
          from: t,
          to: f.ref,
          onDelete: f.on_delete,
        })),
      );
    }

    it("every table a deal delete removes (CASCADE to transactions, and CASCADE to any of those, at any depth) is archived, every SET NULL child records its ids, and nothing else hangs off a deal's rows", () => {
      const db = freshDb();
      const fks = foreignKeys(db);
      // positive controls: the walk reads the schema, and finds edges it must find
      expect(fks.length).toBeGreaterThan(30);
      expect(fks).toContainEqual({ from: "communications", to: "transactions", onDelete: "CASCADE" });
      expect(fks).toContainEqual({ from: "transaction_checklist_items", to: "transaction_checklists", onDelete: "CASCADE" });
      // the deal's rows: transactions and, transitively, every table that cascades from one of them
      const removed = new Set<string>(["transactions"]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const f of fks) {
          if (removed.has(f.to) && f.onDelete === "CASCADE" && !removed.has(f.from)) {
            removed.add(f.from);
            grew = true;
          }
        }
      }
      removed.delete("transactions");
      expect([...removed].sort()).toEqual(archive.DEAL_ARCHIVE_TABLES.map((t) => t.table).sort());
      // a SET NULL reference to the deal: ids recorded
      const setNull = fks.filter((f) => f.to === "transactions" && f.onDelete === "SET NULL").map((f) => f.from);
      expect([...new Set(setNull)].sort()).toEqual([...archive.DEAL_ARCHIVE_SET_NULL_TABLES].sort());
      // no other action on a deal or on one of its rows (a RESTRICT would block the delete; a SET NULL into one
      // of the archived tables would lose a link the archive does not record)
      const other = fks.filter((f) => (f.to === "transactions" || removed.has(f.to)) && f.onDelete !== "CASCADE" && !(f.to === "transactions" && f.onDelete === "SET NULL"));
      expect(other).toEqual([]);
    });
  });

  // ================================================================ SKIP / COLS
  describe("SKIP and COLS: what cannot come back is skipped and counted, nothing else is lost (W35)", () => {
    it("a link whose email, text, attachment or contact is gone is skipped and counted; a checklist link left without members goes; a SET NULL-type reference whose text is gone comes back NULL", () => {
      const { db, fx } = profile();
      const before = snapshotDeal(db, DEAL);
      del(db);
      // gone since the delete: one email (two links), one text (a link, a member, the stage reference), one contact
      db.prepare("DELETE FROM emails WHERE id = ?").run(fx.email);
      db.prepare("DELETE FROM messages WHERE id = ?").run(fx.message2);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(fx.contact2);
      const r = restore(db);
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      expect(r.skipped).toEqual({
        communications: 1,
        transaction_participants: 1,
        transaction_checklist_link_members: 1,
        transaction_checklist_links: 1,
      });
      expect(r.skippedTotal).toBe(4);
      const after = snapshotDeal(db, DEAL);
      expect(after.transactions).toEqual(before.transactions);
      expect(after.transaction_checklist_items).toEqual(before.transaction_checklist_items);
      expect(after.transaction_checklist_links.map((l) => l.id).sort()).toEqual([fx.linkText, fz(66, 13)].sort());
      expect(after.transaction_stage_history[0].trigger_message_id).toBeNull();
      expect({ ...after.transaction_stage_history[0], trigger_message_id: before.transaction_stage_history[0].trigger_message_id }).toEqual(before.transaction_stage_history[0]);
      expect(after.transaction_contacts).toEqual(before.transaction_contacts);
    });

    it("a person removed from Contacts since the delete (a tombstone, the only way the app removes a contact): the deal comes back with that person still on it, the contact stays removed, nothing is skipped", () => {
      const { db, fx } = profile();
      const before = snapshotDeal(db, DEAL);
      del(db);
      // contacts:remove -> removeContactSync (electron/services/db/contactDbService.ts:2431-2439), statement text transcribed
      db.prepare(`UPDATE contacts
        SET removed_at = datetime('now'),
            removed_reason = ?
      WHERE id = ? AND removed_at IS NULL`).run("user_unimported", fx.contact);
      expect(restore(db)).toMatchObject({ ok: true, skippedTotal: 0 });
      expect(snapshotDeal(db, DEAL).transaction_contacts).toEqual(before.transaction_contacts);
      expect(n(db, "SELECT COUNT(*) AS n FROM contacts WHERE id = ? AND removed_at IS NOT NULL", fx.contact)).toBe(1);
    });

    it("a person whose contact row no longer exists (only a local user delete removes one outright): that party is skipped and counted, the rest of the deal comes back", () => {
      const { db, fx } = profile();
      del(db);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(fx.contact);
      const r = restore(db);
      expect(r).toMatchObject({ ok: true, skipped: { transaction_contacts: 1 }, skippedTotal: 1 });
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_contacts WHERE transaction_id = ?", DEAL)).toBe(0);
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_participants WHERE transaction_id = ?", DEAL)).toBe(1);
      expect(n(db, "SELECT COUNT(*) AS n FROM transaction_checklist_items")).toBe(1);
    });

    it("a review-queue row whose email is now linked to another deal stays with that deal and is counted", () => {
      const { db, fx } = profile();
      del(db);
      const other = fz(50, 3);
      db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'Elsewhere 2', 'active', 'confirmed')").run(other, USER_A);
      db.prepare("INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES (?, ?, ?, ?, 'manual')").run(fz(71, 99), USER_A, other, fx.email2);
      const r = restore(db);
      expect(r).toMatchObject({ ok: true, skipped: { pending_review_communications: 1 } });
    });

    it("an archive written before a column existed restores with that column's current default", () => {
      const { db } = profile();
      del(db);
      const row = db.prepare(`SELECT payload_json FROM ${archive.DEAL_ARCHIVE_TABLE}`).get() as { payload_json: string };
      const p = JSON.parse(row.payload_json) as archive.DealArchivePayload;
      for (const it of p.tables.transaction_checklist_items) delete it.due_date;
      for (const l of p.tables.transaction_checklist_links) delete l.include_outside_dates;
      delete p.deal.closing_date_verified;
      db.prepare(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET payload_json = ?`).run(JSON.stringify(p));
      expect(restore(db)).toMatchObject({ ok: true, skippedTotal: 0 });
      expect(db.prepare("SELECT due_date FROM transaction_checklist_items").get()).toEqual({ due_date: null });
      expect((db.prepare("SELECT include_outside_dates AS v FROM transaction_checklist_links ORDER BY id").all() as Row[]).map((r) => r.v)).toEqual([0, 0, 0]);
      expect(db.prepare("SELECT closing_date_verified AS v FROM transactions WHERE id = ?").get(DEAL)).toEqual({ v: 0 });
    });
  });

  // ================================================================ REFUSE
  describe("REFUSE: a restore that cannot run changes nothing and loses nothing", () => {
    it("a second click answers not_found; another local user's row answers not_owner and is never listed for them", () => {
      const { db } = profile();
      del(db);
      expect(archive.listArchivedDeals(db, USER_B)).toEqual([]);
      expect(restore(db, USER_B)).toEqual({ ok: false, code: "not_owner" });
      expect(archiveRows(db)).toBe(1);
      expect(restore(db)).toMatchObject({ ok: true });
      expect(restore(db)).toEqual({ ok: false, code: "not_found" });
    });

    it("a deal with the same id already here (a backup restore got there first): deal_exists, nothing written, the archive row kept", () => {
      const { db } = profile();
      del(db);
      db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'Same id', 'active', 'confirmed')").run(DEAL, USER_A);
      const dump = JSON.stringify(snapshotDeal(db, DEAL));
      expect(restore(db)).toEqual({ ok: false, code: "deal_exists" });
      expect(JSON.stringify(snapshotDeal(db, DEAL))).toBe(dump);
      expect(archiveRows(db)).toBe(1);
    });

    it("Keepr Cloud off for the owner (a machine rebind): cloud_off; Delete for good owed: purge_owed; the deal's own row failing: restore_failed with everything rolled back", () => {
      const { db } = profile();
      del(db);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      expect(restore(db)).toEqual({ ok: false, code: "cloud_off" });
      db.prepare("UPDATE cloud_sync_settings SET enabled = 1").run();
      expect(archive.markDealPurgeOwed(db, USER_A, DEAL, new Date())).toBe("ok");
      expect(restore(db)).toEqual({ ok: false, code: "purge_owed" });
      archive.clearDealPurgeOwed(db, USER_A, DEAL);
      // the deal row now fails a CHECK: nothing of the restore stays
      const row = db.prepare(`SELECT payload_json FROM ${archive.DEAL_ARCHIVE_TABLE}`).get() as { payload_json: string };
      const p = JSON.parse(row.payload_json) as archive.DealArchivePayload;
      p.deal.status = "not-a-status";
      db.prepare(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET payload_json = ?`).run(JSON.stringify(p));
      expect(restore(db)).toEqual({ ok: false, code: "restore_failed" });
      for (const [t, rows] of Object.entries(snapshotDeal(db, DEAL))) expect([t, rows.length]).toEqual([t, 0]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      expect(archiveRows(db)).toBe(1);
    });

    it.each([
      ["another payload format (a later build)", (p: archive.DealArchivePayload) => void (p.format = 99)],
      ["a table this build does not restore", (p: archive.DealArchivePayload) => void (p.tables.sr_future_table = [{ id: "x", transaction_id: DEAL }])],
      ["a SET NULL list this build does not know", (p: archive.DealArchivePayload) => void ((p.set_null as Record<string, string[]>).sr_future_ref = ["x"])],
    ])("an archive this build does not understand (%s): archive_not_understood, nothing written, the row kept", (_label, f) => {
      const { db } = profile();
      del(db);
      editPayload(db, f);
      const before = db.prepare(`SELECT * FROM ${archive.DEAL_ARCHIVE_TABLE}`).all();
      expect(restore(db)).toEqual({ ok: false, code: "archive_not_understood" });
      for (const [t, rows] of Object.entries(snapshotDeal(db, DEAL))) expect([t, rows.length]).toEqual([t, 0]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      expect(db.prepare(`SELECT * FROM ${archive.DEAL_ARCHIVE_TABLE}`).all()).toEqual(before);
      // still listed, and still purged at 30 days
      expect(archive.listArchivedDeals(db, USER_A)).toHaveLength(1);
      expect(archive.purgeExpiredDealArchive(db, new Date(Date.now() + 31 * DAY))).toBe(1);
    });

    it("an archived column the current table no longer has (dropped by a later version) is ignored: deal and child rows restore exactly, and the name never reaches the SQL", () => {
      const { db } = profile();
      const before = snapshotDeal(db, DEAL);
      del(db);
      editPayload(db, (p) => {
        p.deal.sr_dropped_col = "gone";
        (p.deal as Record<string, unknown>)[HOSTILE] = 1;
        p.tables.transaction_checklist_items[0].sr_dropped_col = "gone";
      });
      expect(restore(db)).toMatchObject({ ok: true, skippedTotal: 0 });
      expect(snapshotDeal(db, DEAL)).toEqual(before);
      expect(n(db, "SELECT COUNT(*) AS n FROM contacts")).toBeGreaterThan(0);
    });

    it("the audit entry failing cancels the whole restore", () => {
      const { db } = profile();
      del(db);
      const r = archive.restoreArchivedDeal(db, { userId: USER_A, transactionId: DEAL, now: new Date(), audit: () => { throw new Error("audit"); } });
      expect(r).toEqual({ ok: false, code: "restore_failed" });
      expect(n(db, "SELECT COUNT(*) AS n FROM transactions WHERE id = ?", DEAL)).toBe(0);
      expect(archiveRows(db)).toBe(1);
    });

    it("another live deal at the same address: restored anyway, and the answer says so", () => {
      const { db } = profile();
      del(db);
      db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, ' 12 main st, springfield ', 'active', 'confirmed')").run(fz(50, 9), USER_A);
      expect(restore(db)).toMatchObject({ ok: true, otherDealAtAddress: true });
    });
  });

  // ================================================================ NEVER-ON / USERS
  describe("USERS: never-on users and two local users on one profile (Q7, W34)", () => {
    it("a never-on user's delete writes no archive row; another user's Keepr Cloud on the same profile does not change that", () => {
      const { db } = profile({ cloud: false });
      enableForUser(db, PROJECT, USER_B, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      expect(del(db)).toBe(false);
      expect(archiveRows(db)).toBe(0);
    });

    it("each owner's rows are their own: B's turn-off leaves A's rows; A's list never shows B's", () => {
      const { db } = profile();
      const dealB = fz(50, 20);
      seedFullDeal(db, USER_B, dealB, 2);
      enableForUser(db, PROJECT, USER_B, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      del(db);
      del(db, dealB);
      expect(archive.listArchivedDeals(db, USER_A).map((d) => d.transactionId)).toEqual([DEAL]);
      expect(archive.listArchivedDeals(db, USER_B).map((d) => d.transactionId)).toEqual([dealB]);
      disableForUser(db, PROJECT, USER_B, false, new Date());
      expect(archive.listArchivedDeals(db, USER_A).map((d) => d.transactionId)).toEqual([DEAL]);
      expect(archive.listArchivedDeals(db, USER_B)).toEqual([]);
    });

    it("a delete without the flag (any caller other than the two handlers, such as a retention purge) writes no row and erases an existing row for that deal id", () => {
      const { db } = profile();
      expect(del(db, DEAL, new Date(), false)).toBe(false);
      expect(archiveRows(db)).toBe(0);
      const { db: db2 } = profile();
      del(db2);
      db2.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'Back', 'active', 'confirmed')").run(DEAL, USER_A);
      expect(archiveRows(db2)).toBe(1);
      del(db2, DEAL, new Date(), false);
      expect(archiveRows(db2)).toBe(0);
    });
  });

  // ================================================================ SYNC
  describe("SYNC: the next passes neither duplicate nor lose anything online (W33, C40)", () => {
    it("the restore itself writes no todo op, holds no guard afterwards, and marks the deal for the next pass", () => {
      const { db } = profile();
      db.exec("DELETE FROM cloud_sync_todo_outbox");
      del(db);
      db.exec("DELETE FROM cloud_sync_dirty");
      expect(restore(db)).toMatchObject({ ok: true });
      expect(outbox(db)).toEqual([]);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_dirty WHERE transaction_id = ?", DEAL)).toBe(1);
    });

    it("restored before its removal was sent: the next pass sends nothing for it and the online copy was never removed", async () => {
      const { db, e } = await synced();
      del(db);
      expect((await e.service.restoreDeal(DEAL)).success).toBe(true);
      await idle(e);
      const writes = e.server.writeCalls().length;
      await pass(e);
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(0);
      expect(e.server.writeCalls().slice(writes).map((c) => c.fn).filter((f) => f !== "cloud_mark_deal_synced" && f !== "cloud_upsert_deal")).toEqual([]);
      expect(e.server.deals).toHaveLength(1);
      expect(outbox(db)).toEqual([]);
    });

    it("restored after its removal was sent, with the daily reconcile due: no create op is sent before the pull, the online deal is un-removed under the same id, its todos are not duplicated, and a phone change made before the delete arrives", async () => {
      const { db, fx, e } = await synced();
      const cloudId = e.server.deals[0].id;
      const todo = e.server.todos.find((t) => t.entity === "item" && t.localId === fx.item)!;
      expect(e.server.aiSet(todo, "note", "from the phone")).toBe("applied");
      del(db);
      await pass(e);
      expect(e.server.softRemovedDeals.map((d) => d.id)).toEqual([cloudId]);
      expect(shadowRows(db, DEAL)).toBe(0);
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      const before = e.server.callsTo("cloud_todo_push").length;
      expect((await e.service.restoreDeal(DEAL)).success).toBe(true);
      await idle(e);
      await idle(e);
      const ops = e.server.callsTo("cloud_todo_push").slice(before).flatMap((c) => c.args.p_ops as Row[]);
      expect(ops.filter((o) => String(o.kind).startsWith("create"))).toEqual([]);
      expect(e.server.deals.map((d) => d.id)).toEqual([cloudId]);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(e.server.todos.filter((t) => t.dealId === cloudId)).toHaveLength(2);
      expect(db.prepare("SELECT note FROM transaction_checklist_items WHERE id = ?").get(fx.item)).toEqual({ note: "from the phone" });
      expect(outbox(db)).toEqual([]);
      const pushesBefore = e.server.callsTo("cloud_todo_push").length;
      await pass(e);
      expect(e.server.callsTo("cloud_todo_push").length).toBe(pushesBefore);
      expect(outbox(db)).toEqual([]);
    });

    it("an edit waiting to be sent at the delete reaches the cloud after the restore", async () => {
      const { db, fx, e } = await synced();
      e.server.override = (fn) => (fn === "cloud_todo_push" ? new Error("offline") : undefined);
      db.prepare(SET_CHECKLIST_ITEM_NOTE_SQL).run(...noteItemArgs("written before the delete", fx.item));
      await pass(e);
      e.server.override = null;
      expect(outbox(db).filter((o) => o.part === "note")).toHaveLength(1);
      del(db);
      await pass(e);
      expect((await e.service.restoreDeal(DEAL)).success).toBe(true);
      await idle(e);
      await pass(e);
      expect(e.server.todos.find((t) => t.localId === fx.item)!.parts.note.value).toBe("written before the delete");
      expect(outbox(db)).toEqual([]);
    });

    it("restored after the online copy was purged: the upload makes a new online deal and the todos are created on it", async () => {
      const { db, e } = await synced();
      const oldId = e.server.deals[0].id;
      del(db);
      await pass(e);
      e.server.purgeDealOnline(e.server.softRemovedDeals[0]);
      expect((await e.service.restoreDeal(DEAL)).success).toBe(true);
      await idle(e);
      await pass(e);
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
      const newId = e.server.deals[0].id;
      expect(newId).not.toBe(oldId);
      expect(e.server.todos.filter((t) => t.dealId === newId)).toHaveLength(2);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_todo_state WHERE transaction_id = ? AND cloud_deal_id IS NOT ?", DEAL, newId)).toBe(0);
      expect(outbox(db)).toEqual([]);
    });
  });

  describe("COLS: todo records", () => {
    it("an archived todo-record column the current table no longer has is ignored; the shadow comes back", async () => {
      const { db, e } = await synced();
      void e;
      const shadow = shadowRows(db, DEAL);
      expect(shadow).toBeGreaterThan(0);
      del(db);
      editPayload(db, (p) => {
        expect(p.cloud.todo_state.length).toBeGreaterThan(0);
        p.cloud.todo_state[0].sr_dropped_col = "gone";
        p.cloud.todo_state[0][HOSTILE] = 1;
      });
      expect(restore(db)).toMatchObject({ ok: true });
      expect(shadowRows(db, DEAL)).toBe(shadow);
    });
  });

  // ================================================================ ONLINE
  describe("ONLINE: a deal restored online is restored here by the pull (W33)", () => {
    it("the pull restores it from the archive inside the page, the todo rows of the same pull apply to it, another side's change arrives, and nothing echoes", async () => {
      const { db, fx, e } = await synced();
      del(db);
      await pass(e);
      const soft = e.server.softRemovedDeals[0];
      e.server.restoreDealOnline(soft);
      const todo = e.server.todos.find((t) => t.entity === "item" && t.localId === fx.item)!;
      expect(e.server.aiSet(todo, "title", "Inspection (moved)")).toBe("applied");
      await pass(e);
      expect(archiveRows(db)).toBe(0);
      expect(e.audits).toEqual([expect.objectContaining({ transactionId: DEAL, via: "online" })]);
      expect(db.prepare("SELECT title FROM transaction_checklist_items WHERE id = ?").get(fx.item)).toEqual({ title: "Inspection (moved)" });
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_applying")).toBe(0);
      // the pulled title came in under the page's guard: no op echoes it back
      expect(outbox(db)).toEqual([]);
      const pushesBefore = e.server.callsTo("cloud_todo_push").length;
      await pass(e);
      expect(e.server.callsTo("cloud_todo_push").slice(pushesBefore).flatMap((c) => c.args.p_ops as Row[])).toEqual([]);
      expect(outbox(db)).toEqual([]);
      expect(e.server.deals.map((d) => d.id)).toEqual([soft.id]);
      expect(e.server.todos.filter((t) => t.dealId === soft.id)).toHaveLength(2);
    });

    it("refused while this computer's own removal of the deal is still to be sent (a full pull lists it live)", async () => {
      const { db, e } = await synced();
      del(db);
      e.server.override = (fn) => (fn === "cloud_delete_deal" ? new Error("offline") : undefined);
      db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = 0, full_pull_owed = 1, horizon = NULL").run();
      await pass(e);
      e.server.override = null;
      expect(archiveRows(db)).toBe(1);
      expect(n(db, "SELECT COUNT(*) AS n FROM transactions WHERE id = ?", DEAL)).toBe(0);
      expect(e.audits).toEqual([]);
    });

    it("never for a deal whose removal by this computer the server has not confirmed (deleted before its first upload was recorded here; a full pull lists it live)", async () => {
      const { db, e } = await synced();
      db.prepare("DELETE FROM cloud_sync_state WHERE entity = 'deal'").run();
      del(db);
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_dirty WHERE transaction_id = ?", DEAL)).toBe(0);
      db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = 0, full_pull_owed = 1, horizon = NULL").run();
      await pass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM transactions WHERE id = ?", DEAL)).toBe(0);
      expect(archiveRows(db)).toBe(1);
      expect(e.audits).toEqual([]);
    });

    it("an archive this build does not understand is not restored by the pull (skipped, row kept)", async () => {
      const { db, e } = await synced();
      del(db);
      await pass(e);
      editPayload(db, (p) => void (p.format = 99));
      e.server.restoreDealOnline(e.server.softRemovedDeals[0]);
      await pass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM transactions WHERE id = ?", DEAL)).toBe(0);
      expect(archiveRows(db)).toBe(1);
      expect(e.audits).toEqual([]);
    });

    it("refused while Delete for good is owed, and never for a deal with no archive row", async () => {
      const { db, e } = await synced();
      del(db);
      await pass(e);
      archive.markDealPurgeOwed(db, USER_A, DEAL, new Date());
      e.server.restoreDealOnline(e.server.softRemovedDeals[0]);
      e.server.override = (fn) => (fn === "cloud_purge_deal_now" ? new Error("offline") : undefined);
      await pass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM transactions WHERE id = ?", DEAL)).toBe(0);
      expect(e.audits).toEqual([]);
    });
  });

  // ================================================================ PURGE
  describe("PURGE: when archive rows are erased (F6)", () => {
    it.each([
      ["29 d 23 h", 30 * DAY - 60 * 60 * 1000, 1],
      ["30 d - 1 ms", 30 * DAY - 1, 1],
      ["exactly 30 d", 30 * DAY, 0],
      ["30 d + 1 s", 30 * DAY + 1000, 0],
    ])("the 30-day purge at %s after the delete leaves %#", (_label, age, left) => {
      const { db } = profile();
      const t0 = new Date("2026-11-01T08:00:00.000Z");
      del(db, DEAL, t0);
      expect(archive.purgeExpiredDealArchive(db, new Date(t0.getTime() + age))).toBe(1 - left);
      expect(archiveRows(db)).toBe(left);
    });

    it("runs at every open (no migration needed) and on every timer tick, also offline", async () => {
      const { db } = profile();
      del(db, DEAL, new Date(Date.now() - 31 * DAY));
      prepareCloudSyncAfterOpen(db, false);
      expect(archiveRows(db)).toBe(0);
      const p2 = profile();
      del(p2.db);
      const e = engine(p2.db);
      e.service.refreshSchedule();
      await e.service.runner!.whenIdle();
      p2.db.exec(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET archived_at = '${new Date(Date.now() - 31 * DAY).toISOString()}'`);
      expect(archiveRows(p2.db)).toBe(1);
      e.online.value = false;
      await e.service.kick();
      expect(archiveRows(p2.db)).toBe(0);
    });

    it("the Removed list never shows a row past its 30 days, even before the purge ran", async () => {
      const { db } = profile();
      const e = engine(db);
      del(db, DEAL, new Date(Date.now() - 30 * DAY - 1000));
      expect(await e.service.listRemovedDeals()).toEqual([]);
      db.exec(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET archived_at = '${new Date(Date.now() - 1000).toISOString()}'`);
      expect(await e.service.listRemovedDeals()).toEqual([expect.objectContaining({ transactionId: DEAL, propertyAddress: "12 Main St, Springfield", deleting: false })]);
    });

    it("turning Keepr Cloud off erases the owner's rows (an owed Delete for good too); deleting the local user erases them by cascade", () => {
      const { db } = profile();
      del(db);
      archive.markDealPurgeOwed(db, USER_A, DEAL, new Date());
      disableForUser(db, PROJECT, USER_A, true, new Date());
      expect(archiveRows(db)).toBe(0);
      const p2 = profile();
      del(p2.db);
      p2.db.exec("DELETE FROM audit_logs");
      p2.db.prepare("DELETE FROM users_local WHERE id = ?").run(USER_A);
      expect(archiveRows(p2.db)).toBe(0);
    });

    it("forgetting another project erases rows archived under it; a backup restore erases rows whose deal the file holds and keeps the rest", () => {
      const { db } = profile();
      del(db);
      forgetOtherProjects(db, PROJECT);
      expect(archiveRows(db)).toBe(1);
      forgetOtherProjects(db, OTHER_PROJECT);
      expect(archiveRows(db)).toBe(0);
      const p2 = profile();
      const dealB = fz(50, 30);
      seedFullDeal(p2.db, USER_A, dealB, 3);
      del(p2.db);
      del(p2.db, dealB);
      p2.db.prepare("INSERT INTO transactions (id, user_id, property_address, status, detection_status) VALUES (?, ?, 'From the backup', 'active', 'confirmed')").run(DEAL, USER_A);
      prepareRestoredFile(p2.db);
      expect(archive.listArchivedDeals(p2.db, USER_A).map((d) => d.transactionId)).toEqual([dealB]);
    });

    it("the local user's id unified since the delete (the FK moved the owner): the rows come back under the current id", () => {
      const { db } = profile();
      del(db);
      const NEW = "user-a-unified-4263";
      db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u@example.test', 'google', ?)").run(NEW, NEW);
      db.prepare(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET owner_user_id = ?`).run(NEW);
      db.prepare("UPDATE contacts SET user_id = ?").run(NEW);
      db.prepare("UPDATE emails SET user_id = ?").run(NEW);
      db.prepare("UPDATE messages SET user_id = ?").run(NEW);
      db.prepare("UPDATE cloud_sync_settings SET user_id = ?").run(NEW);
      const r = restore(db, NEW);
      expect(r).toMatchObject({ ok: true, skippedTotal: 0 });
      expect(db.prepare("SELECT user_id FROM transactions WHERE id = ?").get(DEAL)).toEqual({ user_id: NEW });
      expect(n(db, "SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ? AND user_id = ?", DEAL, NEW)).toBe(2);
    });

    it("a machine rebind keeps the rows; once this computer is confirmed again the deal restores", () => {
      const { db } = profile();
      del(db);
      db.prepare("UPDATE cloud_sync_install SET machine_hash = 'another-machine'").run();
      expect(archiveRows(db)).toBe(1);
      db.prepare("UPDATE cloud_sync_settings SET enabled = 0").run();
      expect(restore(db)).toEqual({ ok: false, code: "cloud_off" });
      enableForUser(db, PROJECT, USER_A, { noticeVersion: 1, acceptedAt: "2026-11-01T00:00:00.000Z" }, new Date());
      expect(restore(db)).toMatchObject({ ok: true });
    });
  });

  // ================================================================ GOOD
  describe("GOOD: Delete for good, server first, then local (Q8, W36)", () => {
    it("after the removal was sent: purged online and erased here in one call", async () => {
      const { db, e } = await synced();
      const cloudId = e.server.deals[0].id;
      del(db);
      await pass(e);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "done" });
      expect(e.server.callsTo("cloud_purge_deal_now").map((c) => c.args.p_cloud_deal_id)).toEqual([cloudId]);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(e.server.todos.filter((t) => t.dealId === cloudId)).toEqual([]);
      expect(archiveRows(db)).toBe(0);
    });

    it("before the removal was sent: owed (Restore refused, listed as deleting), and the next pass removes it online first, then purges, then erases here", async () => {
      const { db, e } = await synced();
      del(db);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "pending" });
      // before the pass the answer started: nothing purged, Restore refused, listed as deleting
      expect(e.server.callsTo("cloud_purge_deal_now")).toHaveLength(0);
      expect(restore(db)).toEqual({ ok: false, code: "purge_owed" });
      expect(archive.listArchivedDeals(db, USER_A)).toEqual([expect.objectContaining({ deleting: true })]);
      await idle(e);
      const fns = e.server.calls.map((c) => c.fn);
      expect(fns.indexOf("cloud_delete_deal")).toBeGreaterThanOrEqual(0);
      expect(fns.indexOf("cloud_delete_deal")).toBeLessThan(fns.indexOf("cloud_purge_deal_now"));
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(archiveRows(db)).toBe(0);
    });

    it("offline: nothing is erased here, the row stays owed, and each pass retries until it finishes", async () => {
      const { db, e } = await synced();
      del(db);
      await pass(e);
      e.server.override = (fn) => (fn === "cloud_purge_deal_now" ? new Error("offline") : undefined);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "pending" });
      await idle(e);
      await pass(e);
      expect(archiveRows(db)).toBe(1);
      expect(e.server.softRemovedDeals).toHaveLength(1);
      e.server.override = null;
      await pass(e);
      expect(archiveRows(db)).toBe(0);
      expect(e.server.softRemovedDeals).toEqual([]);
    });

    it("W36: purged online but the answer never arrived (a crash or quit before the local step): Restore stays refused, the next pass gets not_found and erases the row", async () => {
      const { db, e } = await synced();
      del(db);
      await pass(e);
      e.server.override = (fn, args) => {
        if (fn !== "cloud_purge_deal_now") return undefined;
        e.server.respond(fn, args);
        return new Error("connection lost after the server committed");
      };
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "pending" });
      await idle(e);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(await e.service.restoreDeal(DEAL)).toEqual({ success: false, error: "purge_owed" });
      e.server.override = null;
      await pass(e);
      expect(archiveRows(db)).toBe(0);
    });

    it("restored elsewhere at the same moment (not_removed): nothing is erased, the owed mark is cleared, and the pull then restores the deal here", async () => {
      const { db, e } = await synced();
      del(db);
      await pass(e);
      e.server.override = (fn) => (fn === "cloud_todo_pull" ? new Error("offline") : undefined);
      e.server.restoreDealOnline(e.server.softRemovedDeals[0]);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "restored_elsewhere" });
      expect(e.server.deals).toHaveLength(1);
      expect(archive.listArchivedDeals(db, USER_A)).toEqual([expect.objectContaining({ deleting: false })]);
      e.server.override = null;
      await pass(e);
      expect(n(db, "SELECT COUNT(*) AS n FROM transactions WHERE id = ?", DEAL)).toBe(1);
      expect(archiveRows(db)).toBe(0);
    });

    it("never uploaded: only the local row goes, with no purge call", async () => {
      const { db } = profile();
      const e = engine(db);
      del(db);
      e.service.refreshSchedule();
      await e.service.runner!.whenIdle();
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "done" });
      expect(archiveRows(db)).toBe(0);
      expect(e.server.callsTo("cloud_purge_deal_now")).toHaveLength(0);
    });

    it("deleted before its first upload was recorded here (the online copy is live, no online id in the archive): found by local id, removed, then purged", async () => {
      const { db, e } = await synced();
      db.prepare("DELETE FROM cloud_sync_state WHERE entity = 'deal'").run();
      del(db);
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "done" });
      expect(e.server.deals).toEqual([]);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(archiveRows(db)).toBe(0);
    });

    it.each([
      ["the listing call fails (transport)", () => new Error("offline")],
      ["the listing is refused (non-ok answer)", () => ({ data: { ok: false, error: "unknown" }, error: null, status: 200 })],
      ["the listing answers ok without its rows", () => ({ data: { ok: true }, error: null, status: 200 })],
    ])("no online id in the archive and %s: still owed, nothing erased here or online", async (_label, answer) => {
      const { db, e } = await synced();
      db.prepare("DELETE FROM cloud_sync_state WHERE entity = 'deal'").run();
      del(db);
      await pass(e);
      expect(e.server.deals).toHaveLength(1);
      e.server.override = (fn) => (fn === "cloud_list_install_rows" ? (answer() as never) : undefined);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "pending" });
      expect(archive.listArchivedDeals(db, USER_A)).toEqual([expect.objectContaining({ deleting: true })]);
      expect(e.server.callsTo("cloud_purge_deal_now")).toHaveLength(0);
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(0);
      expect(e.server.deals).toHaveLength(1);
    });

    it("the session changes between the removal and the purge: the purge is not sent and the row stays owed", async () => {
      const { db, e } = await synced();
      db.prepare("DELETE FROM cloud_sync_state WHERE entity = 'deal'").run();
      del(db);
      await pass(e);
      e.server.override = (fn, args) => {
        if (fn !== "cloud_delete_deal") return undefined;
        const r = e.server.respond(fn, args);
        e.authUser.id = USER_B; // another account signs in while the removal is in flight
        return { data: r as never, error: null, status: 200 };
      };
      const res = await e.service.deleteDealForGood(DEAL);
      expect(res).toEqual({ success: true, status: "pending" });
      expect(e.server.callsTo("cloud_delete_deal")).toHaveLength(1);
      expect(e.server.callsTo("cloud_purge_deal_now")).toHaveLength(0);
      expect(archive.listArchivedDeals(db, USER_A)).toEqual([expect.objectContaining({ deleting: true })]);
    });

    it("an archive this build does not understand is still erased by Delete for good, online first", async () => {
      const { db, e } = await synced();
      const cloudId = e.server.deals[0].id;
      del(db);
      await pass(e);
      editPayload(db, (p) => void (p.format = 99));
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "done" });
      expect(e.server.callsTo("cloud_purge_deal_now").map((c) => c.args.p_cloud_deal_id)).toEqual([cloudId]);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(archiveRows(db)).toBe(0);
    });

    it("an unreadable archive row (not JSON) never breaks the list, the pass or another project's clean-up, and Delete for good still erases it online first", async () => {
      const { db, e } = await synced();
      del(db);
      await pass(e);
      db.prepare(`UPDATE ${archive.DEAL_ARCHIVE_TABLE} SET payload_json = 'not json'`).run();
      expect(archive.listArchivedDeals(db, USER_A)).toEqual([expect.objectContaining({ transactionId: DEAL, propertyAddress: null })]);
      expect(restore(db)).toEqual({ ok: false, code: "restore_failed" });
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: true, status: "done" });
      expect(e.server.callsTo("cloud_purge_deal_now")).toHaveLength(1);
      expect(e.server.softRemovedDeals).toEqual([]);
      expect(archiveRows(db)).toBe(0);
    });

    it("another local user's row: not_owner, nothing marked", async () => {
      const { db } = profile();
      del(db);
      const e = engine(db, undefined, USER_B);
      expect(await e.service.deleteDealForGood(DEAL)).toEqual({ success: false, error: "not_owner" });
      expect(archive.listArchivedDeals(db, USER_A)).toEqual([expect.objectContaining({ deleting: false })]);
    });
  });

  // ================================================================ reconcile listing rule
  describe("the reconcile: an ok listing without its rows is a failed read", () => {
    it("nothing is forgotten, marked or uploaded again, and the reconcile is retried later", async () => {
      const { db, e } = await synced();
      const state = db.prepare("SELECT cloud_id, content_hash, last_status FROM cloud_sync_state WHERE entity = 'deal'").all();
      const shadow = shadowRows(db, DEAL);
      db.prepare("UPDATE cloud_sync_settings SET last_state_at = NULL").run();
      e.server.override = (fn) => (fn === "cloud_list_install_rows" ? { data: { ok: true }, error: null, status: 200 } : undefined);
      const upserts = e.server.callsTo("cloud_upsert_deal").length;
      await pass(e);
      expect(db.prepare("SELECT cloud_id, content_hash, last_status FROM cloud_sync_state WHERE entity = 'deal'").all()).toEqual(state);
      expect(shadowRows(db, DEAL)).toBe(shadow);
      expect(n(db, "SELECT COUNT(*) AS n FROM cloud_sync_dirty")).toBe(0);
      expect(e.server.callsTo("cloud_upsert_deal").length).toBe(upserts);
      expect(db.prepare("SELECT last_state_at FROM cloud_sync_settings").get()).toEqual({ last_state_at: null });
    });
  });

  // ================================================================ PR-4b carry (b)
  describe("PR-4b carry: the 'behind' detection runs only in a full pull", () => {
    it("an incremental pull with last_seq 0 whose page reports a higher install_max_edit_seq than the counter stores no 'behind'", async () => {
      const { db, e } = await synced();
      void e;
      db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = 0, full_pull_owed = 0, full_pull_kind = NULL").run();
      db.prepare("UPDATE cloud_sync_todo_counter SET edit_seq = 0, rewound_at = NULL").run();
      applyTodoPage(db, { projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: new Date() }, { rows: [], next_after: 0, horizon: 0, install_max_edit_seq: 999 }, 500);
      expect(db.prepare("SELECT full_pull_owed, full_pull_kind FROM cloud_sync_todo_cursor").get()).toEqual({ full_pull_owed: 0, full_pull_kind: null });
      // positive control: the same answer as the first page of a full pull (not its last page) is detected
      db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = 0, full_pull_owed = 1, full_pull_kind = NULL").run();
      db.prepare("UPDATE cloud_sync_todo_counter SET edit_seq = 0, rewound_at = NULL").run();
      applyTodoPage(db, { projectRef: PROJECT, userId: USER_A, installId: INSTALL, now: new Date() }, { rows: [{ entity: "unknown" }], next_after: 1, horizon: 0, install_max_edit_seq: 999 }, 1);
      expect(db.prepare("SELECT full_pull_kind FROM cloud_sync_todo_cursor").get()).toEqual({ full_pull_kind: "behind" });
    });
  });
});
