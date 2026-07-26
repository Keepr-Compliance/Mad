/**
 * Attachment type bucketing (BACKLOG-322 Phase A)
 *
 * Maps a raw MIME type to one of the coarse buckets used by the unified
 * Attachments tab's file-type filter chips and card icons. Kept in one place so
 * the filter and the card always agree on how a file is categorised.
 */

export type AttachmentTypeBucket =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "doc"
  | "other";

/**
 * Bucket a MIME type. Rules (per BACKLOG-322):
 *  - image/*                          → image
 *  - application/pdf                  → pdf
 *  - video/*                          → video
 *  - audio/*                          → audio
 *  - msword | officedocument | text/* → doc  (also opendocument / legacy office)
 *  - anything else                    → other
 */
export function getAttachmentTypeBucket(
  mimeType: string | null | undefined,
): AttachmentTypeBucket {
  const m = (mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || m.endsWith("/pdf")) return "pdf";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (
    m.includes("msword") ||
    m.includes("officedocument") ||
    m.includes("opendocument") ||
    m.includes("ms-excel") ||
    m.includes("ms-powerpoint") ||
    m.startsWith("text/")
  ) {
    return "doc";
  }
  return "other";
}

/** Human-readable label for a bucket (used in filter chips). */
export const ATTACHMENT_TYPE_LABELS: Record<AttachmentTypeBucket, string> = {
  image: "Images",
  pdf: "PDFs",
  video: "Videos",
  audio: "Audio",
  doc: "Docs",
  other: "Other",
};

/** Ordered list of buckets for rendering filter chips. */
export const ATTACHMENT_TYPE_ORDER: AttachmentTypeBucket[] = [
  "image",
  "pdf",
  "video",
  "audio",
  "doc",
  "other",
];
