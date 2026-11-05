/**
 * Which attachment a cleanup question is about — BACKLOG-4120 PR3.
 *
 * Founder rule (2026-11-04): Learn mode downloads ONLY the attachment a
 * question is about, at the moment that question is shown. Other attachments
 * on the same messages are listed by name and never downloaded.
 *
 * "The one" for a cleanup question ("Is this one of your deals?") is the first
 * PDF of the detection's preview messages, newest message first, in the order
 * the preview lists that message's attachments. No PDF -> no attachment: the
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

export function isPdfAttachment(a: { filename: string; mimeType: string | null }): boolean {
  if (a.mimeType) return a.mimeType.toLowerCase() === "application/pdf";
  return /\.pdf$/i.test(a.filename.trim());
}

/**
 * @param emailsNewestFirst the preview messages, newest first (the preview's
 *   own order).
 * @returns the attachment id the question is about, or null.
 */
export function pickQuestionAttachmentId(emailsNewestFirst: QuestionAttachmentEmail[]): string | null {
  for (const email of emailsNewestFirst) {
    const pdf = email.attachments.find(isPdfAttachment);
    if (pdf) return pdf.id;
  }
  return null;
}
