/**
 * BACKLOG-3926 — storage for the folder / label match: which folder or labels each
 * fetched message sits in (`mail_folder_refs`), the per-account folder / label names
 * (`mail_folder_names`), and the folder-match candidate read.
 *
 * The candidate read is runnable on any connection — the dedicated contact query
 * worker's read-only one, or the main connection when no worker ran it (same pattern
 * as addressMatchCandidatesDb.ts). Worker-safe: SQL text only.
 *
 * Folder and label names are user data: nothing here logs them.
 */
import { dbAll, dbRun, dbTransaction } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import type { MailFolderEntry, MailFolderProvider } from "../../utils/mailFolderCatalog";

const CLEAR_REFS_FOR_MESSAGE_SQL = sql`DELETE FROM mail_folder_refs WHERE account_id = ? AND external_id = ?`;
const INSERT_REF_SQL = sql`INSERT OR IGNORE INTO mail_folder_refs (user_id, account_id, external_id, folder_id) VALUES (?, ?, ?, ?)`;
const CLEAR_NAMES_FOR_ACCOUNT_SQL = sql`DELETE FROM mail_folder_names WHERE account_id = ?`;
const INSERT_NAME_SQL = sql`INSERT OR REPLACE INTO mail_folder_names
  (account_id, user_id, provider, folder_id, display_path, segments, is_system, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
const NAMES_FOR_USER_SQL = sql`SELECT account_id, provider, folder_id, display_path, segments, is_system
  FROM mail_folder_names WHERE user_id = ?`;
const FOLDERS_FOR_EMAILS_SQL = sql`SELECT e.id AS email_id, r.account_id, r.folder_id
  FROM json_each(?) j
  JOIN emails e ON e.id = j.value
  JOIN mail_folder_refs r ON r.user_id = e.user_id AND r.external_id = e.external_id`;

/**
 * Replace each message's stored folder ids with its current set. Messages with an
 * empty set get no rows (and lose any old ones: the message was moved out).
 */
export function replaceMailFolderRefs(
  userId: string,
  accountId: string,
  messages: ReadonlyArray<{ externalId: string; folderIds: readonly string[] }>,
): number {
  let written = 0;
  dbTransaction(() => {
    for (const m of messages) {
      if (!m.externalId) continue;
      dbRun(CLEAR_REFS_FOR_MESSAGE_SQL, [accountId, m.externalId]);
      for (const folderId of m.folderIds) {
        written += dbRun(INSERT_REF_SQL, [userId, accountId, m.externalId, folderId]).changes ?? 0;
      }
    }
  });
  return written;
}

/** Replace an account's whole folder / label catalogue. */
export function replaceMailFolderCatalog(
  userId: string,
  accountId: string,
  provider: MailFolderProvider,
  entries: readonly MailFolderEntry[],
): void {
  dbTransaction(() => {
    dbRun(CLEAR_NAMES_FOR_ACCOUNT_SQL, [accountId]);
    for (const e of entries) {
      dbRun(INSERT_NAME_SQL, [
        accountId,
        userId,
        provider,
        e.folderId,
        e.displayPath,
        JSON.stringify(e.segments),
        e.isSystem ? 1 : 0,
      ]);
    }
  });
}

export interface StoredMailFolder extends MailFolderEntry {
  accountId: string;
  provider: MailFolderProvider;
}

function parseSegments(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Every catalogue entry of the user's mailbox accounts. */
export function readMailFolderCatalogForUser(userId: string): StoredMailFolder[] {
  return dbAll<{
    account_id: string;
    provider: MailFolderProvider;
    folder_id: string;
    display_path: string;
    segments: string | null;
    is_system: number;
  }>(NAMES_FOR_USER_SQL, [userId]).map((r) => ({
    accountId: r.account_id,
    provider: r.provider,
    folderId: r.folder_id,
    displayPath: r.display_path,
    segments: parseSegments(r.segments),
    isSystem: r.is_system === 1,
  }));
}

/** (email id, account id, folder id) for the given cached emails. */
export function readMailFoldersForEmails(
  emailIds: readonly string[],
): Array<{ email_id: string; account_id: string; folder_id: string }> {
  if (emailIds.length === 0) return [];
  return dbAll(FOLDERS_FOR_EMAILS_SQL, [JSON.stringify(emailIds)]);
}
