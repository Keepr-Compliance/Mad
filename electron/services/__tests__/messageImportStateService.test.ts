/**
 * @jest-environment node
 *
 * BACKLOG-2292 unit test for messageImportStateService against a REAL in-memory
 * better-sqlite3 DB (wired via setDb). Asserts the watermark contract the export
 * gate depends on:
 *   - SR (g): last_expansion_at advances only on OBSERVED expansion success, so a
 *     silent expansion failure keeps isExpansionStale() TRUE.
 *   - SR D2: deepest_import_start records the EARLIEST auditPeriodStart scanned
 *     (MIN over calls) and never regresses to a shallower reach.
 */
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { setDb } from "../db/core/dbConnection";
import {
  getState,
  recordImport,
  recordExpansionRun,
  getDeepestImportStart,
  isExpansionStale,
} from "../db/messageImportStateService";

const USER = "user-2292";
const ms = (iso: string) => new Date(iso).getTime();

function makeDb(): DatabaseType {
  const db = new Database(":memory:") as DatabaseType;
  db.exec(`
    CREATE TABLE message_import_state (
      user_id TEXT PRIMARY KEY,
      last_import_at DATETIME,
      last_expansion_at DATETIME,
      deepest_import_start DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

let db: DatabaseType;
beforeEach(() => {
  db = makeDb();
  setDb(db);
});
afterEach(() => {
  db.close();
});

describe("messageImportStateService (BACKLOG-2292)", () => {
  it("starts empty: no state, no deepest import, not stale", () => {
    expect(getState(USER)).toBeUndefined();
    expect(getDeepestImportStart(USER)).toBeNull();
    expect(isExpansionStale(USER)).toBe(false);
  });

  it("recordImport sets last_import_at + deepest_import_start and makes expansion stale", () => {
    recordImport(USER, "2024-01-01T00:00:00.000Z");
    const row = getState(USER);
    expect(row?.last_import_at).toBeTruthy();
    expect(row?.last_expansion_at).toBeNull();
    expect(getDeepestImportStart(USER)).toBe("2024-01-01T00:00:00.000Z");
    // import ran, expansion has NOT → stale.
    expect(isExpansionStale(USER)).toBe(true);
  });

  it("deepest_import_start only ever grows DEEPER (MIN), never regresses (SR D2)", () => {
    recordImport(USER, "2024-01-01T00:00:00.000Z");
    // A later, DEEPER import moves the watermark earlier.
    recordImport(USER, "2020-06-01T00:00:00.000Z");
    expect(getDeepestImportStart(USER)).toBe("2020-06-01T00:00:00.000Z");
    // A subsequent SHALLOWER import must NOT regress the watermark.
    recordImport(USER, "2023-01-01T00:00:00.000Z");
    expect(ms(getDeepestImportStart(USER) as string)).toBe(ms("2020-06-01T00:00:00.000Z"));
    // A null-reach import leaves the watermark untouched.
    recordImport(USER, null);
    expect(ms(getDeepestImportStart(USER) as string)).toBe(ms("2020-06-01T00:00:00.000Z"));
  });

  it("recordExpansionRun after import clears staleness (advance-on-success)", () => {
    recordImport(USER, "2024-01-01T00:00:00.000Z");
    db.prepare(
      "UPDATE message_import_state SET last_import_at = '2026-01-01T00:00:00.000Z' WHERE user_id = ?",
    ).run(USER);
    expect(isExpansionStale(USER)).toBe(true);
    recordExpansionRun(USER);
    expect(isExpansionStale(USER)).toBe(false);
  });

  it("a NEW import after expansion makes it stale again (SR-g reprompt)", () => {
    recordImport(USER, "2024-01-01T00:00:00.000Z");
    recordExpansionRun(USER);
    db.prepare(
      "UPDATE message_import_state SET last_expansion_at = '2026-01-01T00:00:00.000Z', last_import_at = '2026-06-01T00:00:00.000Z' WHERE user_id = ?",
    ).run(USER);
    expect(isExpansionStale(USER)).toBe(true);
  });

  it("expansion recorded WITHOUT any import is not stale (email-only / never-imported user)", () => {
    recordExpansionRun(USER);
    expect(getDeepestImportStart(USER)).toBeNull();
    expect(isExpansionStale(USER)).toBe(false);
  });
});
