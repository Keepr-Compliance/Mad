/**
 * @jest-environment node
 *
 * Schema-parity control — BACKLOG-2993 (supersedes the BACKLOG-1770 fresh-vs-
 * migrated parity test, whose "migrated" side was deleted with the chain).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * BACKLOG-2993 deleted the local migration chain (v30..v69) and regenerated
 * `electron/database/schema.sql` as a transcript of the chain's final shape,
 * declared as baseline version 70. From that moment there are again two things
 * that must stay in lock-step:
 *
 *   1. `electron/database/schema.sql` — what every install actually gets, and
 *      a GENERATED file whose header says DO NOT HAND-EDIT;
 *   2. `fixtures/chain-v69-schema.sql` — the FROZEN transcript of what the old
 *      schema.sql + the full real chain produced at 0bd6703bb, captured in the
 *      one-way window before the chain was deleted. It can never be produced
 *      again from this repo.
 *
 * This control fingerprint-diffs a fresh exec of (1) against a replay of (2)
 * through the SAME extraction code (helpers/schemaFingerprint.ts — also used
 * by the generator's two-live-sides comparison, which proved the frozen side
 * faithful at capture time: 0 divergences, tables=36 indexes=157 triggers=10
 * views=2).
 *
 * Any hand-edit to the generated schema.sql turns this red. DELIBERATE schema
 * evolution (the post-reset way: edit schema.sql directly — e.g. BACKLOG-2551,
 * BACKLOG-2807) is recorded in ALLOWED_EVOLUTION below, one reviewed entry per
 * divergence key, so the guard keeps catching the ACCIDENTAL kind.
 *
 * Uses the real better-sqlite3-multiple-ciphers driver (not the jest
 * auto-mock): PRAGMA-level fingerprints need a real SQLite engine.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

import {
  extractFingerprint,
  diffFingerprints,
  type Divergence,
} from "./helpers/schemaFingerprint";

// Bypass the Jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock. Depth is 3: __tests__ → services → electron → repo root.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");
const FROZEN_TRANSCRIPT_PATH = path.join(__dirname, "fixtures", "chain-v69-schema.sql");

const FRESH = "FRESH(schema.sql)";
const FROZEN = "FROZEN(chain-v69 transcript)";

// ---------------------------------------------------------------------------
// ALLOWED_EVOLUTION
// ---------------------------------------------------------------------------
// The post-reset way to change the local schema is to edit schema.sql directly
// AND record the divergence here, one entry per key, with the backlog item
// that reviewed it. An empty list means schema.sql is still byte-faithful to
// the frozen v69 shape. A divergence WITHOUT an entry is a hard failure: it is
// either an unreviewed schema change or a hand-edit to a generated file.
interface AllowedEvolution {
  /** Canonical divergence key from diffFingerprints (e.g. "COLUMN:emails.x"). */
  key: string;
  what: string;
  why: string;
  ref: string;
}

const ALLOWED_EVOLUTION: AllowedEvolution[] = [
  {
    key: "COLUMN:attachments.provider_attachment_id",
    what: "New nullable TEXT column on `attachments`.",
    why:
      "BACKLOG-2551: the provider's own attachment id, so a re-sync can identify " +
      "THIS attachment rather than guessing by filename. Two attachments in one " +
      "email may legitimately share a filename (image001.png across Outlook " +
      "signature chains), so filename cannot be an identity key. Migration v71 " +
      "adds the same column to existing databases and creates the partial unique " +
      "index; the index is deliberately NOT in schema.sql (a standalone CREATE " +
      "INDEX naming this column aborts schema.sql's unconditional exec on every " +
      "pre-v71 database). NOTE: the 2839 CHECK on message_thread_names.display_name " +
      "produces NO divergence key -- schemaFingerprint reads tables via PRAGMA " +
      "table_info, which cannot see CHECK. A green run here is not evidence for it.",
    ref: "BACKLOG-2551",
  },
  {
    key: "TABLE:transaction_hidden_texts",
    what: "New table recording texts hidden from one transaction's export.",
    why:
      "BACKLOG-3366: a user can hide an individual text from a transaction's " +
      "export without removing it from the transaction. A new table is fully " +
      "IF NOT EXISTS, so schema.sql's exec on every open creates it on fresh and " +
      "upgraded databases alike; no migration entry is needed.",
    ref: "BACKLOG-3366",
  },
  {
    key: "INDEX:idx_hidden_texts_txn_external",
    what: "Partial index on (transaction_id, message_external_id).",
    why:
      "BACKLOG-3366: the shared conversation read matches a hidden row by the " +
      "message's provider id as well as its row id, so a hide survives a macOS " +
      "force re-import that re-inserts messages under new ids.",
    ref: "BACKLOG-3366",
  },
  {
    key: "INDEX:sqlite_autoindex_transaction_hidden_texts_1",
    what: "SQLite's automatic index for the (transaction_id, message_id) primary key.",
    why:
      "BACKLOG-3366: produced by the composite PRIMARY KEY on the new table; it " +
      "is not declared separately and cannot be omitted.",
    ref: "BACKLOG-3366",
  },
];

const ALLOWED_KEYS = new Set(ALLOWED_EVOLUTION.map((d) => d.key));

// ---------------------------------------------------------------------------

describe("schema baseline parity — schema.sql vs frozen chain-v69 transcript (BACKLOG-2993)", () => {
  const createdTmpDirs: string[] = [];
  const openDbs: DatabaseType[] = [];

  function newDb(name: string): DatabaseType {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-parity-2993-"));
    createdTmpDirs.push(tmpDir);
    const db = new RealDatabase(path.join(tmpDir, name)) as DatabaseType;
    openDbs.push(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  }

  function schemaVersion(db: DatabaseType): number {
    return (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
  }

  function buildFresh(): DatabaseType {
    const db = newDb("fresh.db");
    db.exec(fs.readFileSync(SCHEMA_SQL_PATH, "utf8"));
    return db;
  }

  function replayFrozen(): DatabaseType {
    const db = newDb("frozen.db");
    db.exec(fs.readFileSync(FROZEN_TRANSCRIPT_PATH, "utf8"));
    // The transcript dump opens with PRAGMA foreign_keys=OFF so it can create
    // in any order; re-enable to match the fresh side's handle state.
    db.pragma("foreign_keys = ON");
    return db;
  }

  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    for (const d of createdTmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
    const db = newDb("sanity.db");
    expect(Array.isArray(db.pragma("user_version"))).toBe(true);
  });

  it("PRECONDITION: the frozen transcript replays at version 69 with the chain-only tables present", () => {
    const db = replayFrozen();
    expect(schemaVersion(db)).toBe(69);
    // The four tables only the deleted chain ever created — their presence in
    // the REPLAYED transcript is what makes this fixture a faithful stand-in
    // for the chain. Asserted as DDL (sqlite_master rows), never by grepping
    // the file text: `contact_source_links` also appears in prose comments.
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    for (const t of [
      "contact_source_links",
      "transaction_unlocks_cache",
      "contact_link_proposals",
      "contact_link_verdicts",
    ]) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("fresh exec of schema.sql lands at version 70 — and is idempotent on re-exec", () => {
    const db = buildFresh();
    expect(schemaVersion(db)).toBe(70);

    // schema.sql runs on EVERY open, so a second exec must be a clean no-op —
    // one statement missing IF NOT EXISTS throws "already exists" right here
    // (the generator's first run was caught by exactly this, on a DDL body
    // whose COMMENT contained the words "IF NOT EXISTS").
    const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
    db.exec(schemaSql);
    expect(schemaVersion(db)).toBe(70);
  });

  it("ALLOWED_EVOLUTION has no stale entries (every pinned key still diverges)", () => {
    const fresh = extractFingerprint(buildFresh());
    const frozen = extractFingerprint(replayFrozen());
    const divergentKeys = new Set(
      diffFingerprints(fresh, frozen, FRESH, FROZEN).map((d) => d.key),
    );

    const stale = ALLOWED_EVOLUTION.filter((k) => !divergentKeys.has(k.key));
    if (stale.length > 0) {
      throw new Error(
        "Stale ALLOWED_EVOLUTION entries — these divergences no longer occur " +
          "and should be REMOVED:\n" +
          stale.map((k) => `  - ${k.key} (${k.ref})`).join("\n"),
      );
    }
    expect(stale).toEqual([]);
  });

  it("schema.sql is structurally identical to the frozen chain-v69 transcript (modulo ALLOWED_EVOLUTION)", () => {
    const fresh = extractFingerprint(buildFresh());
    const frozen = extractFingerprint(replayFrozen());

    const divergences: Divergence[] = diffFingerprints(fresh, frozen, FRESH, FROZEN);
    const unexpected = divergences.filter((d) => !ALLOWED_KEYS.has(d.key));

    if (unexpected.length > 0) {
      const lines = [
        "",
        "==============================================================",
        "SCHEMA DRIFT DETECTED — electron/database/schema.sql no longer",
        "matches the frozen chain-v69 transcript it was generated from.",
        "Either:",
        "  (a) this is a DELIBERATE, reviewed schema evolution — add an",
        "      ALLOWED_EVOLUTION entry naming its backlog item, OR",
        "  (b) a generated file was hand-edited — revert the edit.",
        "The frozen side (fixtures/chain-v69-schema.sql) can never be",
        "regenerated: it is the transcript of a migration chain that no",
        "longer exists. Do not 'fix' this test by touching the fixture.",
        "==============================================================",
        `Unexpected divergences: ${unexpected.length}` +
          (divergences.length !== unexpected.length
            ? ` (+${divergences.length - unexpected.length} in ALLOWED_EVOLUTION)`
            : ""),
        "",
        ...unexpected.map((d, i) => `  ${i + 1}. [${d.key}] ${d.detail}`),
        "",
      ];
      throw new Error(lines.join("\n"));
    }

    expect(unexpected).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // BACKLOG-2551 — CONTROL 4: the COMPOSITE control, and it lives here on purpose.
  //
  // From v71 onward `schema.sql` alone no longer describes the shipped schema:
  // `schema.sql + MIGRATIONS` does. The unique index is created by the migration
  // and deliberately not by schema.sql (a standalone CREATE INDEX naming a column
  // only a migration adds aborts schema.sql's unconditional exec on every existing
  // database). Nothing else checks that the two delivery paths converge.
  //
  // It belongs in the PARITY suite rather than in the v71 suite because as a
  // one-off it would decay the moment the next migration lands; here it keeps
  // asserting the invariant for every migration that ever ships.
  // -------------------------------------------------------------------------
  describe("fresh install and upgraded database converge (BACKLOG-2551 control 4)", () => {
    /**
     * The REAL upgrade sequence, in the real order: runMigrations() execs
     * schema.sql unconditionally and THEN runs the versioned migrations
     * (databaseService.ts, `currentDb.exec(schemaSql); await
     * this._runVersionedMigrations();`).
     *
     * Execing schema.sql here is what makes this control able to catch the
     * hazard it exists for. schema.sql is fully IF NOT EXISTS, so on an existing
     * database it adds nothing -- which is exactly why a standalone CREATE INDEX
     * naming a migration-added column throws `no such column` and aborts the
     * whole file. Without this line the upgraded side never reads schema.sql and
     * the control would stay green through precisely that mistake.
     */
    function execSchemaSqlAsRunMigrationsDoes(db: DatabaseType): void {
      db.exec(fs.readFileSync(SCHEMA_SQL_PATH, "utf8"));
    }

    /** Every migration above the on-disk version, run the way the runner runs them. */
    function applyMigrations(db: DatabaseType, fromVersion: number): void {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const svc = require("../databaseService").default;
      const chain = (
        svc.constructor as {
          MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }>;
        }
      ).MIGRATIONS;
      db.pragma("foreign_keys = OFF");
      try {
        for (const m of chain.filter((x) => x.version > fromVersion)) {
          db.transaction(() => m.migrate(db))();
        }
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }

    it("PRECONDITION: there is at least one migration to apply, so this cannot pass vacuously", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const svc = require("../databaseService").default;
      const chain = (svc.constructor as { MIGRATIONS: unknown[] }).MIGRATIONS;
      expect(chain.length).toBeGreaterThan(0);
    });

    it("a FRESH install and an UPGRADED v70 database end structurally identical", () => {
      const fresh = buildFresh();
      applyMigrations(fresh, 70); // fresh seeds schema_version at BASELINE, then migrates

      const upgraded = replayFrozen();
      execSchemaSqlAsRunMigrationsDoes(upgraded); // the real order: schema.sql first
      applyMigrations(upgraded, 70);

      const divergences = diffFingerprints(
        extractFingerprint(fresh),
        extractFingerprint(upgraded),
        "FRESH(schema.sql + migrations)",
        "UPGRADED(v70 + migrations)",
      );
      expect(divergences.map((d: Divergence) => `[${d.key}] ${d.detail}`)).toEqual([]);
    });

    it("both paths carry the migration-only objects that schema.sql cannot deliver", () => {
      for (const [label, build] of [
        ["fresh", buildFresh],
        ["upgraded", replayFrozen],
      ] as const) {
        const db = build();
        if (label === "upgraded") execSchemaSqlAsRunMigrationsDoes(db);
        applyMigrations(db, 70);

        // The partial unique index exists ONLY because the migration made it.
        const idx = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_attachments_email_provider'",
          )
          .get() as { name: string } | undefined;
        expect(`${label}:${idx?.name}`).toBe(`${label}:idx_attachments_email_provider`);

        // And the CHECK, which the fingerprint above is structurally blind to:
        // PRAGMA table_info does not expose CHECK, so it must be read from
        // sqlite_master or it is not checked at all.
        const ddl = (
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='table' AND name='message_thread_names'",
            )
            .get() as { sql: string }
        ).sql;
        expect(`${label}:${/CHECK\s*\(\s*length\s*\(\s*trim\(display_name/.test(ddl)}`).toBe(
          `${label}:true`,
        );
      }
    });
  });
});