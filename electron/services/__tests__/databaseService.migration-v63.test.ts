/**
 * @jest-environment node
 *
 * MIGRATION v63 IN ISOLATION — BACKLOG-2750
 *
 * The end-to-end suite (`databaseService.legacyColumnUpgrade.test.ts`) drives a
 * real historical database through the real `runMigrations()`, and it is the
 * one that proves the crash is gone. It cannot, however, prove that v63's SQL
 * is correct, and the reason is worth stating plainly because it is the same
 * trap this whole item is about:
 *
 *   - the 2026-01-26 fixture is missing exactly ONE of the seven columns
 *     (`attachments.email_id`), so it executes ONE of v63's seven ALTERs;
 *   - the fresh-install path skips the ALTER branch entirely — every column is
 *     already declared in CREATE TABLE, so only the index half runs;
 *   - every other committed fixture is at v55, where all seven exist.
 *
 * Six `ALTER TABLE ... ADD COLUMN` statements would therefore have shipped
 * NEVER HAVING EXECUTED, in a PR whose subject is a crash caused by SQL that
 * only runs on old databases. Two of them (`license_type`, `submission_status`)
 * carry DEFAULT + CHECK clauses, whose legality under ALTER TABLE ADD COLUMN is
 * a real question — answered here by running it, not by recall.
 *
 * WHY ISOLATION RATHER THAN AN OLDER END-TO-END FIXTURE. Every database old
 * enough to lack all seven columns dies inside migration v43, which rebuilds
 * `communications` by SELECTing `email_id`/`thread_id` out of a table that has
 * neither (filed as BACKLOG-2751). Until that lands, no end-to-end fixture can
 * reach v63 from that far back, so this is the only available coverage.
 *
 * The fixture is three CREATE TABLE statements transcribed verbatim from the
 * commits at which each table really lacked its columns — see
 * `fixtures/pre-v63-composite.sql` for the provenance and the `git show`
 * commands that regenerate it.
 *
 * SEEDING AND CLIPPING follow the v62 suite's idiom: seed at 62 and clip
 * MIGRATIONS to <= 63 so ONLY v63 runs, keeping every assertion here a
 * statement about v63 when v64 lands.
 *
 * CONTROL — executed, tree restored:
 *   Neuter v63 (`return;` as the first statement of `migrate`).
 *   RESULT: RED on every column and index assertion below.
 *   Recorded on BACKLOG-2750 in pm_comments.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

import {
  createMigrationHarness,
  type MigrationHarness,
} from "./helpers/migrationTestHarness";

/** The seven (table, column, index) triples v63 repairs. */
const REPAIRED: ReadonlyArray<{ table: string; column: string; index: string }> = [
  { table: "users_local", column: "license_type", index: "idx_users_local_license_type" },
  { table: "users_local", column: "organization_id", index: "idx_users_local_organization" },
  { table: "attachments", column: "email_id", index: "idx_attachments_email_id" },
  {
    table: "attachments",
    column: "external_message_id",
    index: "idx_attachments_external_message_id",
  },
  {
    table: "transactions",
    column: "last_exported_on",
    index: "idx_transactions_last_exported_on",
  },
  {
    table: "transactions",
    column: "submission_status",
    index: "idx_transactions_submission_status",
  },
  { table: "transactions", column: "submission_id", index: "idx_transactions_submission_id" },
];

const PRE_V63_FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "pre-v63-composite.sql"),
  "utf8",
);

const USER_ID = "u-2750-v63";
const TRANSACTION_ID = "t-2750-v63";

describe("databaseService migration v63 (BACKLOG-2750 — legacy columns + deferred indexes)", () => {
  let harness: MigrationHarness;

  function columns(db: DatabaseType, table: string): string[] {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
  }

  function indexes(db: DatabaseType): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
  }

  /** Seed at v62 AND clip the chain at v63 so ONLY v63 runs. */
  async function runV63(): Promise<void> {
    harness.db
      .prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 62)")
      .run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 63);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V63_FIXTURE);

    // Seed with FK enforcement OFF, then restore it — the same pattern the
    // rehearsal harness uses for its dump. The historical `transactions` body
    // declares FKs to `contacts` (buyer_agent_id, seller_agent_id, ...), a table
    // this three-table fixture deliberately does not carry. Trimming those FK
    // clauses out of the transcribed body would make it no longer verbatim, and
    // they are irrelevant to what v63 does.
    harness.db.pragma("foreign_keys = OFF");
    harness.db
      .prepare(
        "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
      )
      .run(USER_ID, "v63-2750@example.test", "oauth-v63");
    harness.db
      .prepare("INSERT INTO transactions (id, user_id, property_address) VALUES (?, ?, ?)")
      .run(TRANSACTION_ID, USER_ID, "742 Evergreen Terrace");

    // Back ON for the act phase: `_runVersionedMigrations` reads the CURRENT
    // pragma into `fkWasOn` and only restores enforcement if it was on to begin
    // with, so seeding must not leave the chain running from the wrong state.
    harness.db.pragma("foreign_keys = ON");
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  it("PRECONDITION: the fixture has all three tables and NONE of the seven columns", () => {
    for (const table of ["users_local", "attachments", "transactions"]) {
      expect(
        harness.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
          .get(table),
      ).toBeTruthy();
    }
    // The tables must EXIST and the columns must NOT — that combination is the
    // whole defect, since CREATE TABLE IF NOT EXISTS can never repair it.
    for (const { table, column } of REPAIRED) {
      expect(columns(harness.db, table)).not.toContain(column);
    }
  });

  it("executes ALL SEVEN ADD COLUMN statements", async () => {
    await runV63();
    for (const { table, column } of REPAIRED) {
      expect(columns(harness.db, table)).toContain(column);
    }
  });

  it("creates ALL SEVEN indexes", async () => {
    await runV63();
    const present = indexes(harness.db);
    for (const { index } of REPAIRED) {
      expect(present).toContain(index);
    }
  });

  it("applies the DEFAULT + CHECK columns legally, and to pre-existing rows", async () => {
    // The two statements this suite exists for. SQLite permits DEFAULT and CHECK
    // in ALTER TABLE ADD COLUMN (unlike PRIMARY KEY / UNIQUE), and applies the
    // default to rows that already exist — so an upgraded row must read the same
    // as a freshly-inserted one. If either clause were rejected, runV63 would
    // throw instead of reaching these assertions.
    await runV63();

    expect(
      (
        harness.db
          .prepare("SELECT license_type AS v FROM users_local WHERE id = ?")
          .get(USER_ID) as { v: string | null }
      ).v,
    ).toBe("individual");
    expect(
      (
        harness.db
          .prepare("SELECT submission_status AS v FROM transactions WHERE id = ?")
          .get(TRANSACTION_ID) as { v: string | null }
      ).v,
    ).toBe("not_submitted");

    // ...and the CHECK really is attached, not silently dropped: a value outside
    // the allowed set must be rejected. Without this, "the column exists with the
    // right default" would pass even if the constraint had been lost.
    expect(() =>
      harness.db
        .prepare("UPDATE users_local SET license_type = 'bogus' WHERE id = ?")
        .run(USER_ID),
    ).toThrow();
    expect(() =>
      harness.db
        .prepare("UPDATE transactions SET submission_status = 'bogus' WHERE id = ?")
        .run(TRANSACTION_ID),
    ).toThrow();
  });

  it("leaves the plain columns NULL rather than absent", async () => {
    await runV63();
    for (const col of ["organization_id"]) {
      expect(
        (
          harness.db.prepare(`SELECT ${col} AS v FROM users_local WHERE id = ?`).get(USER_ID) as {
            v: unknown;
          }
        ).v,
      ).toBeNull();
    }
    expect(
      (
        harness.db
          .prepare("SELECT submission_id AS v, last_exported_on AS w FROM transactions WHERE id = ?")
          .get(TRANSACTION_ID) as { v: unknown; w: unknown }
      ),
    ).toEqual({ v: null, w: null });
  });

  it("preserves the seeded rows BY IDENTITY", async () => {
    await runV63();
    expect(
      (harness.db.prepare("SELECT id FROM users_local").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual([USER_ID]);
    expect(
      (harness.db.prepare("SELECT id FROM transactions").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual([TRANSACTION_ID]);
  });

  it("advances schema_version to 63 and leaves the database intact", async () => {
    await runV63();
    expect(
      (harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }).version,
    ).toBe(63);
    expect(harness.db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("is idempotent — re-running throws no duplicate-column error", async () => {
    // Not hypothetical, and not only about the replay. Deleting the
    // `!cols.includes(column)` guard reds the upgrade suite 9-of-11 on the FIRST
    // pass with "duplicate column name: license_type" — fresh installs included,
    // since their tables already carry every column from CREATE TABLE. On top of
    // that, the baseline clamp at databaseService.ts:3756 makes a below-baseline
    // database replay the whole chain, so v63 genuinely runs twice on the
    // databases it targets (BACKLOG-2752). This test covers the second path.
    await runV63();
    await expect(runV63()).resolves.toBeUndefined();
    for (const { table, column } of REPAIRED) {
      expect(columns(harness.db, table).filter((c) => c === column)).toHaveLength(1);
    }
  });

  it("skips a missing table cleanly instead of throwing", async () => {
    // A minimal/partial-schema database may lack a table entirely. The guard must
    // skip it rather than fail the migration, which the runner would escalate to
    // a restore-from-backup — a catastrophic response to an absent table.
    harness.db.exec("DROP TABLE attachments");
    await expect(runV63()).resolves.toBeUndefined();
    // ...and the OTHER tables are still repaired.
    for (const { table, column } of REPAIRED.filter((r) => r.table !== "attachments")) {
      expect(columns(harness.db, table)).toContain(column);
    }
  });
});
