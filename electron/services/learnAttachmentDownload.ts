/**
 * Learn mode: open the ONE attachment a cleanup question is about — BACKLOG-4120 PR3.
 *
 * Founder rules (2026-11-04): the preview downloads only the attachment the
 * question is about, at the moment the question is shown, and nothing else —
 * no sibling attachment, no prefetch of later questions, no bulk download.
 *
 * This is the only Learn mode code that may reach a mail provider, and it is
 * deliberately NOT imported by `handlers/learnModeHandlers.ts`: main.ts injects
 * it into `registerLearnModeHandlers`, so the Learn handlers keep no static
 * edge to the Gmail/Outlook fetch services (learnModeBoundaries-4120). The
 * handler decides WHICH attachment (gate, membership, "the one"); this file
 * only fetches that one, through the existing single-message paths:
 *
 *   - Gmail: the stored row holds the part id (`provider_attachment_id`), not
 *     the fetch token, which rotates between calls (BACKLOG-3187). The
 *     message's attachment list is read to get a fresh token for THAT part.
 *   - Outlook: the message's attachment list (metadata only, no bytes) gives
 *     the Graph id.
 *
 * Exactly one entry goes to `downloadEmailAttachments`, with `quiet` so no file
 * name reaches a log line and nothing goes to Sentry. Nothing here logs a name,
 * a subject or an address.
 */
import emailAttachmentService, { type EmailAttachmentMeta } from "./emailAttachmentService";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import logService from "./logService";
import { readContainedAttachment, resolveRendererAttachment } from "./atRest/attachmentReader";
import { getQuestionAttachment, type QuestionAttachmentRow } from "./db/learnModeDbService";

/** Largest file the preview opens (base64 over IPC). */
export const LEARN_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export type OpenQuestionAttachmentResult =
  | { ok: true; dataUrl: string; downloadedNow: boolean }
  | { ok: false; reason: "too_large" | "not_available" | "failed" };

export type OpenQuestionAttachment = (
  userId: string,
  row: QuestionAttachmentRow,
) => Promise<OpenQuestionAttachmentResult>;

const MODULE = "LearnAttachment";

function uniqueBy<T>(list: T[], pred: (x: T) => boolean): T | null {
  const hits = list.filter(pred);
  return hits.length === 1 ? hits[0] : null;
}

/** Provider metadata for exactly this attachment, or null. */
async function providerMetaFor(userId: string, row: QuestionAttachmentRow): Promise<EmailAttachmentMeta | null> {
  const externalId = row.external_id;
  if (!externalId) return null;
  const name = row.filename.trim();

  if (row.source === "outlook") {
    if (!(await outlookFetchService.initialize(userId))) return null;
    const list = await outlookFetchService.getAttachments(externalId);
    const hit =
      (row.provider_attachment_id ? list.find((a) => a.id === row.provider_attachment_id) : undefined) ??
      uniqueBy(list, (a) => (a.name ?? "").trim() === name);
    if (!hit) return null;
    return {
      filename: hit.name || row.filename,
      mimeType: hit.contentType || row.mime_type || "application/octet-stream",
      size: hit.size || 0,
      partId: null,
      attachmentId: hit.id,
    };
  }

  if (row.source === "gmail") {
    if (!(await gmailFetchService.initialize(userId))) return null;
    const message = await gmailFetchService.getEmailById(externalId);
    const list = message.attachments ?? [];
    const hit =
      (row.provider_attachment_id ? list.find((a) => a.partId === row.provider_attachment_id) : undefined) ??
      uniqueBy(list, (a) => (a.filename ?? "").trim() === name);
    if (!hit) return null;
    return {
      filename: hit.filename || row.filename,
      mimeType: hit.mimeType || row.mime_type || "application/octet-stream",
      size: hit.size || 0,
      partId: hit.partId || null,
      attachmentId: hit.attachmentId,
    };
  }

  return null;
}

async function readAsDataUrl(storagePath: string, mimeType: string | null): Promise<OpenQuestionAttachmentResult> {
  const resolved = await resolveRendererAttachment(storagePath);
  const bytes = await readContainedAttachment(resolved);
  if (bytes.length > LEARN_ATTACHMENT_MAX_BYTES) return { ok: false, reason: "too_large" };
  return {
    ok: true,
    downloadedNow: false,
    dataUrl: `data:${mimeType || "application/pdf"};base64,${bytes.toString("base64")}`,
  };
}

/**
 * Open (downloading first if needed) exactly this attachment. The caller has
 * already checked the gate and that this row is the question's attachment.
 */
export const openQuestionAttachment: OpenQuestionAttachment = async (userId, row) => {
  try {
    if (row.file_size_bytes !== null && row.file_size_bytes > LEARN_ATTACHMENT_MAX_BYTES) {
      return { ok: false, reason: "too_large" };
    }
    if (row.storage_path) return await readAsDataUrl(row.storage_path, row.mime_type);

    const meta = await providerMetaFor(userId, row);
    if (!meta || !row.external_id || (row.source !== "gmail" && row.source !== "outlook")) {
      return { ok: false, reason: "not_available" };
    }
    await emailAttachmentService.downloadEmailAttachments(userId, row.email_id, row.external_id, row.source, [meta], {
      quiet: true,
    });
    const after = getQuestionAttachment(userId, row.id);
    if (!after?.storage_path) return { ok: false, reason: "failed" };
    const opened = await readAsDataUrl(after.storage_path, after.mime_type);
    return opened.ok ? { ...opened, downloadedNow: true } : opened;
  } catch (error) {
    logService.warn("Learn mode attachment could not be opened", MODULE, {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { ok: false, reason: "failed" };
  }
};
