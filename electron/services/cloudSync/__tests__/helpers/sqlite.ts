/**
 * A SQLite handle for the Keepr Cloud SQL suites (BACKLOG-4243).
 *
 * Prefers the bundled driver (better-sqlite3-multiple-ciphers, by absolute
 * path, as the v78 suite does). When the shared binary is the Electron build
 * and cannot load under jest, falls back to Node's built-in `node:sqlite`
 * (NOT the bundled driver; the suite title says which ran). Never skips.
 */
import path from "path";
import type { SqlDb, SqlStatement } from "../../../db/cloudSyncSqlDb";

export interface TestDb extends SqlDb {
  pragma(sql: string): void;
  close(): void;
}

function tryBundled(): (() => TestDb) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Real = require(path.join(__dirname, "..", "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"));
    const probe = new Real(":memory:");
    probe.close();
    return () => {
      const db = new Real(":memory:");
      return {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => db.prepare(sql) as SqlStatement,
        pragma: (sql: string) => void db.pragma(sql),
        close: () => db.close(),
      };
    };
  } catch {
    return null;
  }
}

function nodeSqlite(): () => TestDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const norm = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
  return () => {
    const db = new DatabaseSync(":memory:");
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        return {
          run: (...p: unknown[]) => st.run(...norm(p)),
          get: (...p: unknown[]) => {
            const r = st.get(...norm(p));
            return r === undefined ? undefined : { ...r };
          },
          all: (...p: unknown[]) => (st.all(...norm(p)) as object[]).map((r) => ({ ...r })),
        };
      },
      pragma: (sql: string) => db.exec(`PRAGMA ${sql}`),
      close: () => db.close(),
    };
  };
}

const bundled = tryBundled();
export const DRIVER = bundled ? "bundled better-sqlite3-multiple-ciphers" : "node:sqlite (NOT the bundled driver)";
export const openTestDb: () => TestDb = bundled ?? nodeSqlite();
