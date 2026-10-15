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

/**
 * BACKLOG-2819: the id an attachment-access audit row is written under.
 * audit_logs.user_id is a foreign key to users_local(id), so only the signed-in
 * session user, confirmed present there, is used. Returns null otherwise.
 * There is deliberately no owner lookup from the attachment: stored files are
 * content-hashed and shared across accounts on one install, so it could name the wrong person.
 */
export function resolveAttachmentAuditUserId(
  db: DatabaseType,
  sessionUserId: string | null | undefined,
): string | null {
  if (!sessionUserId) return null;
  return db.prepare(`SELECT 1 FROM users_local WHERE id = ?`).get(sessionUserId) ? sessionUserId : null;
}
