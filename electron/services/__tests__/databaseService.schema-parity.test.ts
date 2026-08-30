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

const ALLOWED_EVOLUTION: AllowedEvolution[] = [];

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
});
