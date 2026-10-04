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
 * left is one of four reasons:
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
 * The limit and the path resolution are the uploader's own
 * (`submissionAttachmentFiles.ts`), so this check and the upload cannot
 * disagree about the same file.
 */

import * as fs from "fs";
import type { Attachment, Message } from "../types/models";
import {
  MAX_ATTACHMENT_FILE_SIZE,
  resolveAttachmentPath,
} from "./submissionAttachmentFiles";

export type NotIncludedReason =
  | "email_attachment_not_downloaded"
  | "text_attachment_not_on_this_computer"
  | "file_missing_on_this_computer"
  | "file_too_large";

/**
 * One attachment (or one message's attachments) that will not be sent.
 * Display data for the agent and the broker. NEVER logged or sent to Sentry:
 * it holds file names, subjects and contact names.
 */
export interface NotIncludedItem {
  /** Stable across the pre-flight and the submit: `att:`, `msg:` or `email:` + local id. */
  key: string;
  kind: "text" | "email";
  /** Local id of the owning text or email. */
  localMessageId: string;
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

async function defaultStatFile(absolutePath: string): Promise<{ size: number } | null> {
  try {
    const stat = await fs.promises.stat(absolutePath);
    return stat.isFile() ? { size: stat.size } : null;
  } catch {
    return null;
  }
}

/** Replaced in tests through {@link setPreflightStatForTests}. */
let statFile: StatFile = defaultStatFile;

/** Tests only. Pass `null` to restore the real `fs.stat`. */
export function setPreflightStatForTests(fn: StatFile | null): void {
  statFile = fn ?? defaultStatFile;
}

const advertisesAttachment = (value: unknown): boolean =>
  value === true || value === 1 || value === "1";

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
  ): { sentAt: string | null; label: string } => {
    if (kind === "email") {
      const e = emailById.get(localMessageId);
      return {
        sentAt: isoOrNull(e?.sent_at),
        label: typeof e?.subject === "string" ? e.subject : "",
      };
    }
    const m = textById.get(localMessageId);
    return {
      sentAt: isoOrNull(m?.sent_at as unknown),
      label: m ? input.textLabel(m) : "",
    };
  };

  const notIncluded: NotIncludedItem[] = [];
  const sendable: Attachment[] = [];
  const sizeById = new Map<string, number>();

  // Files that have a local path: check them the way the uploader will.
  for (const attachment of input.attachments) {
    const row = attachment as Attachment & { email_id?: string | null };
    const kind: "text" | "email" = row.email_id ? "email" : "text";
    const localMessageId = (row.email_id ?? row.message_id ?? "") as string;
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
    const row = a as Attachment & { email_id?: string | null };
    if (row.email_id) emailsWithRows.add(row.email_id);
    else if (row.message_id) textsWithRows.add(row.message_id);
  }
  for (const m of input.messages) {
    const flagged = advertisesAttachment(
      (m as unknown as Record<string, unknown>).has_attachments
    );
    if (flagged && !textsWithRows.has(m.id)) {
      notIncluded.push({
        key: `msg:${m.id}`,
        kind: "text",
        localMessageId: m.id,
        ...describe("text", m.id),
        filename: null,
        reason: "text_attachment_not_on_this_computer",
        localAttachmentId: null,
      });
    }
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
