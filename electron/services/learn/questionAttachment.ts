/**
 * Which attachment a cleanup question is about — BACKLOG-4120 PR3.
 *
 * Founder rule (2026-11-04): Learn mode downloads ONLY the attachment a
 * question is about, at the moment that question is shown. Other attachments
 * on the same messages are listed by name and never downloaded.
 *
 * "The one" for a cleanup question ("Is this one of your deals?") is a PDF of
 * the newest preview message that has one. Within that message, a PDF whose
 * file name carries the deal's street number or a street-name word wins;
 * otherwise the first PDF in the order the preview lists them. No PDF -> no attachment: the
 * question shows the email instead. Bulk questions ("real estate business, or
 * a newsletter / spam?") are about the message, so they never have one.
 *
 * Main decides this; the renderer is told the id and may only ask for that id.
 * Pure: no imports, no I/O.
 */

export interface QuestionAttachmentCandidate {
  id: string;
  filename: string;
  mimeType: string | null;
}

export interface QuestionAttachmentEmail {
  /** Attachments in the order the preview lists them. */
  attachments: QuestionAttachmentCandidate[];
}

/** MIME types that say nothing about the content; the file name decides. */
const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/download"]);

export function isPdfAttachment(a: { filename: string; mimeType: string | null }): boolean {
  const mime = (a.mimeType ?? "").trim().toLowerCase();
  if (mime === "application/pdf") return true;
  return GENERIC_MIME.has(mime) && /\.pdf$/i.test(a.filename.trim());
}

/**
 * The street number and the 3+-letter street-name words of an address's
 * street line ("4120 Canarytest Lane, ..." -> ["4120", "canarytest", "lane"]).
 * Mirrors streetTokenRegex in src/components/settings/learn/learnEmailHtml.ts.
 */
export function streetTokens(address: string | null | undefined): string[] {
  const line = ((address ?? "").split(/[,\n]/)[0] ?? "").trim();
  return line
    .split(/\s+/)
    .filter((w, i) => (i === 0 ? /\d/.test(w) : w.replace(/[^A-Za-z]/g, "").length >= 3))
    .map((w) => w.toLowerCase());
}

function namesTheAddress(filename: string, tokens: string[]): boolean {
  const words = filename.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => words.includes(t.replace(/[^a-z0-9]/g, "")));
}

/**
 * @param emailsNewestFirst the preview messages, newest first (the preview's
 *   own order).
 * @param address the detection's address (both callers pass the same one, so
 *   the preview and the open check agree).
 * @returns the attachment id the question is about, or null.
 */
export function pickQuestionAttachmentId(
  emailsNewestFirst: QuestionAttachmentEmail[],
  address: string | null,
): string | null {
  const tokens = streetTokens(address);
  for (const email of emailsNewestFirst) {
    const pdfs = email.attachments.filter(isPdfAttachment);
    if (pdfs.length === 0) continue;
    return (pdfs.find((a) => namesTheAddress(a.filename, tokens)) ?? pdfs[0]).id;
  }
  return null;
}
