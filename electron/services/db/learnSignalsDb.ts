/**
 * Loaders for Learn's per-email signal measurement — BACKLOG-4257 (M3) PR2.
 *
 * Read only; see learnSignalsSql.ts. Text is capped in SQL to the limits the
 * signal extractor reads anyway (MAX_BODY_CHARS, MAX_ATTACHMENT_TEXT_CHARS),
 * and id lists are sent in chunks of at most SIGNAL_PAGE_SIZE.
 */
import { dbAll } from "./core/dbConnection";
import {
  ANSWERED_BULK_SIGNAL_ROWS_SQL,
  DEAL_LINKED_SIGNAL_PAGE_SQL,
  SIGNAL_ATTACHMENTS_BY_EMAIL_IDS_SQL,
  SIGNAL_EMAILS_BY_IDS_SQL,
} from "./learnSignalsSql";
import { MAX_BODY_CHARS } from "../detectSignals/canonicalText";
import { MAX_ATTACHMENT_TEXT_CHARS } from "../detectSignals/extractSignals";
import type { SignalLoaders } from "../learn/signalScoring";

/** Rows per page and ids per chunk (SR R4: pages <= 200). */
export const SIGNAL_PAGE_SIZE = 200;

/** One message with capped text, as the signal extractor reads it. */
export interface SignalEmailRow {
  id: string;
  subject: string | null;
  sender: string | null;
  /** To + Cc header text. */
  recipients: string | null;
  body_plain: string | null;
  body_html: string | null;
  bulk_mail_headers: string | null;
}

/** An answered sample row; `id` and the text are NULL when the message is no longer cached. */
export interface BulkSignalRow {
  answer: "real_estate" | "newsletter_spam";
  id: string | null;
  subject: string | null;
  sender: string | null;
  recipients: string | null;
  body_plain: string | null;
  body_html: string | null;
  bulk_mail_headers: string | null;
}

export interface SignalAttachmentRow {
  filename: string | null;
  text_content: string | null;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * One page of messages linked to the user's non-rejected deals, ids after
 * `afterId` ('' for the first page), at most `limit` (capped at SIGNAL_PAGE_SIZE).
 */
export function dealLinkedSignalPage(userId: string, afterId: string, limit: number = SIGNAL_PAGE_SIZE): SignalEmailRow[] {
  const n = Math.max(1, Math.min(SIGNAL_PAGE_SIZE, Math.floor(limit)));
  return dbAll<SignalEmailRow>(DEAL_LINKED_SIGNAL_PAGE_SQL, [MAX_BODY_CHARS, MAX_BODY_CHARS, userId, userId, afterId, n]);
}

/** Messages by local id, scoped to the user; unknown ids are absent. Chunked. */
export function signalEmailsByIds(userId: string, ids: readonly string[]): SignalEmailRow[] {
  const out: SignalEmailRow[] = [];
  for (const part of chunks([...new Set(ids)], SIGNAL_PAGE_SIZE)) {
    out.push(...dbAll<SignalEmailRow>(SIGNAL_EMAILS_BY_IDS_SQL, [MAX_BODY_CHARS, MAX_BODY_CHARS, userId, JSON.stringify(part)]));
  }
  return out;
}

/** Attachment filenames + capped text per message id, scoped to the user. Chunked. */
export function signalAttachmentsByEmailIds(userId: string, ids: readonly string[]): Map<string, SignalAttachmentRow[]> {
  const out = new Map<string, SignalAttachmentRow[]>();
  for (const part of chunks([...new Set(ids)], SIGNAL_PAGE_SIZE)) {
    const rows = dbAll<SignalAttachmentRow & { email_id: string }>(SIGNAL_ATTACHMENTS_BY_EMAIL_IDS_SQL, [
      MAX_ATTACHMENT_TEXT_CHARS,
      userId,
      JSON.stringify(part),
    ]);
    for (const r of rows) {
      const list = out.get(r.email_id);
      const a = { filename: r.filename, text_content: r.text_content };
      if (list) list.push(a);
      else out.set(r.email_id, [a]);
    }
  }
  return out;
}

/** The answered sample (real estate + newsletter/spam), with message ids and capped text. */
export function answeredBulkSignalRows(userId: string): BulkSignalRow[] {
  return dbAll<BulkSignalRow>(ANSWERED_BULK_SIGNAL_ROWS_SQL, [MAX_BODY_CHARS, MAX_BODY_CHARS, userId]);
}

/** The four reads one signal pass makes, bound to one user (the handler's wiring). */
export function signalLoadersFor(userId: string): SignalLoaders {
  return {
    bulkRows: () => answeredBulkSignalRows(userId),
    dealLinkedPage: (afterId, limit) => dealLinkedSignalPage(userId, afterId, limit),
    emailsByIds: (ids) => signalEmailsByIds(userId, ids),
    attachmentsByEmailIds: (ids) => signalAttachmentsByEmailIds(userId, ids),
  };
}
