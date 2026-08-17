/**
 * @jest-environment node
 *
 * MIGRATION v51 — THE ONE-ARGUMENT COALESCE (BACKLOG-2750)
 *
 * v51 backfills `transactions.first_exported_at` from whichever of
 * `last_exported_at` / `last_exported_on` / `updated_at` the table actually has,
 * composing the SQL from the present columns so a partial-schema database
 * degrades instead of erroring on "no such column". The guard reads:
 *
 *     if (tsCandidates.length > 0 && flagConditions.length > 0)
 *         ... SET first_exported_at = COALESCE(<candidates>)
 *
 * **SQLite's COALESCE requires AT LEAST TWO arguments.** `COALESCE(x)` is not a
 * one-element identity — it raises
 *
 *     wrong number of arguments to function COALESCE()
 *
 * which the runner turns into "Migration 51 ... failed" and escalates to a
 * restore-from-backup. So the guard admits exactly one shape it cannot execute:
 * a `transactions` table with EXACTLY ONE of the three timestamps and at least
 * one export flag.
 *
 * ===========================================================================
 * WHY THE EXISTING v51 SUITE CANNOT CATCH THIS
 * ===========================================================================
 * `databaseService.migration-v51.test.ts` is a strong suite, and it stays GREEN
 * with the fix reverted. Its `PRE_V51_FIXTURE` declares ALL THREE timestamp
 * columns, so `tsCandidates.length` is always 3 and the emitted SQL is always a
 * legal three-argument COALESCE. The branch this file exercises is unreachable
 * from that fixture by construction — a test that cannot vary the input cannot
 * detect a bug that only appears at one value of it.
 *
 * Before this file, the fix's only protection was an ACCIDENT of the
 * `migration-v43` suite's fixture shape (its minimal `transactions` has
 * `updated_at` and a flag but neither `last_exported_*`, and v63 adds
 * `last_exported_on` to it). Change that unrelated fixture and the protection
 * silently disappears. Hence a direct test.
 *
 * ===========================================================================
 * HONEST SCOPE — THIS IS A PREREQUISITE, NOT A PRODUCTION CRASH
 * ===========================================================================
 * The first version of this claim, in the migration comment, said the defect
 * was "reachable in production independently of v63". That was WRONG, and SR
 * review caught it. Measured since, and restated here so the record in the code
 * matches the evidence:
 *
 *   Every historical `electron/database/schema.sql` state carrying a
 *   `transactions` table — 70 of 70 — rebuilt, then `PRAGMA table_info` read.
 *   ZERO produce exactly one timestamp candidate alongside an export flag.
 *   The flag and timestamp columns shipped together (6c0e67ed5, 2025-11-17),
 *   so no shipped database can reach the bad branch.
 *
 * It is reachable from the migration harness's minimal table, which is why
 * adding v63 turned the whole `migration-v43` suite red. The fix is therefore a
 * PREREQUISITE for v63 rather than an independent production fix — and still a
 * genuine latent defect, since the guard says `> 0` where the SQL needs `>= 2`,
 * and any future migration or re-baseline adding one of these columns without
 * the others would reach it for real.
 *
 * ===========================================================================
 * CONTROL — RUN, AND WHAT IT DID
 * ===========================================================================
 * Revert the fix (`const tsExpr = ` + "`COALESCE(${tsCandidates.join(\", \")})`" + `),
 * so the one-argument case is emitted again.
 *   RESULT: RED — "single candidate" and "backfill still runs" fail with
 *       SqliteError: wrong number of arguments to function COALESCE()
 *   while the two- and three-candidate cases stay GREEN, which is what proves
 *   this file is testing the arity branch and not v51 generally.
 * Tree restored; `git status --porcelain` verified empty.
 */

import type { Database as DatabaseType } from "better-sqlite3";

import {
  createMigrationHarness,
  type MigrationHarness,
} from "./helpers/migrationTestHarness";

const USER_ID = "user-v51-coalesce";

/**
 * Builds a `transactions` table carrying ONLY the requested timestamp columns.
 * The column set is the independent variable — the whole point is to sweep the
 * candidate COUNT across the boundary rather than sample one value of it.
 *
 * `export_status` is always present so `flagConditions` is non-empty; with no
 * flag the guard skips the backfill entirely and the arity never matters.
 */
function fixtureWith(timestamps: readonly string[]): string {
  const tsCols = timestamps.map((c) => `    ${c} DATETIME,`).join("\n");
  return `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    property_address TEXT NOT NULL,
    export_status TEXT DEFAULT 'not_exported',
${tsCols}
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;
}

describe("databaseService migration v51 — COALESCE arity (BACKLOG-2750)", () => {
  let harness: MigrationHarness;

  function columnExists(db: DatabaseType, table: string, column: string): boolean {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (c) => c.name === column,
    );
  }

  /** Seed at 50 and clip to <= 51 so ONLY v51 runs — no later migration can mask it. */
  async function runV51(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 50)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 51);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  function setup(timestamps: readonly string[]): void {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(fixtureWith(timestamps));
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  }

  /** One exported row (flag set) and one never-exported row. */
  function seedRows(stampCol: string | null, stamp: string): void {
    const cols = ["id", "user_id", "property_address", "export_status"];
    const vals: unknown[] = ["txn-exported", USER_ID, "1 Main St", "exported"];
    if (stampCol) {
      cols.push(stampCol);
      vals.push(stamp);
    }
    harness.db
      .prepare(
        `INSERT INTO transactions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...vals);
    harness.db
      .prepare(
        "INSERT INTO transactions (id, user_id, property_address, export_status) VALUES (?, ?, ?, 'not_exported')",
      )
      .run("txn-fresh", USER_ID, "2 Main St");
  }

  function firstExportedAt(id: string): string | null {
    return (
      (
        harness.db
          .prepare("SELECT first_exported_at AS v FROM transactions WHERE id = ?")
          .get(id) as { v: string | null } | undefined
      )?.v ?? null
    );
  }

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  // =========================================================================
  // THE BOUNDARY — swept, not sampled. One input per branch cannot catch an
  // off-by-one, and this defect IS an off-by-one in an argument count.
  // =========================================================================

  it("ONE candidate: does not throw (pre-fix: wrong number of arguments to function COALESCE())", async () => {
    setup(["updated_at"]);
    seedRows("updated_at", "2026-03-01T10:00:00.000Z");
    await expect(runV51()).resolves.toBeUndefined();
  });

  it("ONE candidate: still performs the backfill, rather than skipping it to stay safe", async () => {
    // The cheap way to make the error disappear would be to raise the guard to
    // `>= 2`, which would silently stop backfilling single-timestamp tables. That
    // would be green here and wrong, so assert the VALUE actually landed.
    setup(["updated_at"]);
    seedRows("updated_at", "2026-03-01T10:00:00.000Z");
    await runV51();

    expect(columnExists(harness.db, "transactions", "first_exported_at")).toBe(true);
    expect(firstExportedAt("txn-exported")).toBe("2026-03-01T10:00:00.000Z");
    // ...and the never-exported row is left alone: the freeze is not retroactive
    // for transactions that were never exported (BACKLOG-2013).
    expect(firstExportedAt("txn-fresh")).toBeNull();
  });

  it("TWO candidates: unchanged, and prefers last_exported_at over updated_at", async () => {
    setup(["last_exported_at", "updated_at"]);
    harness.db
      .prepare(
        `INSERT INTO transactions (id, user_id, property_address, export_status, last_exported_at, updated_at)
         VALUES ('txn-exported', ?, '1 Main St', 'exported', ?, ?)`,
      )
      .run(USER_ID, "2026-04-02T09:00:00.000Z", "2026-05-05T09:00:00.000Z");
    await runV51();
    expect(firstExportedAt("txn-exported")).toBe("2026-04-02T09:00:00.000Z");
  });

  it("THREE candidates: unchanged — the shape the pre-existing v51 suite covers", async () => {
    setup(["last_exported_at", "last_exported_on", "updated_at"]);
    seedRows("last_exported_on", "2026-06-06T08:00:00.000Z");
    await runV51();
    // last_exported_at is NULL here, so COALESCE falls through to last_exported_on.
    expect(firstExportedAt("txn-exported")).toBe("2026-06-06T08:00:00.000Z");
  });

  it("ZERO candidates: the guard skips the backfill instead of emitting COALESCE()", async () => {
    // No timestamp columns at all — the column is still added, but there is
    // nothing to freeze retroactively and no SQL should be emitted.
    setup([]);
    seedRows(null, "");
    await expect(runV51()).resolves.toBeUndefined();
    expect(columnExists(harness.db, "transactions", "first_exported_at")).toBe(true);
    expect(firstExportedAt("txn-exported")).toBeNull();
  });
});
