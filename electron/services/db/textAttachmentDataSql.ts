/**
 * BACKLOG-3763 — look up ONE text attachment by id, for the signed-in user.
 *
 * The conversation view now receives attachment metadata only, and asks for
 * each image's bytes when it scrolls into view. This statement is the gate on
 * that request: the renderer sends an attachment id, never a path, and the row
 * is returned only when it belongs to a text owned by `user_id`.
 *
 * Ownership follows the BACKLOG-3731 lookup rule (textAttachmentLookupSql.ts),
 * so every attachment the conversation view lists can also be loaded:
 *   1. the row's `message_id` names a message of this user, or
 *   2. the row's `external_message_id` is the Apple id (`messages.external_id`)
 *      of a message of this user.
 * Email attachments (`email_id` set) are never served here.
 *
 * Parameters: attachment id, user id, user id.
 */
export const OWNED_TEXT_ATTACHMENT_BY_ID_SQL = `
  SELECT a.id, a.mime_type, a.file_size_bytes, a.storage_path
  FROM attachments a
  WHERE a.id = ?
    AND a.email_id IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM messages m
        WHERE m.id = a.message_id AND m.user_id = ?
      )
      OR (
        a.external_message_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.external_id = a.external_message_id AND m.user_id = ?
        )
      )
    )
  LIMIT 1
`;

export interface OwnedTextAttachmentRow {
  id: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}
