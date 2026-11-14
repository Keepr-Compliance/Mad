/**
 * The slice of a SQLite handle the Keepr Cloud code uses (BACKLOG-4243).
 * better-sqlite3 satisfies it; so does a thin adapter over another driver in
 * tests.
 */
export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  /** better-sqlite3 semantics: all or nothing; nested calls become savepoints. */
  transaction<T>(fn: () => T): () => T;
}

export function tableColumns(db: SqlDb, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
