/**
 * BACKLOG-2834 / BACKLOG-3975 / BACKLOG-3298 — names for copies of the database
 * kept beside it: `mad-<label>-<YYYYMMDDTHHMMSSmmm>[-n].db`.
 *
 * The rule was `databaseService._moveAside`'s; it lives here so other callers
 * name their copies the same way. This module never writes.
 */
import fs from "fs";
import path from "path";

/** Most names tried before a move aside gives up (fails closed, moves nothing). */
export const ASIDE_MAX_SUFFIX = 100;
export const ASIDE_SIDECARS = ["", "-wal", "-shm"] as const;

/**
 * A free `mad-<label>-<time>[-n].db` beside `dbPath`. A name is taken if the
 * base or either sidecar exists; -2 .. -100 are tried, then null (the caller
 * fails closed).
 */
export function pickAsidePath(dbPath: string, label: string, now: Date = new Date()): string | null {
  const dbDir = path.dirname(dbPath);
  const dbName = path.basename(dbPath, ".db");
  const timestamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 18);
  const taken = (p: string): boolean => ASIDE_SIDECARS.some((x) => fs.existsSync(p + x));
  let asidePath = path.join(dbDir, `${dbName}-${label}-${timestamp}.db`);
  for (let n = 2; taken(asidePath); n++) {
    if (n > ASIDE_MAX_SUFFIX) return null;
    asidePath = path.join(dbDir, `${dbName}-${label}-${timestamp}-${n}.db`);
  }
  return asidePath;
}
