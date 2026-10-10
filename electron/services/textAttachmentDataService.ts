/**
 * BACKLOG-3763 — serve ONE text attachment's bytes, on demand.
 *
 * The conversation view used to receive every attachment of a conversation as
 * base64 in one IPC reply, read synchronously on the main thread. It now gets
 * metadata only and asks for an image's bytes when that image scrolls into
 * view. This module answers that request.
 *
 * The request carries an attachment id and nothing else. The file path comes
 * from the database row, and the row is returned only when it belongs to the
 * signed-in user (OWNED_TEXT_ATTACHMENT_BY_ID_SQL). The file's real path must also sit
 * inside the app's data directory, and is refused above a size cap before any
 * byte is read. The read is asynchronous.
 */
import { promises as fs } from "fs";
import path from "path";
import { app } from "electron";
import databaseService from "./databaseService";
import sessionService from "./sessionService";
import logService from "./logService";
import {
  OWNED_TEXT_ATTACHMENT_BY_ID_SQL,
  type OwnedTextAttachmentRow,
} from "./db/textAttachmentDataSql";
import type { TextAttachmentDataResult } from "../types/ipc/common";
import { readOpenAttachment, statOpenAttachment } from "./atRest/attachmentReader";

/** Largest file served inline. A larger image shows its placeholder instead. */
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Attachment ids are UUIDs; anything with a path character is refused unread. */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * True when `child` is strictly inside `parent`. Both must already be real
 * (symlink-resolved) paths. Windows paths compare case-insensitively, and the
 * prefix check includes the separator so "/data-evil" is not inside "/data".
 */
export function isInside(parent: string, child: string, caseInsensitive = process.platform === "win32"): boolean {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const root = norm(parent).replace(/[\\/]+$/, "");
  const target = norm(child);
  return target.length > root.length + 1 && target.startsWith(root + path.sep);
}

export async function getTextAttachmentData(
  attachmentId: unknown,
): Promise<TextAttachmentDataResult> {
  if (typeof attachmentId !== "string" || !ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    return { success: false, reason: "invalid_id" };
  }

  const session = await sessionService.loadSession();
  const userId = session?.user?.id;
  if (!userId) {
    return { success: false, reason: "not_signed_in" };
  }

  const db = databaseService.getRawDatabase();
  const row = db
    .prepare(OWNED_TEXT_ATTACHMENT_BY_ID_SQL)
    .get(attachmentId, userId, userId) as OwnedTextAttachmentRow | undefined;
  if (!row || !row.storage_path) {
    return { success: false, reason: "not_found" };
  }

  // Resolve both sides to real paths so a link inside app data cannot lead out.
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fs.realpath(app.getPath("userData"));
    realFile = await fs.realpath(path.resolve(row.storage_path));
  } catch {
    return { success: false, reason: "missing_file" };
  }
  if (!isInside(realRoot, realFile)) {
    logService.warn(
      "[Attachments] Refused to serve a file outside the app data directory",
      "TextAttachmentData",
    );
    return { success: false, reason: "outside_app_data" };
  }

  // Refuse anything that is not a regular file BEFORE opening: opening a FIFO
  // can block forever and a device node can yield endless bytes.
  try {
    const pre = await fs.stat(realFile);
    if (!pre.isFile()) return { success: false, reason: "missing_file" };
  } catch {
    return { success: false, reason: "missing_file" };
  }

  // Open once; the size check and the read use this same handle.
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(realFile, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return { success: false, reason: "missing_file" };
    // BACKLOG-3816: stored attachments may be KEPRENC ciphertext. Size and
    // bytes come from the shared at-rest reader, on this same handle, so the
    // cap is measured on the plaintext and the renderer gets decrypted bytes.
    const { size } = await statOpenAttachment(realFile, handle);
    if (size > MAX_INLINE_ATTACHMENT_BYTES) {
      return { success: false, reason: "too_large" };
    }
    const buffer = await readOpenAttachment(realFile, handle);
    return { success: true, data: buffer.toString("base64"), mime_type: row.mime_type };
  } catch {
    return { success: false, reason: "missing_file" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
