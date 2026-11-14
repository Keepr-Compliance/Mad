/**
 * The slice of a SQLite handle the Keepr Cloud code uses (BACKLOG-4243).
 * better-sqlite3 satisfies it; so does a thin adapter over another driver in
 * tests. Transactions use SAVEPOINT so they nest inside a caller's transaction.
 */
export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

let savepointSeq = 0;

/** Runs fn in one SAVEPOINT: all of it commits, or none of it. */
export function withSavepoint<T>(db: SqlDb, fn: () => T): T {
  const name = `cloud_sync_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      /* the original error is the one that matters */
    }
    throw error;
  }
}

export function tableColumns(db: SqlDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
