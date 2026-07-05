/**
 * @jest-environment node
 *
 * Schema-parity CI test — BACKLOG-1770 (DB Hardening epic BACKLOG-1767, S3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Keepr ships schema in TWO ways that must stay in lock-step:
 *
 *   1. FRESH install  — `electron/database/schema.sql` is exec()'d, then the
 *      versioned migration runner (`_runVersionedMigrations`) fills the gap
 *      between schema.sql's declared version and the latest migration.
 *   2. UPGRADED install — an old DB at the oldest supported shape runs the
 *      FULL migration chain from BASELINE_VERSION up to the latest migration.
 *
 * If schema.sql drifts from the migration chain (e.g. a migration's effect is
 * hand-folded into schema.sql but the fold is incomplete, or the version tag
 * is bumped without folding every side effect) then the two install paths
 * produce DIFFERENT live schemas. The DB-hardening review found this class of
 * bug has shipped at least twice. This test makes every NEW divergence a hard
 * CI failure, and pins the already-shipped divergences in KNOWN_DRIFT below.
 *
 * ---------------------------------------------------------------------------
 * HOW THE TWO PATHS ARE BUILT (read the code, don't guess — mirrors
 * databaseService.runMigrations lines 549-550 + 639-640)
 * ---------------------------------------------------------------------------
 * The migration chain is NOT self-contained: migrations v30/v32 mutate tables
 * (`transactions`, `messages`, `attachments`, ...) that ONLY schema.sql
 * creates — there is no migration that builds the v29 baseline from empty.
 * So BOTH paths must start from schema.sql; they differ only in the version
 * the runner believes it is starting from:
 *
 *   Path A — FRESH:    exec(schema.sql)  → schema_version = 32 (schema.sql's
 *                      own INSERT) → runner applies migrations 33..N.
 *   Path B — MIGRATED: exec(schema.sql)  → force schema_version =
 *                      BASELINE_VERSION (29, the oldest the runner supports)
 *                      → runner replays the full chain 30..N.
 *
 * The delta between the two paths is exactly the set of migrations that were
 * "consolidated" into schema.sql (30..32): if schema.sql's hand-maintained
 * shape disagrees with those migrations' authored effect, the divergence
 * surfaces here.
 *
 * KNOWN LIMITATION (documented for the coordinator / SR): because both paths
 * seed from schema.sql, a guarded ALTER whose column already exists in
 * schema.sql is a no-op in BOTH paths, so a *type/default* mismatch between
 * schema.sql and a guarded migration above BASELINE cannot be caught without a
 * true historical baseline snapshot. This test catches the highest-value drift
 * — structures present in one install population but not the other, and
 * unconditional DROP/CREATE (view/trigger/table-rebuild) body mismatches.
 *
 * ---------------------------------------------------------------------------
 * COMPARISON METHOD (structural, not raw-CREATE-text — the latter is brittle
 * against whitespace / quoting / IF NOT EXISTS / column re-ordering)
 * ---------------------------------------------------------------------------
 *   tables   : set membership + per-column PRAGMA table_info
 *              (name, type, notnull, dflt_value, pk) + PRAGMA foreign_key_list
 *   indexes  : PRAGMA index_list (unique, origin) + PRAGMA index_info (columns)
 *   triggers : sqlite_master name + whitespace-normalized body
 *   views    : sqlite_master name + whitespace-normalized body
 *
 * Uses the real better-sqlite3-multiple-ciphers driver via the shared
 * migration harness (see migrationTestHarness.ts) — NOT the jest auto-mock.
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// MOCKS — identical shape to databaseService.migration-v41.test.ts so the
// databaseService singleton imports cleanly under a `node` jest environment.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
  },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: mockFns,
    logService: mockFns,
  };
});

jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));

jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------

import {
  createMigrationHarness,
  type MigrationHarness,
} from "./helpers/migrationTestHarness";

// Sanity check that we are using the real driver (bypasses jest auto-mock).
// Depth is 3: __tests__/x.test.ts → services/__tests__ → services → electron →
// repo root → node_modules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDatabase = require(
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "node_modules",
    "better-sqlite3-multiple-ciphers",
  ),
);

// The exact same file the app reads on a fresh install
// (databaseService.ts: path.join(__dirname, "../database/schema.sql")).
const SCHEMA_SQL_PATH = path.join(
  __dirname,
  "..",
  "..",
  "database",
  "schema.sql",
);

// ---------------------------------------------------------------------------
// KNOWN_DRIFT ALLOWLIST
// ---------------------------------------------------------------------------
// Each entry pins an ALREADY-SHIPPED divergence between the fresh and migrated
// install schemas. Pinning keeps CI green while making every *new* divergence
// a hard failure. Every entry MUST carry: what diverges, why it is currently
// accepted, and a backlog ref so the coordinator can schedule the real fix
// (fold the missing structure into schema.sql and bump its version tag).
//
// `key` must match the canonical divergence key emitted by diffFingerprints()
// (see keyFor* helpers). `side` is informational.
//
// Root cause (now RESOLVED — BACKLOG-1774 / S6): schema.sql declared `version 32`
// and folded in TASK-2110's sync_session_id COLUMNS, but the fold had omitted
// (a) migration v31's `failure_log` table + its two indexes, and (b) migration
// v32's three sync_session indexes. Fresh installs (which start at v32 and skip
// migrations 30-32) therefore never received those six objects, whereas any
// install that upgraded through v31/v32 had them. S6 folded all six into
// electron/database/schema.sql, so the allowlist is now EMPTY and every
// fresh-vs-migrated divergence is once again a hard CI failure. If a new
// already-shipped divergence ever appears, add an entry here with: what
// diverges, why it is (temporarily) accepted, and a backlog ref.
interface KnownDrift {
  key: string;
  what: string;
  why: string;
  ref: string;
}

const KNOWN_DRIFT: KnownDrift[] = [];

const KNOWN_DRIFT_KEYS = new Set(KNOWN_DRIFT.map((d) => d.key));

// ---------------------------------------------------------------------------
// SCHEMA FINGERPRINT (structural extraction)
// ---------------------------------------------------------------------------

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

interface TableInfo {
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

interface IndexInfo {
  table: string;
  unique: number;
  origin: string;
  partial: number;
  columns: string[];
}

interface SchemaFingerprint {
  tables: Record<string, TableInfo>;
  indexes: Record<string, IndexInfo>;
  triggers: Record<string, string>;
  views: Record<string, string>;
}

/** Collapse all whitespace runs to a single space, drop IF NOT EXISTS, trim. */
function normalizeSql(sql: string | null): string {
  if (!sql) return "";
  return sql
    .replace(/if\s+not\s+exists/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFingerprint(db: any): SchemaFingerprint {
  const tableNames = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const tables: Record<string, TableInfo> = {};
  const indexes: Record<string, IndexInfo> = {};

  for (const t of tableNames) {
    const columns = (
      db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>
    ).map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
      pk: c.pk,
    }));

    const foreignKeys = (
      db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as Array<{
        table: string;
        from: string;
        to: string | null;
        on_update: string;
        on_delete: string;
        match: string;
      }>
    )
      .map((f) => ({
        table: f.table,
        from: f.from,
        to: f.to,
        on_update: f.on_update,
        on_delete: f.on_delete,
        match: f.match,
      }))
      // Deterministic order — PRAGMA order is not guaranteed stable.
      .sort((a, b) =>
        `${a.table}.${a.from}.${a.to}`.localeCompare(`${b.table}.${b.from}.${b.to}`),
      );

    tables[t] = { columns, foreignKeys };

    const idxList = db.prepare(`PRAGMA index_list("${t}")`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    for (const idx of idxList) {
      const cols = (
        db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{
          name: string | null;
        }>
      ).map((i) => i.name ?? "<expr>");
      indexes[idx.name] = {
        table: t,
        unique: idx.unique,
        origin: idx.origin,
        partial: idx.partial,
        columns: cols,
      };
    }
  }

  const triggers: Record<string, string> = {};
  (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .all() as Array<{ name: string; sql: string | null }>
  ).forEach((r) => {
    triggers[r.name] = normalizeSql(r.sql);
  });

  const views: Record<string, string> = {};
  (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='view'")
      .all() as Array<{ name: string; sql: string | null }>
  ).forEach((r) => {
    views[r.name] = normalizeSql(r.sql);
  });

  return { tables, indexes, triggers, views };
}

// ---------------------------------------------------------------------------
// DIFF
// ---------------------------------------------------------------------------

interface Divergence {
  key: string;
  detail: string;
}

const FRESH = "FRESH(schema.sql+migrations)";
const MIGRATED = "MIGRATED(baseline+full-chain)";

function diffFingerprints(
  fresh: SchemaFingerprint,
  migrated: SchemaFingerprint,
): Divergence[] {
  const out: Divergence[] = [];

  // ---- Tables ----
  const allTables = new Set([
    ...Object.keys(fresh.tables),
    ...Object.keys(migrated.tables),
  ]);
  for (const t of [...allTables].sort()) {
    const a = fresh.tables[t];
    const b = migrated.tables[t];
    if (a && !b) {
      out.push({
        key: `TABLE:${t}`,
        detail: `table "${t}" present in ${FRESH} but MISSING in ${MIGRATED}`,
      });
      continue;
    }
    if (!a && b) {
      out.push({
        key: `TABLE:${t}`,
        detail: `table "${t}" present in ${MIGRATED} but MISSING in ${FRESH}`,
      });
      continue;
    }
    if (!a || !b) continue;

    // Columns (keyed by name so ordering never causes false positives)
    const aCols = new Map(a.columns.map((c) => [c.name, c]));
    const bCols = new Map(b.columns.map((c) => [c.name, c]));
    for (const name of new Set([...aCols.keys(), ...bCols.keys()])) {
      const ca = aCols.get(name);
      const cb = bCols.get(name);
      if (ca && !cb) {
        out.push({
          key: `COLUMN:${t}.${name}`,
          detail: `column "${t}.${name}" present in ${FRESH} but MISSING in ${MIGRATED}`,
        });
        continue;
      }
      if (!ca && cb) {
        out.push({
          key: `COLUMN:${t}.${name}`,
          detail: `column "${t}.${name}" present in ${MIGRATED} but MISSING in ${FRESH}`,
        });
        continue;
      }
      if (!ca || !cb) continue;
      const attrs: Array<keyof ColumnInfo> = [
        "type",
        "notnull",
        "dflt_value",
        "pk",
      ];
      for (const attr of attrs) {
        if (String(ca[attr]) !== String(cb[attr])) {
          out.push({
            key: `COLUMN:${t}.${name}#${attr}`,
            detail: `column "${t}.${name}" ${attr} differs: ${FRESH}=${JSON.stringify(
              ca[attr],
            )} ${MIGRATED}=${JSON.stringify(cb[attr])}`,
          });
        }
      }
    }

    // Foreign keys (compared as normalized sorted tuples)
    const fkStr = (fks: ForeignKeyInfo[]) =>
      fks
        .map(
          (f) =>
            `${f.from}->${f.table}.${f.to} onUpd=${f.on_update} onDel=${f.on_delete} match=${f.match}`,
        )
        .join(" | ");
    const aFk = fkStr(a.foreignKeys);
    const bFk = fkStr(b.foreignKeys);
    if (aFk !== bFk) {
      out.push({
        key: `FK:${t}`,
        detail: `foreign keys for "${t}" differ:\n      ${FRESH}:   [${aFk}]\n      ${MIGRATED}: [${bFk}]`,
      });
    }
  }

  // ---- Indexes ----
  const allIdx = new Set([
    ...Object.keys(fresh.indexes),
    ...Object.keys(migrated.indexes),
  ]);
  for (const name of [...allIdx].sort()) {
    const a = fresh.indexes[name];
    const b = migrated.indexes[name];
    if (a && !b) {
      out.push({
        key: `INDEX:${name}`,
        detail: `index "${name}" (on ${a.table}) present in ${FRESH} but MISSING in ${MIGRATED}`,
      });
      continue;
    }
    if (!a && b) {
      out.push({
        key: `INDEX:${name}`,
        detail: `index "${name}" (on ${b.table}) present in ${MIGRATED} but MISSING in ${FRESH}`,
      });
      continue;
    }
    if (!a || !b) continue;
    const aSig = `${a.table} unique=${a.unique} origin=${a.origin} partial=${a.partial} cols=[${a.columns.join(",")}]`;
    const bSig = `${b.table} unique=${b.unique} origin=${b.origin} partial=${b.partial} cols=[${b.columns.join(",")}]`;
    if (aSig !== bSig) {
      out.push({
        key: `INDEX:${name}#shape`,
        detail: `index "${name}" shape differs:\n      ${FRESH}:   ${aSig}\n      ${MIGRATED}: ${bSig}`,
      });
    }
  }

  // ---- Triggers ----
  const allTrig = new Set([
    ...Object.keys(fresh.triggers),
    ...Object.keys(migrated.triggers),
  ]);
  for (const name of [...allTrig].sort()) {
    const a = fresh.triggers[name];
    const b = migrated.triggers[name];
    if (a === undefined && b !== undefined) {
      out.push({
        key: `TRIGGER:${name}`,
        detail: `trigger "${name}" present in ${MIGRATED} but MISSING in ${FRESH}`,
      });
      continue;
    }
    if (a !== undefined && b === undefined) {
      out.push({
        key: `TRIGGER:${name}`,
        detail: `trigger "${name}" present in ${FRESH} but MISSING in ${MIGRATED}`,
      });
      continue;
    }
    if (a !== b) {
      out.push({
        key: `TRIGGER:${name}#body`,
        detail: `trigger "${name}" body differs:\n      ${FRESH}:   ${a}\n      ${MIGRATED}: ${b}`,
      });
    }
  }

  // ---- Views ----
  const allView = new Set([
    ...Object.keys(fresh.views),
    ...Object.keys(migrated.views),
  ]);
  for (const name of [...allView].sort()) {
    const a = fresh.views[name];
    const b = migrated.views[name];
    if (a === undefined && b !== undefined) {
      out.push({
        key: `VIEW:${name}`,
        detail: `view "${name}" present in ${MIGRATED} but MISSING in ${FRESH}`,
      });
      continue;
    }
    if (a !== undefined && b === undefined) {
      out.push({
        key: `VIEW:${name}`,
        detail: `view "${name}" present in ${FRESH} but MISSING in ${MIGRATED}`,
      });
      continue;
    }
    if (a !== b) {
      out.push({
        key: `VIEW:${name}#body`,
        detail: `view "${name}" body differs:\n      ${FRESH}:   ${a}\n      ${MIGRATED}: ${b}`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// PATH BUILDERS
// ---------------------------------------------------------------------------

function readSchemaSql(): string {
  return fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
}

/**
 * Path A — FRESH install. Mirrors databaseService.runMigrations():
 * exec(schema.sql), then _runVersionedMigrations() (which reads the version
 * schema.sql declares — currently 32 — and applies migrations above it).
 */
async function buildFreshFingerprint(): Promise<SchemaFingerprint> {
  const harness = createMigrationHarness({ seedV29Schema: false });
  try {
    harness.db.exec(readSchemaSql());
    await harness.service._runVersionedMigrations();
    return extractFingerprint(harness.db);
  } finally {
    await harness.cleanup();
  }
}

/**
 * Path B — UPGRADED install. exec(schema.sql), then drive schema_version down
 * to BASELINE_VERSION (the oldest shape the runner supports) so the runner
 * replays the FULL migration chain from the baseline.
 */
async function buildMigratedFingerprint(): Promise<SchemaFingerprint> {
  const harness = createMigrationHarness({ seedV29Schema: false });
  try {
    harness.db.exec(readSchemaSql());
    const baseline = harness.service.constructor.BASELINE_VERSION as number;
    harness.db
      .prepare("UPDATE schema_version SET version = ? WHERE id = 1")
      .run(baseline);
    await harness.service._runVersionedMigrations();
    return extractFingerprint(harness.db);
  } finally {
    await harness.cleanup();
  }
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService schema parity — fresh vs migrated (BACKLOG-1770)", () => {
  let harness: MigrationHarness;

  afterEach(async () => {
    // Defensive: if a builder threw mid-flight the singleton could still hold
    // a live DB. buildFresh/Migrated already clean up in finally, so this is a
    // no-op in the happy path.
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof realDatabase).toBe("function");
    harness = createMigrationHarness({ seedV29Schema: false });
    expect(Array.isArray(harness.db.pragma("user_version"))).toBe(true);
  });

  it("both install paths reach the latest migration version", async () => {
    const migrations = (
      require("../databaseService").default.constructor.MIGRATIONS as Array<{
        version: number;
      }>
    );
    const latest = migrations[migrations.length - 1].version;

    for (const build of [buildFreshFingerprint, buildMigratedFingerprint]) {
      const h = createMigrationHarness({ seedV29Schema: false });
      try {
        h.db.exec(readSchemaSql());
        if (build === buildMigratedFingerprint) {
          h.db
            .prepare("UPDATE schema_version SET version = ? WHERE id = 1")
            .run(h.service.constructor.BASELINE_VERSION);
        }
        await h.service._runVersionedMigrations();
        const v = (
          h.db
            .prepare("SELECT version FROM schema_version WHERE id = 1")
            .get() as { version: number }
        ).version;
        expect(v).toBe(latest);
      } finally {
        await h.cleanup();
      }
    }
  });

  it("KNOWN_DRIFT allowlist has no stale entries (every pinned key still diverges)", async () => {
    const fresh = await buildFreshFingerprint();
    const migrated = await buildMigratedFingerprint();
    const divergentKeys = new Set(
      diffFingerprints(fresh, migrated).map((d) => d.key),
    );

    const stale = KNOWN_DRIFT.filter((k) => !divergentKeys.has(k.key));
    if (stale.length > 0) {
      throw new Error(
        "Stale KNOWN_DRIFT entries — these divergences no longer occur and " +
          "should be REMOVED from the allowlist (the drift was fixed):\n" +
          stale.map((k) => `  - ${k.key} (${k.ref})`).join("\n"),
      );
    }
    expect(stale).toEqual([]);
  });

  it("fresh-install schema is structurally identical to migrated-install schema (modulo KNOWN_DRIFT)", async () => {
    const fresh = await buildFreshFingerprint();
    const migrated = await buildMigratedFingerprint();

    const divergences = diffFingerprints(fresh, migrated);
    const unexpected = divergences.filter((d) => !KNOWN_DRIFT_KEYS.has(d.key));

    if (unexpected.length > 0) {
      const lines = [
        "",
        "==============================================================",
        "SCHEMA DRIFT DETECTED — fresh install and migrated install",
        "produce DIFFERENT schemas. Either:",
        "  (a) fold the missing structure into electron/database/schema.sql",
        "      and bump its version tag, OR",
        "  (b) if this is a knowingly-accepted, already-shipped divergence,",
        "      add it to KNOWN_DRIFT with a backlog ref.",
        "==============================================================",
        `Unexpected divergences: ${unexpected.length}` +
          (divergences.length !== unexpected.length
            ? ` (+${divergences.length - unexpected.length} already in KNOWN_DRIFT)`
            : ""),
        "",
        ...unexpected.map((d, i) => `  ${i + 1}. [${d.key}] ${d.detail}`),
        "",
      ];
      throw new Error(lines.join("\n"));
    }

    expect(unexpected).toEqual([]);
  });
});
