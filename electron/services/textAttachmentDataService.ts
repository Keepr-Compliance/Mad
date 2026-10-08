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
 * signed-in user (OWNED_TEXT_ATTACHMENT_BY_ID_SQL). The file must also sit
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

/** Largest file served inline. A larger image shows its placeholder instead. */
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Attachment ids are UUIDs; anything with a path character is refused unread. */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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

  const resolved = path.resolve(row.storage_path);
  if (!isInside(path.resolve(app.getPath("userData")), resolved)) {
    logService.warn(
      "[Attachments] Refused to serve a file outside the app data directory",
      "TextAttachmentData",
    );
    return { success: false, reason: "outside_app_data" };
  }

  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return { success: false, reason: "missing_file" };
    size = stat.size;
  } catch {
    return { success: false, reason: "missing_file" };
  }
  if (size > MAX_INLINE_ATTACHMENT_BYTES) {
    return { success: false, reason: "too_large" };
  }

  try {
    const buffer = await fs.readFile(resolved);
    return { success: true, data: buffer.toString("base64"), mime_type: row.mime_type };
  } catch {
    return { success: false, reason: "missing_file" };
  }
}
