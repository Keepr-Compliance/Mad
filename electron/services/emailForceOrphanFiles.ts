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
 *   2. No attachment row — any user, any kind — still references the path.
 *      Files are content-addressed (sha256), so one file can back a removed
 *      row and a kept one at once; the kept row keeps it.
 *
 * Step 2 runs AFTER the containment await and immediately before the unlink,
 * so no other code in this process runs between the reference check and the
 * removal.
 *
 * Best-effort by contract: it never throws. A failure leaves a file behind,
 * which is the state before this existed; it can never fail a re-cache.
 *
 * Deliberately NOT a folder scan: an on-demand download may be writing a file
 * whose row does not exist yet, and a scan would take it.
 */
import fs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

import { resolveContainedAttachment } from "./atRest/containment";
import { isAttachmentStoragePathReferenced } from "./db/emailForceSetSql";
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
  const result: OrphanFileCleanupResult = { removed: 0, stillReferenced: 0, refused: 0, failed: 0 };
  for (const storedPath of candidates) {
    try {
      let realPath: string;
      try {
        realPath = (await resolveContainedAttachment(storedPath, userData)).realPath;
      } catch {
        result.refused++;
        continue;
      }
      // Synchronous from here to the unlink: nothing can insert a row between.
      if (isAttachmentStoragePathReferenced(db, storedPath)) {
        result.stillReferenced++;
        continue;
      }
      fs.unlinkSync(realPath);
      result.removed++;
    } catch (error) {
      result.failed++;
      logService.warn("Email re-cache: could not remove an orphaned attachment file", "EmailForceOrphanFiles", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
