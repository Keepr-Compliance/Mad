/**
 * SQL for an encrypted iPhone backup's decrypted `Manifest.db` — BACKLOG-3817.
 *
 * Moved out of `backupDecryptionService` so the SQL text lives under
 * `electron/services/db/**` (BACKLOG-2959, enforced by the SQL Boundary Gate).
 *
 * Both statements run against a temporary decrypted copy of the backup's own
 * index, never against Keepr's database. The handle is typed structurally: the
 * service opens it through an untyped `require` of the SQLite driver.
 */

/** The part of a SQLite handle these statements need. */
export interface ManifestDbQueryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** One `Files` row the sync reads. `file` is the NSKeyedArchiver record blob. */
export interface ManifestFileRow {
  fileID: string;
  domain: string;
  relativePath: string;
  file: Buffer;
}

/** Number of rows in `Files`. Proves the index decrypted to a usable database. */
export const MANIFEST_FILE_COUNT_SQL = "SELECT COUNT(*) AS n FROM Files";

export function countManifestFiles(db: ManifestDbQueryable): number {
  const row = db.prepare(MANIFEST_FILE_COUNT_SQL).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Regular files (`flags = 1`) the sync reads: the two named databases, plus every
 * MediaDomain file under one of `attachmentRoots`. One `substr(...) = ?` clause per
 * root; the roots are bound as parameters, never interpolated.
 */
export function selectManifestReadFiles(
  db: ManifestDbQueryable,
  fileIds: readonly [string, string],
  attachmentRoots: readonly string[],
): ManifestFileRow[] {
  const attachmentClauses = attachmentRoots.map(() => "substr(relativePath, 1, ?) = ?").join(" OR ");
  const rootParams = attachmentRoots.flatMap((root) => [root.length, root]);
  return db
    .prepare(
      `SELECT fileID, domain, relativePath, file FROM Files
           WHERE flags = 1 AND (fileID IN (?, ?) OR (domain = 'MediaDomain' AND (${attachmentClauses})))`,
    )
    .all(fileIds[0], fileIds[1], ...rootParams) as ManifestFileRow[];
}
