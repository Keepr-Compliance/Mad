/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-3 — the new contact-level triggers: a migration that rebuilds
 * `contacts` succeeds and ends with the triggers present; and the cost of the
 * triggers on a 5,000-contact import with Keepr Cloud off (measured, written to
 * a file; the assertion is zero marks, not a time).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { CLOUD_SYNC_TRIGGERS } from "../../db/cloudSyncSql";
import {
  applyCloudSyncTriggerRule,
  dropCloudSyncTriggers,
  ensureCloudSyncTriggers,
  markAllEligibleAfterMigration,
} from "../../db/cloudSyncTriggers";
import { DRIVER } from "./helpers/sqlite";
import { dealId, dirty, dirtyCount, enableUser, freshDb, insertContact, insertDeal, insertParty, triggerNames, USER_A, USER_B } from "./helpers/fixtures";

function rebuildSql(db: ReturnType<typeof freshDb>, table: string): string {
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
  const newDdl = ddl.replace(/^CREATE TABLE\s+("?)[A-Za-z_]+\1/, `CREATE TABLE ${table}_new`);
  return `${newDdl}; INSERT INTO ${table}_new SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`;
}

describe(`Keepr Cloud PR-3 triggers [${DRIVER}]`, () => {
  it("control: rebuilding contacts silently drops its own trigger; without the create step a rename marks nothing", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    insertContact(db, "ct-1");
    insertParty(db, "pt-1", id, "ct-1");
    const views = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql LIKE '%contacts%'").all() as Array<{ name: string; sql: string }>;
    db.pragma("foreign_keys = OFF");
    db.exec(`${views.map((v) => `DROP VIEW ${v.name};`).join(" ")} ${rebuildSql(db, "contacts")} ${views.map((v) => `${v.sql};`).join(" ")}`);
    db.pragma("foreign_keys = ON");
    expect(triggerNames(db)).not.toContain("trg_cloud_sync_contact_update");
    db.exec("DELETE FROM cloud_sync_dirty");
    db.prepare("UPDATE contacts SET display_name = 'Renamed' WHERE id = 'ct-1'").run();
    expect(dirtyCount(db)).toBe(0);
  });

  it("a migration that rebuilds contacts succeeds with drop-before/create-after, ends with every trigger, and a rename marks", () => {
    const db = freshDb();
    enableUser(db);
    const id = dealId();
    insertDeal(db, id);
    insertContact(db, "ct-1");
    insertParty(db, "pt-1", id, "ct-1");
    db.exec("DELETE FROM cloud_sync_dirty");
    expect(dropCloudSyncTriggers(db)).toBe(true);
    db.pragma("foreign_keys = OFF");
    // As a real migration must: views that read contacts are dropped and re-created around the rebuild.
    const views = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql LIKE '%contacts%'").all() as Array<{ name: string; sql: string }>;
    expect(views.length).toBeGreaterThan(0);
    const rebuild = `BEGIN; ${views.map((v) => `DROP VIEW ${v.name};`).join(" ")} ${rebuildSql(db, "contacts")} ${views.map((v) => `${v.sql};`).join(" ")} COMMIT;`;
    expect(() => db.exec(rebuild)).not.toThrow();
    db.pragma("foreign_keys = ON");
    expect(ensureCloudSyncTriggers(db)).toMatchObject({ ok: true, skipped: [] });
    expect(markAllEligibleAfterMigration(db)).toBe(true);
    expect(triggerNames(db)).toEqual(CLOUD_SYNC_TRIGGERS.map((t) => t.name).sort());
    db.exec("DELETE FROM cloud_sync_dirty");
    db.prepare("UPDATE contacts SET display_name = 'Renamed' WHERE id = 'ct-1'").run();
    expect(dirty(db).map((d) => d.transaction_id)).toEqual([id]);
  });

  it("cost: 5,000 contacts with an email, a phone and a source link each — triggers absent vs present with Cloud off vs present with Cloud on (no deals)", () => {
    const N = 5000;
    const run = (mode: "absent" | "off" | "on") => {
      // R1: "off" is a real never-on profile (the open's rule applied: no triggers); "on" has them.
      const db = freshDb({ triggers: mode === "on" });
      if (mode === "off") applyCloudSyncTriggerRule(db);
      if (mode === "on") enableUser(db, USER_B);
      const t0 = process.hrtime.bigint();
      db.exec("BEGIN");
      const c = db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, 'contacts_app')");
      const e = db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)");
      const p = db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)");
      const l = db.prepare(
        "INSERT INTO contact_source_links (id, user_id, contact_id, source_type, source_record_id, match_method) VALUES (?, ?, ?, 'macos', ?, 'source_id')",
      );
      for (let i = 0; i < N; i++) {
        const id = `imp-${i}`;
        c.run(id, USER_A, `Imported ${i}`);
        e.run(`e-${i}`, id, `p${i}@example.test`);
        p.run(`p-${i}`, id, `+1555555${String(i).padStart(4, "0")}`);
        l.run(`l-${i}`, USER_A, id, `r-${i}`);
      }
      db.prepare("UPDATE contacts SET display_name = display_name || '.' WHERE id LIKE 'imp-%'").run();
      db.exec("COMMIT");
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const triggers = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%'").get() as { n: number }).n;
      return { ms: Math.round(ms), marks: dirtyCount(db), triggers };
    };
    const results = { driver: DRIVER, contacts: N, absent: run("absent"), off: run("off"), on: run("on") };
    expect(results.off.triggers).toBe(0);
    fs.writeFileSync(path.join(os.tmpdir(), "keepr-4243-trigger-cost.json"), JSON.stringify(results, null, 2));
    expect(results.absent.marks).toBe(0);
    expect(results.off.marks).toBe(0);
    expect(results.on.marks).toBe(0);
  });
});
