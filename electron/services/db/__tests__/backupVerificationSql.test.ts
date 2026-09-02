/**
 * Pin for `BACKUP_TABLE_COUNT_SQL` — BACKLOG-2989 PR 1.
 *
 * The statement moved out of `sqliteBackupService.verifyBackup`.
 * `sqliteBackupService.test.ts` cannot notice a change in its meaning: it
 * replaces the driver with `jest.fn()` (`mockTestDbPrepare`), which never reads
 * the SQL it is handed, so a mutated statement leaves that suite green. This is
 * the control that does not.
 *
 * Executed against the REAL driver on a REAL database file, because what the
 * statement is for is proving a file on disk can actually be read — a claim no
 * fake can make on its behalf.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { BACKUP_TABLE_COUNT_SQL } from "../backupVerificationSql";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const count = (): number =>
  (db.prepare(BACKUP_TABLE_COUNT_SQL).get() as { count: number }).count;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-backupverify-"));
  db = new RealDatabase(path.join(tmpRoot, "backup.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("BACKUP_TABLE_COUNT_SQL", () => {
  it("reports zero for a database that opened but holds nothing", () => {
    // This is the case the statement exists to catch: `verifyBackup` treats a
    // zero here as a FAILED verification, not as a successful check of an
    // empty backup.
    expect(count()).toBe(0);
  });

  it("counts every table, and counts each one once", () => {
    db.exec("CREATE TABLE alpha (id TEXT PRIMARY KEY)");
    expect(count()).toBe(1);

    db.exec("CREATE TABLE beta (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE gamma (id TEXT PRIMARY KEY)");
    expect(count()).toBe(3);
  });

  it("counts tables only — not indexes, views or triggers", () => {
    // `type='table'` is the whole discriminator. Without it every index and
    // trigger inflates the count, and a backup holding one empty table plus
    // its indexes would verify as healthy.
    db.exec("CREATE TABLE alpha (id TEXT PRIMARY KEY, name TEXT)");
    expect(count()).toBe(1);

    db.exec("CREATE INDEX idx_alpha_name ON alpha(name)");
    db.exec("CREATE VIEW v_alpha AS SELECT id FROM alpha");
    db.exec(
      "CREATE TRIGGER trg_alpha AFTER INSERT ON alpha BEGIN SELECT 1; END",
    );

    expect(count()).toBe(1);

    // Proof the fixture actually created them, so the assertion above is a
    // filter working rather than three statements silently doing nothing.
    const others = db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE type IN ('index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ type: string; name: string }>;
    expect(others).toEqual([
      { type: "index", name: "idx_alpha_name" },
      { type: "trigger", name: "trg_alpha" },
      { type: "view", name: "v_alpha" },
    ]);
  });

  it("returns the count under the key the caller destructures", () => {
    db.exec("CREATE TABLE alpha (id TEXT PRIMARY KEY)");

    // `verifyBackup` reads `.count`. The alias is load-bearing: without
    // `as count` the column is named `count(*)` and the caller reads undefined,
    // which compares false against 0 and passes a broken backup.
    const row = db.prepare(BACKUP_TABLE_COUNT_SQL).get();
    expect(row).toEqual({ count: 1 });
  });
});
