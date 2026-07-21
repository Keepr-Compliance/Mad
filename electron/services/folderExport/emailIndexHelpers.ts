/**
 * Email Index Grouping Helpers (BACKLOG-2161)
 *
 * The transaction audit export summary lists an "Email Threads Index". When the
 * user selects Email Mode = "Thread View", that index must list ONE row per
 * conversation THREAD and its count must equal the "N conversations" the app
 * shows on-screen in the transaction Emails tab — NOT one row per individual
 * email.
 *
 * The on-screen grouping lives in the renderer:
 *   src/components/transactionDetailsModule/components/EmailThreadCard.tsx
 *     → processEmailThreads() / groupEmailsByThread() / getEmailThreadKey()
 *
 * The Electron main process cannot import from `src/` (the renderer), so this
 * module PORTS that exact grouping key + normalization so the exported thread
 * count is identical to the app's displayed conversation count. Keep this in
 * lock-step with getEmailThreadKey/normalizeSubject in EmailThreadCard.tsx.
 *
 * Deliberately does NOT reuse getThreadKey() from textExportHelpers.ts: that key
 * folds sorted sender+recipients into the subject-fallback path, so it can group
 * differently from the app when thread_id is absent. The ticket requires parity
 * with the app's on-screen grouping, so we mirror the renderer's key exactly.
 */

import type { Communication } from "../../types/models";

/**
 * A group of emails that the app renders as one conversation thread.
 */
export interface EmailIndexThread {
  /** Stable grouping key (mirrors the renderer's getEmailThreadKey). */
  key: string;
  /** Representative subject (from the first/oldest email in the thread). */
  subject: string;
  /** Representative sender (from the first/oldest email in the thread). */
  sender: string;
  /** All emails in the thread, sorted chronologically (oldest first). */
  emails: Communication[];
  /** Timestamp of the oldest email (ms). Used for ordering the index. */
  startMs: number;
}

/**
 * Normalize an email subject for thread grouping.
 * MIRRORS normalizeSubject() in EmailThreadCard.tsx: strips repeated
 * Re:/Fwd:/FW: prefixes (case-insensitive) and lowercases.
 */
export function normalizeEmailSubject(subject: string | undefined | null): string {
  if (!subject) return "";

  let normalized = subject.trim();
  const prefixPattern = /^(re:|fwd:|fw:)\s*/i;

  while (prefixPattern.test(normalized)) {
    normalized = normalized.replace(prefixPattern, "").trim();
  }

  return normalized.toLowerCase();
}

/**
 * Grouping key for the email index.
 *
 * Groups emails into the SAME buckets the app groups them on-screen — the
 * renderer's getEmailThreadKey (EmailThreadCard.tsx) keys by:
 *   1. thread_id (canonical)
 *   2. normalized subject (NO participants)
 *   3. per-email id (last resort)
 *
 * KEY-STRING NOTE: for the thread_id case this returns the RAW thread_id (like
 * the pre-BACKLOG-2161 textExportHelpers.getThreadKey), so downstream consumers
 * that surface the key (attachment `threadId` metadata, folder-name fallback)
 * are unchanged. The prefix on the renderer's key ("thread-<id>") is cosmetic —
 * grouping/count parity depends only on emails with the same thread_id sharing
 * a bucket, which both forms guarantee. The ONLY behavioral change vs the old
 * export key is the fallback: normalized subject ALONE (no sender/recipients),
 * so the exported thread count equals the app's on-screen "N conversations".
 */
export function getEmailIndexThreadKey(email: Communication): string {
  if (email.thread_id) {
    return email.thread_id;
  }

  const normalizedSubject = normalizeEmailSubject(email.subject);
  if (normalizedSubject) {
    return `subject-${normalizedSubject}`;
  }

  return `email-${email.id}`;
}

/** Chronological timestamp (ms) for an email; 0 when unknown. */
function emailTimeMs(email: Communication): number {
  return new Date(
    (email.sent_at as string) || (email.received_at as string) || 0
  ).getTime();
}

/**
 * Group emails into conversation threads for the index, mirroring the app's
 * on-screen grouping (processEmailThreads).
 *
 * Ordering: threads are ordered by their OLDEST email (ascending), matching the
 * summary's existing "oldest-first" email ordering so the combined-PDF index
 * rows line up 1:1 with the full thread sections. Within each thread, emails are
 * sorted oldest-first.
 *
 * INPUT CONTRACT (BACKLOG-2161): callers pass the already-email-filtered set
 * (communications.filter(isEmailMessage)). No non-email records are re-admitted
 * here. This is safe because the communications query
 * (communicationDbService.getCommunicationsByTransaction) ALWAYS populates
 * `channel`/`communication_type` via SQL CASE ('email' | m.channel | 'unknown'),
 * so a genuinely UNTYPED record (neither field set) — which the renderer's
 * `processEmailThreads` would treat as email — cannot reach the export. Thus
 * `isEmailMessage` at the export boundary is equivalent to the renderer's
 * `isEmailMessage(c) || (!c.channel && !c.communication_type)` inclusion rule,
 * and the exported thread count equals the on-screen "N conversations".
 *
 * @returns thread groups in stable, oldest-first order.
 */
export function groupEmailsForIndex(emails: Communication[]): EmailIndexThread[] {
  const groups = new Map<string, Communication[]>();

  for (const email of emails) {
    const key = getEmailIndexThreadKey(email);
    const bucket = groups.get(key) || [];
    bucket.push(email);
    groups.set(key, bucket);
  }

  const threads: EmailIndexThread[] = [];
  for (const [key, msgs] of groups) {
    const sorted = [...msgs].sort((a, b) => emailTimeMs(a) - emailTimeMs(b));
    const first = sorted[0];
    threads.push({
      key,
      subject: first.subject || "(No Subject)",
      sender: first.sender || "Unknown",
      emails: sorted,
      startMs: emailTimeMs(first),
    });
  }

  // Oldest-first (stable): order threads by their first email's timestamp.
  threads.sort((a, b) => a.startMs - b.startMs);
  return threads;
}

/**
 * Count of conversation threads for the email index — equals the app's
 * on-screen "N conversations".
 */
export function countEmailIndexThreads(emails: Communication[]): number {
  return groupEmailsForIndex(emails).length;
}
