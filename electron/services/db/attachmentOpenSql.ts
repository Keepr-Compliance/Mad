/**
 * BACKLOG-3816 S2: the original file name of a stored attachment, for the
 * decrypted copy `attachments:open` hands to the system viewer. Stored files are
 * named by content hash; the viewer should show the name the sender gave it.
 */
import type { Database as DatabaseType } from "better-sqlite3";

export function findAttachmentFilenameByStoragePath(
  db: DatabaseType,
  storagePath: string,
): string | null {
  const row = db
    .prepare(`SELECT filename FROM attachments WHERE storage_path = ? AND filename IS NOT NULL LIMIT 1`)
    .get(storagePath) as { filename: string } | undefined;
  return row?.filename ?? null;
}
