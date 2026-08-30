/**
 * @jest-environment node
 *
 * SCHEMA-BASELINE GENERATOR — BACKLOG-2993.
 *
 * Produces every artefact of the schema-baseline reset, each a TRANSCRIPT of a
 * real producer (schema.sql + the real migration runner), never hand-written:
 *
 *   mode=freeze  (MUST run while the migration chain still exists — the chain
 *                 is deleted by BACKLOG-2993, so this mode's outputs can never
 *                 be regenerated from a tree without it; that is the one-way
 *                 window described in the plan):
 *     - fixtures/chain-v69-schema.sql   old schema.sql + FULL real chain → v69.
 *                                       The frozen side of the parity control
 *                                       (C2) AND the v69 boundary-sweep file.
 *     - fixtures/chain-v68-schema.sql   old schema.sql + chain clipped to <=68.
 *                                       The v68 boundary-sweep file.
 *     - schema.sql.new                  the regenerated baseline schema:
 *                                       the v69 transcript rewritten with
 *                                       IF NOT EXISTS, seeded at version 70.
 *     - and it RUNS THE TWO-LIVE-SIDES COMPARISON: a fresh exec of the
 *       regenerated schema.sql.new is fingerprint-diffed against the live
 *       old-schema+chain build. This run is the one-time proof that the frozen
 *       transcript is faithful; the committed fixture is the durable control
 *       thereafter. The run FAILS if the two sides diverge at all.
 *
 *   mode=fresh   (run AFTER electron/database/schema.sql is the regenerated
 *                 file):
 *     - fixtures/fresh-v70-schema.sql   fresh install on the NEW schema.sql —
 *                                       a real producer. The v70 sweep file.
 *     - fixtures/fresh-v71-schema.sql   the v70 build plus ONE documented
 *                                       synthetic edit: UPDATE schema_version
 *                                       SET version = 71. The v71 sweep file
 *                                       (a future build's number — no real
 *                                       producer for it can exist today).
 *
 * ===========================================================================
 * THIS FILE DOES NOT RUN IN CI, AND MUST NOT
 * ===========================================================================
 * Its name ends `.gen.ts`, not `.test.ts` / `.spec.ts`, so it matches neither
 * CI's `testMatch` nor the local one. It is a generator, run by hand; its
 * outputs are what get committed and what CI reads.
 *
 * ===========================================================================
 * HOW TO RUN
 * ===========================================================================
 *   cd <worktree>
 *   cp electron/services/__tests__/generateSchemaBaseline.gen.ts \
 *      electron/services/__tests__/generateSchemaBaseline.run.test.ts
 *   KEEPR_BASELINE_MODE=freeze \
 *   KEEPR_BASELINE_OUT_DIR=electron/services/__tests__/fixtures \
 *     ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/generateSchemaBaseline.run.test.ts --bail=0
 *   rm electron/services/__tests__/generateSchemaBaseline.run.test.ts
 *
 * (mode=freeze additionally writes schema.sql.new into KEEPR_BASELINE_OUT_DIR;
 * move it to electron/database/schema.sql in the regeneration commit. Then run
 * mode=fresh the same way.)
 *
 * `ELECTRON_RUN_AS_NODE=1 npx electron .../jest.js` is REQUIRED, not a
 * preference: the shared `better-sqlite3-multiple-ciphers` binary rests at the
 * Electron ABI, so plain `npx jest` cannot load the real driver. Do NOT run
 * `npm test`, `npm install` or `npm rebuild` to work around that — they rewrite
 * the shared binary through symlinked node_modules and break the running dev
 * app in every sibling worktree.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — same block as buildV2270Fixture.gen.ts. Sentry.flush is included
// because runMigrations() awaits it on the failure path.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { setDb, setEncryptionKey } from "../db/core/dbConnection";
import { extractFingerprint, diffFingerprints } from "./helpers/schemaFingerprint";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the point of this file is the real driver.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

/** SQLite literal for a value read back out of the driver. */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return `X'${v.toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Dump a database to replayable SQL text — same discipline as
 * buildV2270Fixture.gen.ts's dump: tables first, then every row, then
 * views / indexes / triggers, so a standalone `CREATE INDEX` in the dump can
 * never precede the table it indexes (BACKLOG-2751's mechanism, made
 * impossible by construction). ORDER BY name, not rootpage/creation order:
 * physical order is not stable between two runs that produce logically
 * identical databases, and an unstable dump buries a real change in noise.
 */
function dumpDatabase(db: DatabaseType, header: string): string {
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;

  const out: string[] = [header, "PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;", ""];

  for (const o of objects.filter((x) => x.type === "table")) out.push(`${o.sql};`);
  out.push("");

  for (const o of objects.filter((x) => x.type === "table")) {
    const rows = db.prepare(`SELECT * FROM "${o.name}" ORDER BY rowid`).all() as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) continue;
    const cols = (db.prepare(`PRAGMA table_info("${o.name}")`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const colList = cols.map((c) => `"${c}"`).join(", ");
    for (const row of rows) {
      out.push(
        `INSERT INTO "${o.name}" (${colList}) VALUES (${cols.map((c) => sqlLiteral(row[c])).join(", ")});`,
      );
    }
    out.push("");
  }

  for (const o of objects.filter((x) => x.type !== "table")) out.push(`${o.sql};`);

  out.push("", "COMMIT;", "");
  return out.join("\n");
}

/**
 * Rewrite one sqlite_master DDL statement with IF NOT EXISTS, preserving it
 * when the authored text already carries the clause. schema.sql is exec'd on
 * EVERY open, so every statement must be idempotent.
 */
function withIfNotExists(sql: string): string {
  // Anchor the already-has-it check to the statement HEAD via lookahead, never
  // the whole text: DDL bodies carry prose comments that can contain the words
  // "IF NOT EXISTS" (the `attachments` table's does), and a whole-text test
  // silently skips the rewrite for exactly those statements. This is the same
  // false-hit class the SR review flagged for `contact_source_links` appearing
  // in a schema.sql comment — match on DDL, not on words.
  return sql
    .replace(/^CREATE TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE UNIQUE INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/^CREATE INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE INDEX IF NOT EXISTS ")
    .replace(/^CREATE TRIGGER\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE TRIGGER IF NOT EXISTS ")
    .replace(/^CREATE VIEW\s+(?!IF\s+NOT\s+EXISTS)/i, "CREATE VIEW IF NOT EXISTS ");
}

/**
 * Emit the regenerated schema.sql from a chain-built database.
 *
 * Emission order is BY TYPE, then by name within each type:
 * tables → views → indexes → triggers. This makes the BACKLOG-2751 defect —
 * a standalone CREATE INDEX preceding the table whose final shape it indexes —
 * structurally impossible: every index is emitted after every table, and every
 * table already carries its final (post-chain) column set. Views precede
 * triggers because SQLite resolves a trigger's references at CREATE time, and
 * a trigger MAY reference a view; the reverse dependency cannot occur
 * (indexes cannot target views; view bodies are resolved at query time).
 *
 * The whole file is wrapped in BEGIN TRANSACTION / COMMIT so a crash mid-exec
 * on a first install leaves an EMPTY database (→ retried as a fresh install on
 * the next launch) rather than tables-without-schema_version, which the
 * baseline fence would refuse as a pre-reset relic.
 */
function emitSchemaSql(db: DatabaseType, header: string, seedVersion: number): string {
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;

  const byType = (t: string) => objects.filter((o) => o.type === t);

  const out: string[] = [header, "BEGIN TRANSACTION;", ""];
  for (const t of ["table", "view", "index", "trigger"]) {
    for (const o of byType(t)) out.push(`${withIfNotExists(o.sql)};`, "");
  }
  out.push(
    "-- Initialize schema version if not exists.",
    `-- Version ${seedVersion}: the post-reset baseline (BACKLOG-2993). This file IS the`,
    `-- v69-chain shape, declared as version ${seedVersion} so that the baseline fence in`,
    "-- databaseService accepts only databases built from this file — and refuses",
    "-- every database the deleted migration chain ever touched.",
    `INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ${seedVersion});`,
    "",
    "COMMIT;",
    "",
  );
  return out.join("\n");
}

function provenanceHeader(lines: string[]): string {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  return [
    "-- ===================================================================",
    "-- GENERATED — DO NOT HAND-EDIT (BACKLOG-2993)",
    "-- ===================================================================",
    "-- Produced by electron/services/__tests__/generateSchemaBaseline.gen.ts.",
    "-- Regeneration steps are in that file's header.",
    "--",
    `-- source commit : ${sha}`,
    `-- generated     : ${date}`,
    ...lines.map((l) => `-- ${l}`),
    "-- ===================================================================",
    "",
  ].join("\n");
}

/** Build a database by exec'ing schema SQL text and running the REAL runner. */
async function buildChainDb(
  dbFile: string,
  schemaSqlText: string,
  maxVersion: number | null,
): Promise<{ db: DatabaseType; version: number }> {
  const db = new RealDatabase(dbFile) as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.exec(schemaSqlText);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const service = require("../databaseService").default as AnyService;
  const klass = service.constructor as {
    MIGRATIONS: Array<{ version: number }>;
  };
  service.db = db;
  setDb(db);
  setEncryptionKey("test-encryption-key-hex");
  // dbPath stays null: _runVersionedMigrations() refuses to migrate an on-disk
  // DB that has no pre-existing `mad-backup-*.db`, and faking one here would
  // pre-satisfy a check the controls exist to exercise.
  service.dbPath = null;

  const allMigrations = klass.MIGRATIONS;
  if (maxVersion !== null) {
    // Sanctioned by the SR review (E1): "old schema.sql + real runner with
    // MIGRATIONS filtered to version <= 68". TypeScript's `readonly` on the
    // static is compile-time only; restored in finally.
    (klass as { MIGRATIONS: Array<{ version: number }> }).MIGRATIONS = allMigrations.filter(
      (m) => m.version <= maxVersion,
    );
  }
  try {
    await service._runVersionedMigrations();
  } finally {
    (klass as { MIGRATIONS: Array<{ version: number }> }).MIGRATIONS = allMigrations;
    service.db = null;
  }

  const version = (
    db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
  ).version;
  return { db, version };
}

describe("schema-baseline generator (BACKLOG-2993)", () => {
  it("produces the requested artefacts as transcripts of real producers", async () => {
    const mode = process.env.KEEPR_BASELINE_MODE;
    const outDir = process.env.KEEPR_BASELINE_OUT_DIR;
    if (mode !== "freeze" && mode !== "fresh") {
      throw new Error("Set KEEPR_BASELINE_MODE to 'freeze' or 'fresh'");
    }
    if (!outDir) throw new Error("Set KEEPR_BASELINE_OUT_DIR to the fixtures directory");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-baseline-gen-"));
    const schemaSqlText = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");

    try {
      if (mode === "freeze") {
        // -------------------------------------------------------------------
        // The chain must still exist — this whole mode is the one-way window.
        // -------------------------------------------------------------------
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const service = require("../databaseService").default as AnyService;
        const versions = (
          service.constructor.MIGRATIONS as Array<{ version: number }>
        ).map((m) => m.version);
        if (versions.length === 0) {
          throw new Error(
            "MIGRATIONS is empty — the one-way window is closed. freeze mode can " +
              "only run on a tree where the migration chain still exists (0bd6703bb).",
          );
        }
        const head = Math.max(...versions);
        // Re-derived, not copied: the rule is "strictly greater than any version
        // any existing database can hold". Chain head is that maximum.
        expect(head).toBe(69); // sanity pin against the measured chain
        const newBaseline = head + 1;

        // (1) old schema.sql + FULL chain → v69 transcript.
        const a = await buildChainDb(path.join(tmpDir, "chain-full.db"), schemaSqlText, null);
        expect(a.version).toBe(head);
        const v69Header = provenanceHeader([
          `schema_version: ${a.version}`,
          "producer      : OLD electron/database/schema.sql + the FULL migration",
          "                chain (v30..v69) run through the real runner",
          "                (_runVersionedMigrations) on an empty database.",
          "role          : frozen side of the schema-parity control (C2) AND the",
          "                v69 boundary-sweep fixture. IRREPLACEABLE — the chain",
          "                this transcribes was deleted by BACKLOG-2993.",
        ]);
        fs.writeFileSync(path.join(outDir, "chain-v69-schema.sql"), dumpDatabase(a.db, v69Header));

        // (2) old schema.sql + chain clipped to <=68 → v68 transcript.
        const b = await buildChainDb(path.join(tmpDir, "chain-68.db"), schemaSqlText, 68);
        expect(b.version).toBe(68);
        const v68Header = provenanceHeader([
          `schema_version: ${b.version}`,
          "producer      : OLD electron/database/schema.sql + the real runner with",
          "                MIGRATIONS filtered to version <= 68 (SR review E1).",
          "role          : v68 boundary-sweep fixture (one below the last version",
          "                the chain could produce). IRREPLACEABLE — see above.",
        ]);
        fs.writeFileSync(path.join(outDir, "chain-v68-schema.sql"), dumpDatabase(b.db, v68Header));
        b.db.close();

        // (3) regenerated schema.sql: the v69 transcript, IF NOT EXISTS,
        //     seeded at the new baseline.
        const schemaHeader = [
          "-- ============================================",
          "-- MAD - LOCAL SQLite DATABASE SCHEMA",
          "-- ============================================",
          provenanceHeader([
            `declared schema_version: ${newBaseline}`,
            "producer      : OLD electron/database/schema.sql + the FULL migration",
            "                chain (v30..v69) run through the real runner, dumped",
            "                from sqlite_master and rewritten with IF NOT EXISTS.",
            "",
            "This file is the POST-RESET BASELINE (BACKLOG-2993): the complete",
            "v69-chain shape, declared as version 70. The migration chain that",
            "carried v30..v69 was deleted in the same change. Fresh installs get",
            "this file and nothing else; databases below version 70 are REFUSED",
            "by the baseline fence in databaseService (they predate the reset and",
            "no upgrade path exists any more).",
            "",
            "Hand-edits are caught by databaseService.schema-parity.test.ts,",
            "which diffs a fresh exec of this file against the frozen transcript",
            "fixtures/chain-v69-schema.sql.",
          ]),
        ].join("\n");
        const newSchemaSql = emitSchemaSql(a.db, schemaHeader, newBaseline);
        fs.writeFileSync(path.join(outDir, "schema.sql.new"), newSchemaSql);

        // (4) TWO-LIVE-SIDES COMPARISON — the required, reported step (SR
        //     review A): exec the just-emitted schema.sql on an empty database
        //     and fingerprint-diff it against the live old-schema+chain build.
        //     This is the only moment both producers exist; a wrong generator
        //     run caught here can never poison C2.
        const cFile = path.join(tmpDir, "fresh-on-new.db");
        const cDb = new RealDatabase(cFile) as DatabaseType;
        cDb.pragma("journal_mode = WAL");
        cDb.pragma("foreign_keys = ON");
        cDb.exec(newSchemaSql);
        const cVersion = (
          cDb.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version;
        expect(cVersion).toBe(newBaseline);

        // schema.sql is exec'd on EVERY open, so it must be idempotent: a
        // second exec on the same database must be a clean no-op. A single
        // statement missing its IF NOT EXISTS rewrite throws right here
        // ("table X already exists") — the first run of this generator was
        // caught by exactly this defect on `attachments`.
        cDb.exec(newSchemaSql);

        const divergences = diffFingerprints(
          extractFingerprint(cDb),
          extractFingerprint(a.db),
          "FRESH(regenerated schema.sql)",
          "LIVE(old schema.sql + full chain)",
        );
        if (divergences.length > 0) {
          throw new Error(
            "TWO-LIVE-SIDES COMPARISON FAILED — the regenerated schema.sql does " +
              "not reproduce the chain-built shape:\n" +
              divergences.map((d, i) => `  ${i + 1}. [${d.key}] ${d.detail}`).join("\n"),
          );
        }
        const fp = extractFingerprint(a.db);
        const report =
          `TWO-LIVE-SIDES COMPARISON: 0 divergences. ` +
          `tables=${Object.keys(fp.tables).length} indexes=${Object.keys(fp.indexes).length} ` +
          `triggers=${Object.keys(fp.triggers).length} views=${Object.keys(fp.views).length} ` +
          `fresh_version=${cVersion} chain_version=${a.version}`;
        // eslint-disable-next-line no-console
        console.log(report);
        // Jest's reporter in this repo swallows console output; the comparison
        // is a REQUIRED, REPORTED step (SR review A), so persist it too.
        if (process.env.KEEPR_BASELINE_REPORT) {
          fs.writeFileSync(process.env.KEEPR_BASELINE_REPORT, report + "\n");
        }
        cDb.close();
        a.db.close();
      } else {
        // -------------------------------------------------------------------
        // mode=fresh — run AFTER schema.sql is the regenerated file.
        // -------------------------------------------------------------------
        const dFile = path.join(tmpDir, "fresh-70.db");
        const dDb = new RealDatabase(dFile) as DatabaseType;
        dDb.pragma("journal_mode = WAL");
        dDb.pragma("foreign_keys = ON");
        dDb.exec(schemaSqlText);
        const dVersion = (
          dDb.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version;
        expect(dVersion).toBe(70);
        const v70Header = provenanceHeader([
          `schema_version: ${dVersion}`,
          "producer      : fresh install on the NEW (regenerated)",
          "                electron/database/schema.sql — a real producer.",
          "role          : v70 boundary-sweep fixture (the exact baseline; must",
          "                be ACCEPTED by the fence).",
        ]);
        fs.writeFileSync(path.join(outDir, "fresh-v70-schema.sql"), dumpDatabase(dDb, v70Header));

        // v71: the v70 build plus THE ONE PERMITTED SYNTHETIC EDIT.
        dDb.prepare("UPDATE schema_version SET version = 71 WHERE id = 1").run();
        const v71Header = provenanceHeader([
          "schema_version: 71",
          "producer      : the fresh-v70 build above, plus ONE documented",
          "                synthetic edit: UPDATE schema_version SET version=71.",
          "                (SR review E1: a v71 database has no real producer",
          "                today — 71 is a FUTURE build's number. This is the",
          "                only fixture in the sweep that is not a pure",
          "                transcript, and this header is the required record",
          "                of that fact.)",
          "role          : v71 boundary-sweep fixture (above the baseline; must",
          "                be ACCEPTED, with a warning, by the fence).",
        ]);
        fs.writeFileSync(path.join(outDir, "fresh-v71-schema.sql"), dumpDatabase(dDb, v71Header));
        dDb.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 300000);
});
