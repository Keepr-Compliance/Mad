/**
 * BACKLOG-3682: where each submitted file came from, and which files the agent
 * left out.
 *
 * - `submission_attachments.message_id` points at the `submission_messages` row
 *   the file came from. The desktop writes it from 2.39 on; older rows are null
 *   and simply show no source.
 * - `transaction_submissions.submission_metadata.excluded_files` lists files the
 *   agent chose to send without (desktop `ExcludedFileRecord`, BACKLOG-3403).
 *   Absent on every older submission.
 *
 * Pure functions only; the components render the returned strings as text.
 */

export interface SourceMessage {
  id: string;
  channel: string | null;
  direction: string | null;
  subject: string | null;
  sent_at: string | null;
  participants: {
    from?: string;
    to?: string | string[];
    from_name?: string;
    to_names?: Record<string, string>;
    chat_members?: string[];
    chat_member_names?: Record<string, string>;
  } | null;
}

export interface AttachmentSource {
  /** ISO timestamp of the message the file came with, if known. */
  sentAt: string | null;
  /** Who sent it: a contact name, a phone number or an email sender. */
  sender: string | null;
  /** "Text" or `Email "<subject>"`. */
  source: string;
}

const NOT_A_PERSON = new Set(['me', 'unknown', '']);

/** Phone/handle -> name, from every message that names one (as MessageList does). */
function buildNameMap(messages: SourceMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const msg of messages) {
    const p = msg.participants;
    if (!p) continue;
    if (p.from && p.from_name) names.set(p.from, p.from_name);
    for (const [handle, name] of Object.entries(p.to_names ?? {})) {
      if (handle && name) names.set(handle, name);
    }
    for (const [handle, name] of Object.entries(p.chat_member_names ?? {})) {
      if (handle && name) names.set(handle, name);
    }
  }
  return names;
}

/** `Jane Doe <jane@x.com>` -> `Jane Doe`; a bare address stays as it is. */
function emailSenderName(raw: string): string {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  if (match && match[1].trim()) return match[1].trim();
  return raw.trim();
}

function senderOf(msg: SourceMessage, names: Map<string, string>): string | null {
  const p = msg.participants;
  if (msg.channel === 'email') {
    return p?.from ? emailSenderName(p.from) || null : null;
  }
  if (msg.direction === 'outbound') {
    return p?.from_name || 'Agent';
  }
  if (p?.from_name) return p.from_name;
  if (p?.from && !NOT_A_PERSON.has(p.from)) return names.get(p.from) ?? p.from;
  return null;
}

function sourceOf(msg: SourceMessage): string {
  if (msg.channel === 'email') {
    const subject = msg.subject?.trim();
    return subject ? `Email "${subject}"` : 'Email (no subject)';
  }
  return 'Text';
}

/**
 * Attachment id -> its source message details. Only messages passed in are
 * used, so a channel the org has hidden from brokers never contributes a
 * sender or subject.
 */
export function buildAttachmentSources(
  attachments: { id: string; message_id?: string | null }[],
  messages: SourceMessage[]
): Record<string, AttachmentSource> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const names = buildNameMap(messages);
  const out: Record<string, AttachmentSource> = {};
  for (const a of attachments) {
    if (!a.message_id) continue;
    const msg = byId.get(a.message_id);
    if (!msg) continue;
    out[a.id] = { sentAt: msg.sent_at ?? null, sender: senderOf(msg, names), source: sourceOf(msg) };
  }
  return out;
}

export type ExcludedReason =
  | 'email_attachment_not_downloaded'
  | 'text_attachment_not_on_this_computer'
  | 'file_missing_on_this_computer'
  | 'file_too_large';

export interface ExcludedFile {
  filename: string | null;
  kind: 'text' | 'email';
  message_id: string | null;
  sent_at: string | null;
  source_label: string;
  reason: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * `submission_metadata.excluded_files`, validated. Anything that is not the
 * shape the desktop writes is dropped, never thrown on.
 */
export function readExcludedFiles(metadata: unknown): ExcludedFile[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const list = (metadata as { excluded_files?: unknown }).excluded_files;
  if (!Array.isArray(list)) return [];
  const out: ExcludedFile[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (r.kind !== 'text' && r.kind !== 'email') continue;
    out.push({
      filename: str(r.filename),
      kind: r.kind,
      message_id: str(r.message_id),
      sent_at: str(r.sent_at),
      source_label: str(r.source_label) ?? '',
      reason: str(r.reason) ?? '',
    });
  }
  return out;
}

export function excludedReasonText(reason: string): string {
  switch (reason) {
    case 'email_attachment_not_downloaded':
      return "Couldn't be downloaded from the agent's mailbox";
    case 'text_attachment_not_on_this_computer':
      return "Wasn't downloaded to the agent's computer";
    case 'file_missing_on_this_computer':
      return "No longer on the agent's computer";
    case 'file_too_large':
      return 'Larger than 50 MB';
    default:
      return 'Not sent';
  }
}

/** The source line for an excluded file; the label is dropped for a hidden channel. */
export function excludedSourceText(file: ExcludedFile, showLabel: boolean): string {
  const label = showLabel ? file.source_label.trim() : '';
  if (file.kind === 'email') return label ? `Email "${label}"` : 'An email';
  return label ? `Text with ${label}` : 'A text';
}

/** Fallback name when the desktop recorded none (an un-downloaded text photo). */
export function excludedFileName(file: ExcludedFile): string {
  return file.filename ?? (file.kind === 'text' ? 'A photo or file' : 'An attachment');
}

/** Local date + time, as the message list shows it. */
export function formatSourceTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Oct 2, 2026, 3:15 PM · From Jane Doe · Email "Contract"" */
export function sourceLine(s: AttachmentSource): string {
  const parts: string[] = [];
  const when = formatSourceTime(s.sentAt);
  if (when) parts.push(when);
  if (s.sender) parts.push(`From ${s.sender}`);
  parts.push(s.source);
  return parts.join(' · ');
}
