/**
 * BACKLOG-3403 / BACKLOG-3681 — which attachments cannot be sent, decided
 * BEFORE anything is sent.
 *
 * Founder 2026-10-04: warn ahead of time, let the agent go back or continue;
 * on continue, send the rest and record what was left out. A file that can
 * never be sent does not block the submission. A network or server failure
 * is different and still fails the whole submission.
 *
 * ORDER (founder 58695a05): this runs AFTER the on-demand email attachment
 * download (`downloadMissingEmailAttachments`). An attachment that simply had
 * not been downloaded yet is downloaded first and is never flagged. What is
 * left is one of these reasons:
 *
 *   email_attachment_not_downloaded       the download failed (or the mailbox
 *                                         was unreachable): its row still has
 *                                         no local file
 *   text_attachment_not_on_this_computer  a text advertises an attachment and
 *                                         this computer has no attachment row
 *                                         for it (MECHANISM UNTRACED for why
 *                                         the file is absent, e.g. iCloud)
 *   file_missing_on_this_computer         the row names a local file that is
 *                                         no longer there
 *   file_too_large                        over the uploader's 50 MB limit
 *
 * BACKLOG-3731: for a text with no attachment row, the macOS import now
 * records why it skipped each file (`textAttachmentSkips.ts`), and the item
 * carries that reason instead: not downloaded by Messages, over the import's
 * 100 MB limit, a type the import does not copy, or unreadable. A link preview
 * is never listed. `text_attachment_not_on_this_computer` remains for a text
 * with no recorded reason (imported before this, or iPhone sync).
 *
 * The limit and the path resolution are the uploader's own
 * (`submissionAttachmentFiles.ts`), so this check and the upload cannot
 * disagree about the same file.
 */

import { statStoredAttachment } from "./atRest/attachmentReader";
import type { Attachment, Message } from "../types/models";
import type { SubmissionAttachment } from "./db/submissionDbService";
import {
  MAX_ATTACHMENT_FILE_SIZE,
  resolveAttachmentPath,
} from "./submissionAttachmentFiles";
import {
  readAttachmentSkips,
  type TextAttachmentSkipReason,
} from "./textAttachmentSkips";

export type NotIncludedReason =
  | "email_attachment_not_downloaded"
  /** No reason was recorded at import (imported before BACKLOG-3731, or iPhone sync). */
  | "text_attachment_not_on_this_computer"
  | "file_missing_on_this_computer"
  | "file_too_large"
  // BACKLOG-3731: the reason the macOS import recorded when it skipped the file.
  | "text_attachment_not_downloaded_by_messages"
  | "text_attachment_too_large_to_import"
  | "text_attachment_type_not_imported"
  | "text_attachment_unreadable";

/**
 * BACKLOG-3731: the not-included reason for each recorded import skip.
 * `link_preview` has none: a link preview is never listed, because its URL is
 * the message text and is sent.
 */
export const SKIP_REASON_TO_NOT_INCLUDED: Record<
  Exclude<TextAttachmentSkipReason, "link_preview">,
  NotIncludedReason
> = {
  not_downloaded: "text_attachment_not_downloaded_by_messages",
  too_large: "text_attachment_too_large_to_import",
  unsupported_type: "text_attachment_type_not_imported",
  unreadable: "text_attachment_unreadable",
};

/**
 * One attachment (or one message's attachments) that will not be sent.
 * Display data for the agent and the broker. NEVER logged or sent to Sentry:
 * it holds file names, subjects and contact names.
 */
export interface NotIncludedItem {
  /**
   * Stable across the pre-flight and the submit: `att:`, `msg:` or `email:` +
   * local id, or `skip:<local message id>:<n>` for a recorded import skip.
   */
  key: string;
  kind: "text" | "email";
  /** Local id of the owning text or email. */
  localMessageId: string;
  /** BACKLOG-3731: the conversation, for grouping the list. Null when unknown. */
  threadId: string | null;
  sentAt: string | null;
  /** Email subject, or the text's other party. */
  label: string;
  filename: string | null;
  reason: NotIncludedReason;
  localAttachmentId: string | null;
}

/** An email attachment row that still has no local file after the download. */
export interface UndownloadedEmailAttachment {
  id: string;
  email_id: string;
  filename: string | null;
}

export interface PreflightInput {
  messages: Message[];
  emails: Record<string, unknown>[];
  attachments: Attachment[];
  undownloadedEmailAttachments: UndownloadedEmailAttachment[];
  /** The text's other party, as the agent would recognise it. */
  textLabel: (message: Message) => string;
}

export interface PreflightResult {
  sendable: Attachment[];
  notIncluded: NotIncludedItem[];
  /** Size on disk of each sendable attachment, by local id. */
  sizeById: Map<string, number>;
}

/** `null` when the file cannot be read (missing, permission). */
export type StatFile = (absolutePath: string) => Promise<{ size: number } | null>;

/**
 * BACKLOG-3816 S2: the PLAINTEXT size (from the KEPRENC header for an encrypted
 * file), which is what the uploader sends and what the 50 MB cap applies to.
 */
async function defaultStatFile(absolutePath: string): Promise<{ size: number } | null> {
  return statStoredAttachment(absolutePath);
}

/** Replaced in tests through {@link setPreflightStatForTests}. */
let statFile: StatFile = defaultStatFile;

/** Tests only. Pass `null` to restore the real `fs.stat`. */
export function setPreflightStatForTests(fn: StatFile | null): void {
  statFile = fn ?? defaultStatFile;
}

const advertisesAttachment = (value: unknown): boolean =>
  value === true || value === 1 || value === "1";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function runSubmissionPreflight(
  input: PreflightInput
): Promise<PreflightResult> {
  const textById = new Map(input.messages.map((m) => [m.id, m]));
  const emailById = new Map<string, Record<string, unknown>>();
  for (const e of input.emails) {
    if (typeof e.id === "string") emailById.set(e.id, e);
  }

  const describe = (
    kind: "text" | "email",
    localMessageId: string
  ): { sentAt: string | null; label: string; threadId: string | null } => {
    if (kind === "email") {
      const e = emailById.get(localMessageId);
      return {
        sentAt: isoOrNull(e?.sent_at),
        label: typeof e?.subject === "string" ? e.subject : "",
        threadId: stringOrNull(e?.thread_id),
      };
    }
    const m = textById.get(localMessageId);
    return {
      sentAt: isoOrNull(m?.sent_at as unknown),
      label: m ? input.textLabel(m) : "",
      threadId: stringOrNull((m as unknown as Record<string, unknown> | undefined)?.thread_id),
    };
  };

  const notIncluded: NotIncludedItem[] = [];
  const sendable: Attachment[] = [];
  const sizeById = new Map<string, number>();

  // Files that have a local path: check them the way the uploader will.
  for (const attachment of input.attachments) {
    const row = attachment as SubmissionAttachment;
    const kind: "text" | "email" = row.email_id ? "email" : "text";
    // BACKLOG-3731: a text row belongs to the text the shared lookup resolved.
    const localMessageId = (row.email_id ?? row.resolved_message_id ?? "") as string;
    const stat = await statFile(resolveAttachmentPath(row.storage_path || ""));
    let reason: NotIncludedReason | null = null;
    if (!row.storage_path || stat === null) reason = "file_missing_on_this_computer";
    else if (stat.size > MAX_ATTACHMENT_FILE_SIZE) reason = "file_too_large";
    if (reason === null) {
      sendable.push(attachment);
      if (stat) sizeById.set(row.id, stat.size);
      continue;
    }
    notIncluded.push({
      key: `att:${row.id}`,
      kind,
      localMessageId,
      ...describe(kind, localMessageId),
      filename: row.filename || null,
      reason,
      localAttachmentId: row.id,
    });
  }

  // Email attachment rows the download could not fill.
  const emailsWithUndownloaded = new Set<string>();
  for (const u of input.undownloadedEmailAttachments) {
    if (!emailById.has(u.email_id)) continue; // outside the window
    emailsWithUndownloaded.add(u.email_id);
    notIncluded.push({
      key: `att:${u.id}`,
      kind: "email",
      localMessageId: u.email_id,
      ...describe("email", u.email_id),
      filename: u.filename || null,
      reason: "email_attachment_not_downloaded",
      localAttachmentId: u.id,
    });
  }

  // Messages that advertise an attachment and have no row at all.
  const textsWithRows = new Set<string>();
  const emailsWithRows = new Set<string>();
  for (const a of input.attachments) {
    const row = a as SubmissionAttachment;
    if (row.email_id) emailsWithRows.add(row.email_id);
    // BACKLOG-3731: keyed on the resolved text, with no fallback to message_id.
    else if (row.resolved_message_id) textsWithRows.add(row.resolved_message_id);
  }
  for (const m of input.messages) {
    const flagged = advertisesAttachment(
      (m as unknown as Record<string, unknown>).has_attachments
    );
    if (!flagged || textsWithRows.has(m.id)) continue;
    // BACKLOG-3731: what the import recorded when it skipped this text's files.
    const skips = readAttachmentSkips((m as unknown as Record<string, unknown>).metadata);
    if (skips === null || skips.length === 0) {
      // Nothing recorded: still listed, worded without claiming a cause.
      notIncluded.push({
        key: `msg:${m.id}`,
        kind: "text",
        localMessageId: m.id,
        ...describe("text", m.id),
        filename: null,
        reason: "text_attachment_not_on_this_computer",
        localAttachmentId: null,
      });
      continue;
    }
    // One line per skipped file. A link preview is never listed: its URL is
    // the text, which is sent. Other files on the same text still are.
    skips.forEach((skip, index) => {
      if (skip.reason === "link_preview") return;
      notIncluded.push({
        key: `skip:${m.id}:${index}`,
        kind: "text",
        localMessageId: m.id,
        ...describe("text", m.id),
        filename: skip.name,
        reason: SKIP_REASON_TO_NOT_INCLUDED[skip.reason],
        localAttachmentId: null,
      });
    });
  }
  for (const [id, e] of emailById) {
    if (
      advertisesAttachment(e.has_attachments) &&
      !emailsWithRows.has(id) &&
      !emailsWithUndownloaded.has(id)
    ) {
      notIncluded.push({
        key: `email:${id}`,
        kind: "email",
        localMessageId: id,
        ...describe("email", id),
        filename: null,
        reason: "email_attachment_not_downloaded",
        localAttachmentId: null,
      });
    }
  }

  notIncluded.sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? "") || a.key.localeCompare(b.key));
  return { sendable, notIncluded, sizeById };
}
