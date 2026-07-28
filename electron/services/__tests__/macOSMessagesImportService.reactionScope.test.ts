/**
 * @jest-environment node
 *
 * BACKLOG-2280 C1 — importer count/fetch SCOPE-CONSISTENCY guard.
 *
 * The macOS import fetch loop runs `while (fetchedCount < totalMessageCount)`,
 * where totalMessageCount comes from a COUNT(*) query and fetchedCount counts the
 * rows returned by the paginated SELECT. If the COUNT excluded reactions but the
 * SELECT included them (or vice-versa) the loop would terminate early and SILENTLY
 * DROP the newest rows (ORDER BY ROWID ASC).
 *
 * This runs the SAME WHERE clause the importer now uses on both the count and the
 * paginated fetch (`WHERE guid IS NOT NULL`, no reaction exclusion) against a
 * macOS-chat.db-shaped `message` table that CONTAINS reaction rows, and asserts:
 *   1. the count == the number of fetched rows (loop cannot terminate early), and
 *   2. reaction rows are present in BOTH (they are imported, then band-routed).
 *
 * It also asserts isReactionAssociationType (the import-time routing predicate)
 * flags exactly the reaction rows in the fetched set.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { isReactionAssociationType } from "../macOSMessagesImportService/importHelpers";

interface SourceRow {
  id: number;
  guid: string;
  associated_message_type: number | null;
  associated_message_guid: string | null;
}

// Mirrors the importer's macOS source WHERE (post-BACKLOG-2280): reactions are
// NOT excluded, so the count scope == the fetch scope.
const COUNT_SQL = `SELECT COUNT(*) as count FROM message WHERE guid IS NOT NULL`;
const FETCH_SQL = `
  SELECT ROWID as id, guid, associated_message_type, associated_message_guid
  FROM message
  WHERE guid IS NOT NULL AND ROWID > ?
  ORDER BY ROWID ASC
  LIMIT ?`;

function seedMessageTable(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      associated_message_type INTEGER,
      associated_message_guid TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO message (ROWID, guid, associated_message_type, associated_message_guid) VALUES (?, ?, ?, ?)",
  );
  // 5 normal messages interleaved with 3 reactions; the reactions are the NEWEST
  // rows (highest ROWID) — exactly the rows an early loop-exit would drop.
  insert.run(1, "G1", null, null);
  insert.run(2, "G2", null, null);
  insert.run(3, "G3", null, null);
  insert.run(4, "R1", 2000, "p:0/G1"); // reaction on G1
  insert.run(5, "G4", null, null);
  insert.run(6, "R2", 3001, "p:0/G2"); // reaction removal on G2
  insert.run(7, "G5", null, null);
  insert.run(8, "R3", 2003, "p:1/G5"); // reaction on a multi-part message
}

/** Replicates the importer's cursor-paginated fetch loop. */
function fetchAll(db: DatabaseType, total: number, batchSize: number): SourceRow[] {
  const stmt = db.prepare(FETCH_SQL);
  const all: SourceRow[] = [];
  let lastRowId = 0;
  let fetchedCount = 0;
  while (fetchedCount < total) {
    const remaining = total - fetchedCount;
    const batch = stmt.all(lastRowId, Math.min(batchSize, remaining)) as SourceRow[];
    if (batch.length === 0) break;
    for (const r of batch) all.push(r);
    lastRowId = batch[batch.length - 1].id;
    fetchedCount += batch.length;
  }
  return all;
}

describe("macOS import reaction scope-consistency (BACKLOG-2280 C1)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as DatabaseType;
    seedMessageTable(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
  });

  it("counts the SAME rows it fetches, so the loop never terminates early", () => {
    const total = (db.prepare(COUNT_SQL).get() as { count: number }).count;
    // 5 normal + 3 reactions = 8 rows.
    expect(total).toBe(8);

    // Small batch size forces multiple loop iterations (paginate 8 rows by 3).
    const fetched = fetchAll(db, total, 3);
    expect(fetched).toHaveLength(total); // fetchedCount reaches totalMessageCount

    // The three reaction rows (newest ROWIDs) are present — NOT dropped.
    const fetchedGuids = new Set(fetched.map((r) => r.guid));
    expect(fetchedGuids).toEqual(new Set(["G1", "G2", "G3", "G4", "G5", "R1", "R2", "R3"]));
  });

  it("flags exactly the reaction rows for band-routing in the fetched set", () => {
    const total = (db.prepare(COUNT_SQL).get() as { count: number }).count;
    const fetched = fetchAll(db, total, 100);
    const reactionGuids = fetched
      .filter((r) => isReactionAssociationType(r.associated_message_type))
      .map((r) => r.guid);
    expect(new Set(reactionGuids)).toEqual(new Set(["R1", "R2", "R3"]));
  });
});
