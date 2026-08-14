/**
 * @jest-environment node
 *
 * FIXTURE GENERATOR — builds the shipped v2.27.0 (schema_version 55) database
 * that `databaseService.migrationChainRehearsal.test.ts` upgrades.
 *
 * ===========================================================================
 * THIS FILE DOES NOT RUN IN CI, AND MUST NOT
 * ===========================================================================
 * Its name ends `.gen.ts`, not `.test.ts` / `.spec.ts`, so it matches neither
 * CI's `testMatch` (`**\/electron/**\/*.(test|spec).{js,jsx,ts,tsx}`) nor the
 * local one (which also requires `.test.`/`.spec.`). It is a generator, run by
 * hand against a worktree of the SHIPPED code; its output —
 * `fixtures/v2.27.0-populated.sql` — is what gets committed and what CI reads.
 *
 * ===========================================================================
 * WHY THE FIXTURE IS BUILT FROM THE SHIPPED CODE AND NOT FROM `develop`
 * ===========================================================================
 * The rehearsal must start from a database shaped like the one on the founder's
 * disk: built by the SHIPPED app, at schema_version 55. The only honest way to
 * get that shape is to run the shipped code.
 *
 * The tempting shortcut — exec `develop`'s `schema.sql` and clip `develop`'s
 * migration chain to <= 55 — produces a database that is NOT what shipped, in
 * two ways that were measured rather than assumed:
 *
 *   1. `develop`'s `schema.sql` DECLARES v62's `emails.bulk_mail_headers` in the
 *      CREATE TABLE body (schema.sql:432). The shipped `schema.sql` does not:
 *        git show origin/main:electron/database/schema.sql | grep -c bulk_mail_headers
 *        -> 0
 *      A "v55" fixture built from develop's schema.sql therefore ALREADY HAS the
 *      column migration v62 is supposed to add. That makes the BACKLOG-2298/2300
 *      defect shape — a standalone `CREATE INDEX` in schema.sql on a column the
 *      chain has not added yet — undetectable from such a fixture, because
 *      schema.sql is exec'd BEFORE the chain (databaseService.ts:776 -> 777) and
 *      the index therefore only throws when the table is genuinely old.
 *
 *   2. Migration BODIES for v33, v36 and v49 differ between the shipped code and
 *      `develop` (v33/v36 replaced a positional `INSERT ... SELECT *` with an
 *      explicit column list). develop's chain-clipped-to-55 is not the chain
 *      that built any shipped database.
 *
 * ===========================================================================
 * HOW TO REGENERATE — do this when a new version ships
 * ===========================================================================
 *   REPO=/path/to/Mad
 *   SHIPPED=origin/main              # or the release tag, e.g. v2.27.0
 *   git -C "$REPO" worktree add /tmp/Mad-shipped "$SHIPPED"
 *   ln -s "$REPO/node_modules" /tmp/Mad-shipped/node_modules
 *
 *   # BOTH files: the generator, renamed so jest collects it, and the corpus.
 *   cp electron/services/__tests__/buildV2270Fixture.gen.ts \
 *      /tmp/Mad-shipped/electron/services/__tests__/buildFixture.test.ts
 *   mkdir -p /tmp/Mad-shipped/electron/services/__tests__/fixtures
 *   cp electron/services/__tests__/fixtures/rehearsalCorpus.ts \
 *      /tmp/Mad-shipped/electron/services/__tests__/fixtures/
 *
 *   cd /tmp/Mad-shipped && KEEPR_FIXTURE_OUT=/tmp/fixture.sql \
 *     ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/buildFixture.test.ts --bail=0
 *
 *   cp /tmp/fixture.sql "$REPO"/electron/services/__tests__/fixtures/v2.27.0-populated.sql
 *   git -C "$REPO" worktree remove --force /tmp/Mad-shipped
 *
 * Then update EXPECTED_SHIPPED_VERSION in fixtures/rehearsalCorpus.ts and the
 * fixture filename, and re-run BOTH controls documented in the rehearsal.
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
// MOCKS — same block as databaseService.onDiskUpgrade.test.ts. Sentry.flush is
// included because runMigrations() awaits it on the failure path; without it a
// genuine migration failure surfaces as "Sentry.flush is not a function"
// instead of the real error.
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
import { SEED_STATEMENTS, EXPECTED_SHIPPED_VERSION } from "./fixtures/rehearsalCorpus";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock — the point of this file is a real file-backed database.
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
 * Dump a database to replayable SQL text.
 *
 * Tables first, then every row, then indexes / triggers / views — so a
 * standalone `CREATE INDEX` in the dump can never precede the table it indexes.
 * `sqlite_autoindex_*` entries carry a NULL `sql` and are skipped; internal
 * `sqlite_*` objects are not ours to recreate.
 *
 * ORDER BY name, NOT rootpage. rootpage is a physical storage detail and is not
 * stable between two runs that produce logically identical databases; ordering
 * by it made regeneration emit a large spurious diff, which is how a real change
 * gets lost in the noise. Row order within a table is pinned by rowid for the
 * same reason. (`PRAGMA foreign_keys=OFF` heads the dump, so table creation
 * order is free.)
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

describe("fixture generator — shipped populated database", () => {
  it("builds the shipped schema_version through the shipped init path and writes the dump", async () => {
    const outPath = process.env.KEEPR_FIXTURE_OUT;
    if (!outPath) throw new Error("Set KEEPR_FIXTURE_OUT to the destination .sql path");

    const shippedSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const shippedVersion = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"),
    ).version as string;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-fixture-gen-"));
    const dbFile = path.join(tmpDir, "mad.db");

    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");

    // (1) THE SHIPPED fresh-install artefact.
    db.exec(fs.readFileSync(SCHEMA_SQL_PATH, "utf8"));

    // (2) THE SHIPPED migration chain, through the SHIPPED runner, unclipped.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const service = require("../databaseService").default as AnyService;
    service.db = db;
    setDb(db);
    setEncryptionKey("test-encryption-key-hex");
    // dbPath stays null for the BUILD: _runVersionedMigrations() refuses to
    // migrate an on-disk DB that has no pre-existing `mad-backup-*.db`, and
    // faking one here would pre-satisfy a check the REHEARSAL exists to exercise.
    service.dbPath = null;
    await service._runVersionedMigrations();

    const version = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(version).toBe(EXPECTED_SHIPPED_VERSION);

    // (3) The corpus.
    for (const stmt of SEED_STATEMENTS) db.prepare(stmt).run();

    db.pragma("wal_checkpoint(TRUNCATE)");

    const header = [
      "-- ===================================================================",
      "-- SHIPPED DATABASE TRANSCRIPT — GENERATED, DO NOT HAND-EDIT",
      "-- ===================================================================",
      "-- Produced by electron/services/__tests__/buildV2270Fixture.gen.ts run",
      "-- against a worktree of the SHIPPED code. Regeneration steps are in that",
      "-- file's header.",
      "--",
      `-- source commit : ${shippedSha}`,
      `-- app version   : ${shippedVersion}`,
      `-- schema_version: ${version}`,
      `-- generated     : ${new Date().toISOString().slice(0, 10)}`,
      "--",
      "-- The SCHEMA below is the output of the shipped `schema.sql` followed by",
      "-- the shipped migration chain run through the shipped runner — a",
      "-- TRANSCRIPT of a real producer, not a hand-written schema. The ROWS are",
      "-- a deliberate seeded corpus (fixtures/rehearsalCorpus.ts) and are the",
      "-- only hand-authored part of this file.",
      "-- ===================================================================",
      "",
    ].join("\n");

    fs.writeFileSync(outPath, dumpDatabase(db, header), "utf8");
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    expect(fs.statSync(outPath).size).toBeGreaterThan(1000);
  }, 120000);
});
