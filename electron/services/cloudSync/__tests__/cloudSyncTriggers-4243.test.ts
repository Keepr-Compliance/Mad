/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-2 — dirty-mark triggers on the real schema.sql
 * (C2.8, C2.9, C2.11, C2.12, C2.13, C2.14, C2.15, C2.29).
 * Driver: see helpers/sqlite.ts (the title names the one that ran).
 */
import { CLOUD_SYNC_TABLES_DDL, CLOUD_SYNC_TRIGGERS, DEAL_TRIGGER_COLUMNS } from "../../db/cloudSyncSql";
import { projectDeal, type DealRow } from "../projection";
import { readDealRow, clearMarkIfGeneration, recordRetryableFailure, selectDueDirty } from "../../db/cloudSyncDbService";
import { dropCloudSyncTriggers, ensureCloudSyncTriggers, markAllEligibleAfterMigration } from "../../db/cloudSyncTriggers";
import { DRIVER } from "./helpers/sqlite";
import {
  dealId,
  dirty,
  dirtyCount,
  enableUser,
  freshDb,
  insertDeal,
  SCHEMA_SQL,
  triggerNames,
  USER_A,
  USER_B,
} from "./helpers/fixtures";


/** The repo's rebuild pattern (v72/v78): same DDL under a new name, copy, drop, rename. */
function rebuildSql(db: ReturnType<typeof freshDb>, table: string): string {
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
  const newDdl = ddl.replace(/^CREATE TABLE\s+("?)[A-Za-z_]+\1/, `CREATE TABLE ${table}_new`);
  return `${newDdl};
    INSERT INTO ${table}_new SELECT * FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_new RENAME TO ${table};`;
}

describe(`Keepr Cloud triggers [${DRIVER}]`, () => {
  it("schema.sql declares the five cloud_sync tables exactly as cloudSyncSql mirrors them, and no cloud trigger", () => {
    const schema = SCHEMA_SQL.replace(/\r\n/g, "\n");
    for (const stmt of CLOUD_SYNC_TABLES_DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
      expect(schema).toContain(stmt);
    }
    expect(SCHEMA_SQL).not.toMatch(/trg_cloud_sync_/);
  });

  it("C2.13: with no enabled settings row, a deal write adds no mark", () => {
    const db = freshDb();
    insertDeal(db, dealId());
    db.prepare("UPDATE transactions SET property_city = 'X'").run();
    db.prepare("DELETE FROM transactions").run();
    expect(dirtyCount(db)).toBe(0);
  });

  it("C2.13 positive: with an enabled row, insert, update and delete each mark", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    expect(dirty(db)).toMatchObject([{ transaction_id: id, generation: 1 }]);
    db.prepare("UPDATE transactions SET property_city = 'X' WHERE id = ?").run(id);
    expect(dirty(db)[0].generation).toBe(2);
    db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    expect(dirty(db)[0].generation).toBe(3);
  });

  it("C2.8: a mark landing between the pass's read and its delete leaves the deal dirty", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    const [read] = selectDueDirty(db, USER_A, new Date(), 10);
    db.prepare("UPDATE transactions SET property_city = 'Y' WHERE id = ?").run(id);
    expect(clearMarkIfGeneration(db, id, read.generation)).toBe(false);
    expect(dirty(db)).toMatchObject([{ transaction_id: id, generation: 2 }]);
    expect(clearMarkIfGeneration(db, id, 2)).toBe(true);
    expect(dirtyCount(db)).toBe(0);
  });

  it("C2.9: a new write bumps the generation and leaves attempts and next_attempt_at intact", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    const [row] = selectDueDirty(db, USER_A, new Date(), 10);
    recordRetryableFailure(db, row, "network", new Date("2026-11-14T00:00:00.000Z"));
    const before = dirty(db)[0];
    db.prepare("UPDATE transactions SET property_city = 'Z' WHERE id = ?").run(id);
    const after = dirty(db)[0];
    expect(after.generation).toBe(before.generation + 1);
    expect(after.attempts).toBe(1);
    expect(after.next_attempt_at).toBe(before.next_attempt_at);
    expect(after.last_error_code).toBe("network");
  });

  it("C2.11: deleting a deal with checklists and items (cascade) succeeds and leaves exactly one mark", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    db.prepare("INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', ?, 't1', 'List')").run(id);
    db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i1', 'c1', 'One'), ('i2', 'c1', 'Two')").run();
    db.exec("DELETE FROM cloud_sync_dirty");
    expect(() => db.prepare("DELETE FROM transactions WHERE id = ?").run(id)).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items").get() as { n: number }).n).toBe(0);
    expect(dirty(db).map((d) => d.transaction_id)).toEqual([id]);
  });

  it("C2.11b: an item insert, update and delete mark the item's deal", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    db.prepare("INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', ?, 't1', 'List')").run(id);
    db.exec("DELETE FROM cloud_sync_dirty");
    db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i1', 'c1', 'One')").run();
    expect(dirty(db)).toMatchObject([{ transaction_id: id, generation: 1 }]);
    db.prepare("UPDATE transaction_checklist_items SET title = 'Uno' WHERE id = 'i1'").run();
    db.prepare("DELETE FROM transaction_checklist_items WHERE id = 'i1'").run();
    expect(dirty(db)[0].generation).toBe(3);
  });

  it("C2.12: after a rebuild of a trigger's table the create step restores the triggers; a changed body replaces the old", () => {
    const db = freshDb();
    enableUser(db);
    db.pragma("foreign_keys = OFF");
    // The repo's rebuild pattern (v72/v78): new table, copy, drop, rename.
    db.exec(rebuildSql(db, "transaction_checklist_items"));
    db.pragma("foreign_keys = ON");
    expect(triggerNames(db)).not.toContain("trg_cloud_sync_item_insert");
    db.exec("DROP TRIGGER trg_cloud_sync_tx_insert; CREATE TRIGGER trg_cloud_sync_tx_insert AFTER INSERT ON transactions BEGIN SELECT 1; END;");
    const r = ensureCloudSyncTriggers(db);
    expect(r).toMatchObject({ ok: true, skipped: [] });
    expect(triggerNames(db)).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    const id = dealId();
    insertDeal(db, id);
    expect(dirty(db).map((d) => d.transaction_id)).toEqual([id]);
  });

  it("C2.29: a migration that rebuilds transaction_checklists and its items runs with drop-before/create-after, then triggers exist and mark", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    db.prepare("INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', ?, 't1', 'List')").run(id);
    db.exec("DELETE FROM cloud_sync_dirty");
    const rebuild = () => {
      db.pragma("foreign_keys = OFF");
      db.exec(`BEGIN; ${rebuildSql(db, "transaction_checklists")} ${rebuildSql(db, "transaction_checklist_items")} COMMIT;`);
      db.pragma("foreign_keys = ON");
    };
    expect(dropCloudSyncTriggers(db)).toBe(true);
    expect(triggerNames(db)).toEqual([]);
    expect(rebuild).not.toThrow();
    expect(ensureCloudSyncTriggers(db)).toMatchObject({ ok: true, skipped: [] });
    expect(markAllEligibleAfterMigration(db)).toBe(true);
    expect(dirty(db).map((d) => d.transaction_id)).toEqual([id]);
    db.prepare("INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES ('i9', 'c1', 'New')").run();
    expect(dirty(db)[0].generation).toBe(2);
  });

  it("C2.29 control: the same rebuild WITH the item trigger present (no drop first) does not leave a working database", () => {
    const db = freshDb();
    enableUser(db);
    db.pragma("foreign_keys = OFF");
    let threw = false;
    try {
      db.exec(rebuildSql(db, "transaction_checklists"));
    } catch {
      threw = true;
    }
    db.pragma("foreign_keys = ON");
    // SR N3 (sqlite3 3.43.2, legacy_alter_table OFF): the RENAME fails while the
    // item trigger reads transaction_checklists. This is why the drop runs first.
    expect(threw).toBe(true);
  });

  it("C2.14: each projection column alone marks; updated_at or last_pending_scan_at alone does not", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    const sample: Record<string, unknown> = {
      transaction_type: "sale",
      status: "closed",
      detection_status: "confirmed",
      detection_source: "auto",
      submission_status: "submitted",
      export_status: "exported",
      user_id: USER_B,
    };
    for (const col of DEAL_TRIGGER_COLUMNS) {
      db.exec("DELETE FROM cloud_sync_dirty");
      const v = col in sample ? sample[col] : col.endsWith("_price") || col.includes("rate") || col.includes("amount") || col === "detection_confidence" ? 7 : "2026-02-02";
      db.prepare(`UPDATE transactions SET ${col} = ? WHERE id = ?`).run(v, id);
      expect({ col, marked: dirtyCount(db) }).toEqual({ col, marked: 1 });
      if (col === "user_id") db.prepare("UPDATE transactions SET user_id = ? WHERE id = ?").run(USER_A, id);
    }
    for (const col of ["updated_at", "last_pending_scan_at", "message_count"]) {
      db.exec("DELETE FROM cloud_sync_dirty");
      db.prepare(`UPDATE transactions SET ${col} = ? WHERE id = ?`).run(col === "message_count" ? 3 : "2026-03-03 00:00:00", id);
      expect({ col, marked: dirtyCount(db) }).toEqual({ col, marked: 0 });
    }
  });

  it("C2.14: any single-column update that changes the deal's content_hash leaves a mark", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    const cols = (db.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string; type: string }>).filter(
      (c) => c.name !== "id",
    );
    let checked = 0;
    for (const c of cols) {
      const before = projectDeal(readDealRow(db, id) as unknown as DealRow, "i").hash;
      db.exec("DELETE FROM cloud_sync_dirty");
      const value =
        c.name === "user_id" ? USER_B
        : /INT|REAL/.test(c.type) ? 0.5
        : c.name === "transaction_type" ? "other"
        : c.name === "status" ? "closed"
        : c.name === "detection_status" ? "pending"
        : c.name === "detection_source" ? "hybrid"
        : c.name === "submission_status" ? "approved"
        : c.name === "export_status" ? "exported"
        : c.name === "stage_source" ? "user"
        : c.name === "export_format" ? "pdf"
        : "2026-04-04";
      try {
        db.prepare(`UPDATE transactions SET ${c.name} = ? WHERE id = ?`).run(value, id);
      } catch {
        continue; // a CHECK refused the sample value: the column cannot hold it
      }
      const after = projectDeal(readDealRow(db, id) as unknown as DealRow, "i").hash;
      if (after !== before) {
        checked++;
        expect({ col: c.name, marked: dirtyCount(db) }).toEqual({ col: c.name, marked: 1 });
      }
      if (c.name === "user_id") db.prepare("UPDATE transactions SET user_id = ? WHERE id = ?").run(USER_A, id);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("C2.15: drop and create steps never throw; a broken handle gives one warning each", () => {
    const warns: string[] = [];
    const log = { warn: (m: string) => warns.push(m) };
    const fail = () => {
      throw Object.assign(new Error("x"), { code: "SQLITE_ERROR" });
    };
    const broken = { exec: fail, prepare: fail, transaction: () => fail };
    expect(dropCloudSyncTriggers(broken, log)).toBe(false);
    expect(ensureCloudSyncTriggers(broken, log).ok).toBe(false);
    expect(markAllEligibleAfterMigration(broken, log)).toBe(false);
    expect(warns).toHaveLength(3);
  });

  it("C2.10 (SQL level): on a shape that lacks cloud_sync_settings or a watched column, the create step skips those triggers and every deal write still succeeds", () => {
    const db = freshDb({ triggers: false });
    db.exec("DROP TABLE cloud_sync_settings");
    const r = ensureCloudSyncTriggers(db);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(0);
    expect(triggerNames(db)).toEqual([]);
    expect(() => insertDeal(db, dealId())).not.toThrow();
  });

  it("C2.28 (migration step): marks every eligible deal of enabled users only", () => {
    const db = freshDb();
    enableUser(db, USER_A);
    const a1 = dealId();
    const a2 = dealId();
    const b1 = dealId();
    insertDeal(db, a1);
    insertDeal(db, a2, USER_A, { detection_status: "pending" });
    insertDeal(db, b1, USER_B);
    db.exec("DELETE FROM cloud_sync_dirty");
    markAllEligibleAfterMigration(db);
    expect(dirty(db).map((d) => d.transaction_id)).toEqual([a1]);
  });
});
