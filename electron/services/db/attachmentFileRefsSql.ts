/**
 * The database half of the shared "is this attachment file still used" check —
 * BACKLOG-4040. The rule, and why it is safe, is in
 * electron/services/attachmentFileRefs.ts.
 */
import * as path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

import { sql } from "./core/sqlText";

/**
 * Every stored attachment path, of any user and any source (Mac texts, iPhone,
 * Google Messages, email). Read once per check; the file names are compared in
 * JavaScript. A row with no path references no file.
 */
export const ATTACHMENT_STORAGE_PATHS_SQL = sql`
    SELECT storage_path FROM attachments WHERE storage_path IS NOT NULL
  `;

/**
 * The one definition of "the same file": the file name (after `\` -> `/`),
 * case-folded. Every writer names a file `<sha256><ext>`, so the name
 * identifies the bytes; the directory and the extension's case do not.
 * Used for LOOKUP only — never to build a path that is deleted.
 */
export function attachmentFileKey(storedPath: string): string {
  return path.posix.basename(storedPath.replace(/\\/g, "/")).toLowerCase();
}

/** The keys of every file some attachments row points at. One pass over the table. */
export function referencedAttachmentFileKeys(db: DatabaseType): Set<string> {
  const keys = new Set<string>();
  const rows = db.prepare(ATTACHMENT_STORAGE_PATHS_SQL).pluck().all() as unknown[];
  for (const p of rows) {
    if (typeof p === "string" && p.length > 0) keys.add(attachmentFileKey(p));
  }
  return keys;
}

/** Of `paths`, the ones NO attachments row (any user, any source) points at. */
export function unreferencedAttachmentPaths(db: DatabaseType, paths: readonly string[]): Set<string> {
  const keys = referencedAttachmentFileKeys(db);
  const out = new Set<string>();
  for (const p of paths) {
    if (!keys.has(attachmentFileKey(p))) out.add(p);
  }
  return out;
}
