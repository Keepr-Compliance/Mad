/**
 * SQL for the folder-export attachment pre-flight — BACKLOG-2989 chunk 3.
 *
 * Moved out of `electron/services/folderExport/attachmentHelpers.ts`. The rule
 * and its CI gate are BACKLOG-2959.
 *
 * Both byte-identical to the text they replaced (`e5229c83804f`,
 * `024784cb3c92`).
 */

/**
 * How many attachment rows an email already has. One bound parameter.
 *
 * The export path uses this to decide whether it needs to fetch before
 * packaging: an email that advertises attachments and has zero rows here is one
 * whose files are not on disk yet.
 */
export const ATTACHMENT_COUNT_FOR_EMAIL_SQL =
  "SELECT COUNT(*) as cnt FROM attachments WHERE email_id = ?";

/**
 * The four fields needed to re-fetch one email from its provider. One bound
 * parameter: the email's local id.
 *
 * `external_id` and `source` together identify the message to the provider;
 * `user_id` selects which account's credentials to use. All four are required
 * for a fetch, which is why they travel as a set.
 */
export const EMAIL_FETCH_IDENTITY_SQL =
  "SELECT id, external_id, source, user_id FROM emails WHERE id = ?";
