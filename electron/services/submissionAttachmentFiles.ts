/**
 * BACKLOG-3403 — the attachment facts the uploader and the submission's
 * pre-flight must agree on: where a local file lives, how large a file may be,
 * and the exact object path it is stored under.
 *
 * They used to be private to `supabaseStorageService`. The pre-flight (which
 * decides before anything is sent whether a file can be sent at all) and the
 * manifest (which tells `finalize_submission` the exact path of every object)
 * now need the same answers. A second copy would drift, and a drift would only
 * show up later as a failed upload or an `objects_missing` refusal on every
 * submission. So both import them from here, and the uploader does too.
 */

import * as path from "path";
import { app } from "electron";
import { sanitizeFilenamePreserveCase } from "../utils/fileUtils";

/** The largest file the uploader sends (50 MB). */
export const MAX_ATTACHMENT_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Resolve a local attachment path to an absolute path.
 * - `~/…` → the home directory
 * - absolute → unchanged
 * - relative → under the app's `userData/attachments`
 */
export function resolveAttachmentPath(localPath: string): string {
  if (localPath.startsWith("~")) {
    const home = app.getPath("home");
    return path.join(home, localPath.slice(1));
  }
  if (path.isAbsolute(localPath)) {
    return localPath;
  }
  const userData = app.getPath("userData");
  return path.join(userData, "attachments", localPath);
}

/** Sanitize a filename for storage (URL-safe), keeping its extension. */
function sanitizeStorageFilename(filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const sanitizedBase = sanitizeFilenamePreserveCase(base, false)
    .replace(/__+/g, "_")
    .substring(0, 200);
  return `${sanitizedBase}${ext.toLowerCase()}`;
}

/**
 * BACKLOG-3554: the per-attachment path segment. Local attachment ids are
 * `randomUUID()` values; anything outside `[A-Za-z0-9_-]` is replaced so the
 * id can never add or remove a path segment.
 */
function sanitizeAttachmentIdSegment(attachmentId: string): string {
  return attachmentId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * BACKLOG-3554: object path for one attachment of one submission version:
 * `{org}/{submission}/{local attachment id}/{file name}`.
 *
 * BACKLOG-3403: the ONLY producer of that path. The uploader stores under it
 * and the manifest declares it; the database refuses an attachment row whose
 * path is outside `{org}/{submission}/`.
 */
export function buildAttachmentStoragePath(
  orgId: string,
  submissionId: string,
  attachmentId: string,
  filename: string
): string {
  return `${orgId}/${submissionId}/${sanitizeAttachmentIdSegment(attachmentId)}/${sanitizeStorageFilename(filename)}`;
}
