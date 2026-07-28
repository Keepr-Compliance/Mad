/**
 * @jest-environment node
 *
 * BACKLOG-2292 unit test for messageImportStateService against a REAL in-memory
 * better-sqlite3 DB (wired via setDb). Asserts the staleness contract the export
 * gate depends on — in particular SR-correction (g): last_expansion_at only
 * advances on OBSERVED expansion success, so a silent expansion failure keeps
 * isExpansionStale() TRUE (never latches "done").
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
  hasImportRun,
  isExpansionStale,
} from "../db/messageImportStateService";

const USER = "user-2292";

function makeDb(): DatabaseType {
  const db = new Database(":memory:") as DatabaseType;
  db.exec(`
    CREATE TABLE message_import_state (
      user_id TEXT PRIMARY KEY,
      last_import_at DATETIME,
      last_expansion_at DATETIME,
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
  it("starts empty: no state, no import, not stale", () => {
    expect(getState(USER)).toBeUndefined();
    expect(hasImportRun(USER)).toBe(false);
    expect(isExpansionStale(USER)).toBe(false);
  });

  it("recordImport sets last_import_at and makes expansion stale until it runs", () => {
    recordImport(USER);
    const row = getState(USER);
    expect(row?.last_import_at).toBeTruthy();
    expect(row?.last_expansion_at).toBeNull();
    expect(hasImportRun(USER)).toBe(true);
    // import ran, expansion has NOT → stale.
    expect(isExpansionStale(USER)).toBe(true);
  });

  it("recordExpansionRun after import clears staleness (advance-on-success)", () => {
    recordImport(USER);
    // Force a strictly later expansion timestamp so the epoch-ms compare is
    // unambiguous even at coarse second granularity.
    db.prepare(
      "UPDATE message_import_state SET last_import_at = '2026-01-01T00:00:00.000Z' WHERE user_id = ?",
    ).run(USER);
    expect(isExpansionStale(USER)).toBe(true);
    recordExpansionRun(USER);
    expect(isExpansionStale(USER)).toBe(false);
  });

  it("a NEW import after expansion makes it stale again (SR-g: reprompt when import outran expansion)", () => {
    recordImport(USER);
    recordExpansionRun(USER);
    // Simulate: expansion recorded, then a later import ran but expansion did NOT.
    db.prepare(
      "UPDATE message_import_state SET last_expansion_at = '2026-01-01T00:00:00.000Z', last_import_at = '2026-06-01T00:00:00.000Z' WHERE user_id = ?",
    ).run(USER);
    expect(isExpansionStale(USER)).toBe(true);
  });

  it("expansion recorded WITHOUT any import is not stale (email-only / never-imported user)", () => {
    recordExpansionRun(USER);
    expect(hasImportRun(USER)).toBe(false);
    expect(isExpansionStale(USER)).toBe(false);
  });
});
