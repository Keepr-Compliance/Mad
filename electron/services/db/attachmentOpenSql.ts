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
 * BACKLOG-2819: the id an attachment-access audit row is written under. audit_logs.user_id
 * is a foreign key to users_local(id), so only an id that exists there can be used.
 *
 * Preference order: the signed-in session user, then the owner of a transaction the
 * attachment is linked to. Returns null when neither is a users_local row.
 */
export function resolveAttachmentAuditUserId(
  db: DatabaseType,
  storagePath: string,
  sessionUserId: string | null | undefined,
): string | null {
  const exists = db.prepare(`SELECT 1 FROM users_local WHERE id = ?`);
  if (sessionUserId && exists.get(sessionUserId)) return sessionUserId;

  const row = db
    .prepare(
      `SELECT t.user_id AS user_id
         FROM attachments a
         JOIN communications c
           ON (a.email_id IS NOT NULL AND c.email_id = a.email_id)
           OR (a.message_id IS NOT NULL AND c.message_id = a.message_id)
         JOIN transactions t ON t.id = c.transaction_id
         JOIN users_local u ON u.id = t.user_id
        WHERE a.storage_path = ?
        LIMIT 1`,
    )
    .get(storagePath) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}
