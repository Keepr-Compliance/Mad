/**
 * @jest-environment node
 *
 * BACKLOG-2371 — MIGRATION v36 SURVIVES A NEW COLUMN ON `contacts`.
 *
 * ===========================================================================
 * WHY THIS TEST AND NOT ONLY THE PATTERN GUARD
 * ===========================================================================
 * The sibling guard asserts no migration copies with `SELECT *`. That proves
 * the SHAPE is gone. **It does not prove the landmine is defused** — and the
 * landmine is what matters: fresh installs seed `schema_version = 32`, so they
 * RUN v36, and the day someone adds a column to `schema.sql:contacts` the old
 * `SELECT *` supplied 16 values into a 15-column table and every fresh install
 * failed at PREPARE time.
 *
 * So this runs the REAL migration — `DatabaseService.MIGRATIONS` v36, the
 * exported production list — against a `contacts` table carrying an extra
 * column, and asserts it completes and the rows survive.
 *
 * **It is the test that would have caught the defect**, and it fails on the
 * code that shipped: control executed, output in the PR.
 *
 * The item asked for a column-count assertion (`schema.sql:contacts` == v36's
 * `contacts_new`). Named columns make that equality unnecessary rather than
 * enforced — so the stronger statement is asserted instead: the counts may
 * DIVERGE and the migration still works.
 */

import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

let db: TestDb | null = null;

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

// `MIGRATIONS` is a static on the class, and the module exports the INSTANCE.
// Reached through `.constructor`, exactly as
// `databaseService.migration.test.ts:169` does.
import databaseServiceInstance from "../databaseService";

/**
 * The 15 columns `contacts` carried when v36 was written, plus the table its
 * foreign key points at — v36 rebuilds `contacts` with that key, so the
 * referent has to exist or the rebuild fails for an unrelated reason and the
 * assertion below would be measuring the wrong thing.
 */
const V36_ERA_CONTACTS = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);
  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    title TEXT,
    source TEXT DEFAULT 'manual',
    last_inbound_at DATETIME,
    last_outbound_at DATETIME,
    total_messages INTEGER DEFAULT 0,
    tags TEXT,
    is_imported INTEGER DEFAULT 1,
    default_role TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

function v36() {
  const cls = (databaseServiceInstance as unknown as { constructor: unknown })
    .constructor as { MIGRATIONS: Array<{ version: number; migrate: (d: unknown) => void }> };
  const list = cls.MIGRATIONS;
  const m = list.find((x) => x.version === 36);
  if (!m) throw new Error("migration v36 not found — this test is pinned to it");
  return m;
}

function contactIds(): string[] {
  return (db!.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

beforeEach(() => {
  db = openTestDb();
  // The real migration runner turns foreign keys OFF around the rebuild
  // (databaseService.ts, `pragma("foreign_keys = OFF")` before the loop). This
  // fixture seeds the referenced user instead, so the migration is exercised
  // under the STRICTER condition rather than a relaxed one.
});

afterEach(() => {
  db?.close();
  db = null;
});

describe("migration v36 copies by NAME, so a new column cannot break it (BACKLOG-2371)", () => {
  it("PRECONDITION: v36 is still in the production migration list", () => {
    expect(v36().version).toBe(36);
  });

  it("runs against the 15-column table it was written for", () => {
    db!.exec(V36_ERA_CONTACTS);
    db!.prepare("INSERT INTO users_local (id) VALUES ('u')").run();
    db!
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES ('c1', 'u', 'Pat Riverton')")
      .run();

    v36().migrate(db);

    expect(contactIds()).toEqual(["c1"]);
  });

  /**
   * THE CASE THE ITEM EXISTS FOR.
   *
   * CONTROL (executed): restore `INSERT OR IGNORE INTO contacts_new SELECT *
   * FROM contacts` and this fails at prepare time —
   *   SqliteError: table contacts_new has 15 columns but 16 values were supplied
   * which is the error every fresh install would have shown.
   */
  it("runs against a table that has gained a column — the fresh-install case", () => {
    db!.exec(V36_ERA_CONTACTS);
    db!.prepare("INSERT INTO users_local (id) VALUES ('u')").run();
    db!.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
    db!
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES ('c1', 'u', 'Pat Riverton')")
      .run();

    let outcome = "COMPLETED";
    try {
      v36().migrate(db);
    } catch (e) {
      outcome = `THREW: ${(e as Error).message}`;
    }

    expect(outcome).toBe("COMPLETED");
    // The row survived. A migration that "succeeds" by copying nothing is the
    // other way this could go wrong.
    expect(contactIds()).toEqual(["c1"]);
  });

  it("carries the values across, not just the ids", () => {
    db!.exec(V36_ERA_CONTACTS);
    db!.prepare("INSERT INTO users_local (id) VALUES ('u')").run();
    db!.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
    db!
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, company, is_imported) VALUES ('c1', 'u', 'Pat Riverton', 'Northgate Realty', 1)",
      )
      .run();

    v36().migrate(db);

    const row = db!.prepare("SELECT display_name, company, is_imported FROM contacts WHERE id = 'c1'").get();
    expect(row).toEqual({
      display_name: "Pat Riverton",
      company: "Northgate Realty",
      is_imported: 1,
    });
  });
});
