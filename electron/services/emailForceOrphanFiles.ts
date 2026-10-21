/**
 * BACKLOG-3913 — reclaim the attachment files a Force Re-cache orphaned.
 *
 * The swap removes every unprotected email of the user; `attachments` rows go
 * with them by ON DELETE CASCADE, but the files those rows pointed at stay on
 * disk. This removes them, after the swap has committed, and only when it is
 * safe:
 *
 *   1. The path resolves to a regular file inside an attachment root
 *      (`resolveContainedAttachment`). Anything else is refused untouched.
 *   2. No attachment row — any user, any kind — still references the file
 *      (same file name, any case, absolute or relative). Files are
 *      content-addressed (sha256), so one file can back a removed row and a
 *      kept one at once; the kept row keeps it.
 *
 * BACKLOG-4040: both steps are the shared check in attachmentFileRefs.ts (the
 * same one every other file-delete path uses); step 2 runs after every
 * containment await, synchronously with the unlink.
 *
 * Best-effort by contract: it never throws. A failure leaves a file behind,
 * which is the state before this existed; it can never fail a re-cache.
 *
 * Deliberately NOT a folder scan: an on-demand download may be writing a file
 * whose row does not exist yet, and a scan would take it.
 */
import type { Database as DatabaseType } from "better-sqlite3";

import { ALL_ATTACHMENT_SCOPES, removeUnreferencedAttachmentFiles } from "./attachmentFileRefs";
import logService from "./logService";

export interface OrphanFileCleanupResult {
  /** Files unlinked. */
  removed: number;
  /** Still referenced by an attachment row — left alone. */
  stillReferenced: number;
  /** Missing, outside the attachment roots, or not a regular file — left alone. */
  refused: number;
  /** Unlink attempted and failed — left behind, logged. */
  failed: number;
}

export async function removeOrphanedAttachmentFiles(
  db: DatabaseType,
  candidates: readonly string[],
  userData: string,
): Promise<OrphanFileCleanupResult> {
  const r = await removeUnreferencedAttachmentFiles(db, candidates, { userData, scopes: ALL_ATTACHMENT_SCOPES });
  if (r.failed > 0) {
    logService.warn("Email re-cache: could not remove some orphaned attachment files", "EmailForceOrphanFiles", {
      failed: r.failed,
    });
  }
  return { removed: r.removed, stillReferenced: r.stillReferenced, refused: r.refused, failed: r.failed };
}
