/**
 * @jest-environment node
 */
/**
 * Migration v74 — BACKLOG-3619: the Google Messages import's local tables
 * (18 rcs_* + message_source_coverage, with their indexes) in ONE versioned
 * migration (SR whole-branch review).
 *
 * Mutation controls (each turns a test red):
 *   M1 a table / index missing from the migration                    → "creates every"
 *   M2 the migration's DDL drifting from schema.sql                   → "identical to schema.sql"
 *   M3 not idempotent (a second run, or an existing table, changes it) → "idempotent"
 *   M5 v74 not in the chain (or not the last)                         → "in the chain"
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { V74_RCS_LOCAL_TABLES_SQL, V74_RCS_TABLES } from "../db/migrationV74Sql";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const FROZEN = fs.readFileSync(path.join(__dirname, "fixtures", "chain-v69-schema.sql"), "utf8");
const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

function chain(): Array<{ version: number; migrate: (d: DatabaseType) => void }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  return (svc.constructor as { MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }> }).MIGRATIONS;
}
function v74() {
  const entry = chain().find((m) => m.version === 74);
  if (!entry) throw new Error("v74 is not in DatabaseService.MIGRATIONS");
  return entry;
}

/** A pre-v74 database: the frozen v69 transcript (no RCS tables). */
function preV74(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(FROZEN);
  return db;
}

/** As the runner does: one transaction, foreign_keys OFF. */
function runV74(db: DatabaseType): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => v74().migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const names = (db: DatabaseType, type: "table" | "index") =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as Array<{ name: string }>).map((r) => r.name);
const columns = (db: DatabaseType, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>);

/** schema.sql's statements for these objects, comments dropped — the extraction rule of the generator. */
function schemaStatements(): string[] {
  const noComments = SCHEMA.replace(/\r\n/g, "\n").split("\n").map((line) => {
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "'") inQ = !inQ;
      if (!inQ && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i).trimEnd();
    }
    return line;
  }).join("\n");
  const want = /^CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(rcs_\w+|message_source_coverage|idx_rcs_\w+)\b/i;
  return noComments.split(";").map((s) => s.trim()).filter((s) => want.test(s)).map((s) => s.replace(/\n\s*\n/g, "\n") + ";");
}

describe("migration v74 — the Google Messages import's local tables", () => {
  let db: DatabaseType;
  afterEach(() => db?.close());

  it("in the chain, with no gap (v75, BACKLOG-3764, follows it)", () => {
    const versions = chain().map((m) => m.version);
    expect(versions).toContain(74);
    expect(versions).toContain(73);
    expect(versions.indexOf(75)).toBe(versions.indexOf(74) + 1);
  });

  it("the migration's statements are identical to schema.sql's (no drift)", () => {
    expect([...V74_RCS_LOCAL_TABLES_SQL]).toEqual(schemaStatements());
    expect(V74_RCS_TABLES).toHaveLength(19);
  });

  it("creates every table and declared index on a database that has none", () => {
    db = preV74();
    expect(names(db, "table").filter((n) => n.startsWith("rcs_") || n === "message_source_coverage")).toEqual([]);
    runV74(db);
    for (const t of V74_RCS_TABLES) expect([t, names(db, "table").includes(t)]).toEqual([t, true]);
    for (const i of ["idx_rcs_cache_staging_messages_sent", "idx_rcs_chat_exclusions_conv", "idx_rcs_chat_exclusions_hash", "idx_rcs_pending_full_sync_user", "idx_rcs_chat_people_number"]) {
      expect([i, names(db, "index").includes(i)]).toEqual([i, true]);
    }
  });

  it("idempotent: a fresh install (schema.sql already ran) and a second run change nothing", () => {
    db = preV74();
    db.exec(SCHEMA);
    const before = V74_RCS_TABLES.map((t) => [t, columns(db, t)]);
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u1', 'synthetic@example.test', 'google', 'oid-1')").run();
    db.prepare("INSERT INTO rcs_consent (user_id, consent_version) VALUES ('u1', 1)").run();
    runV74(db);
    runV74(db);
    expect(V74_RCS_TABLES.map((t) => [t, columns(db, t)])).toEqual(before);
    expect(db.prepare("SELECT consent_version FROM rcs_consent WHERE user_id = 'u1'").get()).toEqual({ consent_version: 1 });
  });
});
