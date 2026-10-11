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
 * signed-in user (OWNED_TEXT_ATTACHMENT_BY_ID_SQL). The file must pass the shared
 * attachment containment check (atRest/containment.ts: a regular file whose real
 * path is inside message-attachments/ or attachments/ under userData), and is
 * refused above a size cap, measured on the decrypted size, before any byte is
 * read. Size and bytes come from one handle through the at-rest reader, so an
 * encrypted (BACKLOG-3816) file is served decrypted. The read is asynchronous.
 */
import { promises as fs } from "fs";
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
import {
  ContainmentError,
  resolveContainedAttachment,
  type ResolvedAttachment,
} from "./atRest/containment";

/** Largest file served inline (decrypted size). A larger image shows its placeholder instead. */
export const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

let maxInlineBytes = MAX_INLINE_ATTACHMENT_BYTES;

/** Tests only: a small cap keeps encrypted fixtures tiny. Pass `null` to restore the default. */
export function setMaxInlineAttachmentBytesForTests(bytes: number | null): void {
  maxInlineBytes = bytes ?? MAX_INLINE_ATTACHMENT_BYTES;
}

/** Attachment ids are UUIDs; anything with a path character is refused unread. */
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** ContainmentError messages that mean "no regular file there", not "outside the folders". */
const MISSING_FILE_MESSAGES = new Set([
  "attachment file not found",
  "attachment path is not a regular file",
]);

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

  // Shared containment (BACKLOG-3816): a regular file whose real path is inside
  // an attachment folder. Links are followed to their target before the check.
  let resolved: ResolvedAttachment;
  try {
    resolved = await resolveContainedAttachment(row.storage_path, app.getPath("userData"));
  } catch (error) {
    if (error instanceof ContainmentError && MISSING_FILE_MESSAGES.has(error.message)) {
      return { success: false, reason: "missing_file" };
    }
    logService.warn(
      "[Attachments] Refused to serve a file outside the attachment folders",
      "TextAttachmentData",
    );
    return { success: false, reason: "outside_app_data" };
  }

  // Open once; the size check and the read use this same handle.
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(resolved.realPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return { success: false, reason: "missing_file" };
    const { size } = await statOpenAttachment(resolved.realPath, handle);
    if (size > maxInlineBytes) {
      return { success: false, reason: "too_large" };
    }
    const buffer = await readOpenAttachment(resolved.realPath, handle);
    return { success: true, data: buffer.toString("base64"), mime_type: row.mime_type };
  } catch {
    return { success: false, reason: "missing_file" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
