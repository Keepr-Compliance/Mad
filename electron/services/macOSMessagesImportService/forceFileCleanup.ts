/**
 * Mac Force Re-import: remove the attachment FILES the swap left unused —
 * BACKLOG-4040 S2 (absorbs BACKLOG-3135).
 *
 * The swap (`swapStagingIntoLive`) replaces the rows in one transaction and
 * hands back the stored paths of the rows it deleted, read inside that
 * transaction. This runs AFTER the swap has committed, never before and never
 * on a failed or cancelled run, and only through the shared check
 * (`removeUnreferencedAttachmentFiles`): a file is deleted only when it lies
 * inside `message-attachments` and NO remaining row of any user or source uses
 * it (case-insensitive file name, any directory).
 *
 * One mechanism covers both toggle states:
 *   - attachments ON: the re-imported rows point at the same files, so only the
 *     files of texts that left the window go;
 *   - "Import message text only" ON: no attachment rows are staged, so every
 *     file only Mac texts used goes. Files shared with iPhone, Google Messages,
 *     email or another user stay.
 *
 * Best-effort: never throws. A crash or failure after the commit leaves files
 * behind (orphans), never a row pointing at a deleted file.
 */
import type { Database as DatabaseType } from "better-sqlite3";

import { removeUnreferencedAttachmentFiles, type FileCleanupResult } from "../attachmentFileRefs";
import { SCOPE_MESSAGE_ATTACHMENTS } from "../atRest/markers";

export async function removeFilesLeftByForceSwap(
  db: DatabaseType,
  removedStoragePaths: readonly string[],
  userData: string,
): Promise<FileCleanupResult> {
  return removeUnreferencedAttachmentFiles(db, removedStoragePaths, {
    userData,
    scopes: [SCOPE_MESSAGE_ATTACHMENTS],
  });
}
