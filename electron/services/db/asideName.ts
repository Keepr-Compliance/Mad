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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Same file under two spellings (symlink, `..`) compares equal. */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Keep-one retention (BACKLOG-3298, founder decisions 2026-11-09 / 2026-11-10):
 * delete every `mad-<label>-<time>[-n].db` (and its -wal / -shm) beside
 * `dbPath` except the paths in `keep`. Matches ONLY the exact name
 * `pickAsidePath` writes, so `mad.db`, `mad-backup-*`, `keepr-backup-*` and
 * other labels never match. Call it only AFTER the new copy exists. Never
 * throws; returns what it deleted.
 */
export function pruneAsideCopies(dbPath: string, label: string, keep: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  try {
    const dbDir = path.dirname(dbPath);
    const dbName = path.basename(dbPath, ".db");
    const re = new RegExp(`^${escapeRe(dbName)}-${escapeRe(label)}-\\d{8}T\\d{9}(-\\d+)?\\.db$`);
    const keepCanonical = new Set([...keep].map(canonical));
    for (const name of fs.readdirSync(dbDir)) {
      if (!re.test(name)) continue;
      const full = path.join(dbDir, name);
      if (keepCanonical.has(canonical(full))) continue;
      for (const x of ASIDE_SIDECARS) {
        try {
          if (fs.existsSync(full + x)) {
            fs.unlinkSync(full + x);
            removed.push(full + x);
          }
        } catch {
          // Retention never fails the caller; the copy stays for next time.
        }
      }
    }
  } catch {
    // Cannot read the folder: nothing deleted.
  }
  return removed;
}
