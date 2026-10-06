/**
 * BACKLOG-3731 — why the macOS import did not store a text attachment.
 *
 * The import (`storeAttachments`) skips some chat.db attachments without
 * writing an `attachments` row. Before this, it left no trace, so the submit
 * pre-flight could only say "a photo or file isn't downloaded" for every text
 * that advertised an attachment and had no row — including link previews,
 * which have nothing to send.
 *
 * The import now records each skip on the MESSAGE, as a JSON key in
 * `messages.metadata` (no schema change, and no row in `attachments`, so the
 * import's own dedup sets and every reader of `attachments` are unaffected):
 *
 *   { ..., "attachmentSkips": [{ "name": "IMG_1.HEIC", "reason": "not_downloaded" }] }
 *
 * `messages.metadata` is local only; it is not uploaded with a submission.
 */

import path from "path";

/** The metadata key the import writes and the pre-flight reads. */
export const ATTACHMENT_SKIPS_KEY = "attachmentSkips";

/**
 * Apple stores a link preview (the card under a URL) as an attachment with
 * this extension. The URL itself is the message text, which IS sent.
 */
export const LINK_PREVIEW_EXTENSION = ".pluginpayloadattachment";

export type TextAttachmentSkipReason =
  /** A link preview. Its URL is in the text; nothing is missing. */
  | "link_preview"
  /** A file type the import does not copy (`ALL_SUPPORTED_EXTENSIONS`). */
  | "unsupported_type"
  /** Over the import's `MAX_ATTACHMENT_SIZE` (100 MB). */
  | "too_large"
  /** chat.db names a file that is not on this Mac: Messages never downloaded it. */
  | "not_downloaded"
  /** The file is there but could not be read. */
  | "unreadable";

export interface TextAttachmentSkip {
  /** The attachment's own name (`transfer_name`, else the file name). */
  name: string | null;
  reason: TextAttachmentSkipReason;
}

const REASONS: ReadonlySet<string> = new Set<TextAttachmentSkipReason>([
  "link_preview",
  "unsupported_type",
  "too_large",
  "not_downloaded",
  "unreadable",
]);

function extensionOf(name: string | null | undefined): string {
  return name ? path.extname(name).toLowerCase() : "";
}

/** True for Apple's link-preview attachment. */
export function isLinkPreviewAttachment(name: string | null | undefined): boolean {
  return extensionOf(name) === LINK_PREVIEW_EXTENSION;
}

/**
 * The reason for a file the import's type check rejected. Link previews are
 * told apart from other unsupported types here.
 */
export function unsupportedTypeReason(name: string | null | undefined): TextAttachmentSkipReason {
  return isLinkPreviewAttachment(name) ? "link_preview" : "unsupported_type";
}

/**
 * The reason for a source file `fs.access(R_OK)` refused. Decided on the error
 * code: a missing file is one Messages never downloaded; anything else
 * (permission, I/O) is unreadable.
 */
export function accessErrorReason(error: unknown): TextAttachmentSkipReason {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "not_downloaded" : "unreadable";
}

/**
 * The skips recorded on a message, from its `metadata` (string or object).
 * `null` when the import recorded nothing — a message imported before
 * BACKLOG-3731, or from a source that does not record skips (iPhone sync).
 * Malformed entries are dropped, never thrown on.
 */
export function readAttachmentSkips(metadata: unknown): TextAttachmentSkip[] | null {
  let obj: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      obj = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const list = (obj as Record<string, unknown>)[ATTACHMENT_SKIPS_KEY];
  if (!Array.isArray(list)) return null;
  const out: TextAttachmentSkip[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.reason !== "string" || !REASONS.has(r.reason)) continue;
    out.push({
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : null,
      reason: r.reason as TextAttachmentSkipReason,
    });
  }
  return out;
}
