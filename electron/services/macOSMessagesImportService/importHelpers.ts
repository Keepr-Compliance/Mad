/**
 * macOS Messages Import Service - Helper Functions
 * Standalone utility functions used by the import service.
 * Extracted from macOSMessagesImportService.ts for maintainability.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import cliProgress from "cli-progress";
import type { Database as DatabaseType } from "better-sqlite3";

import type {
  ChunkedProcessingOptions,
  ChunkedProcessingResult,
} from "./types";

import {
  MAX_GUID_LENGTH,
  ALL_SUPPORTED_EXTENSIONS,
  MAX_ATTACHMENT_SIZE,
  SUPPORTED_IMAGE_EXTENSIONS,
  MIN_QUERY_BATCH_SIZE,
  REACTION_ASSOCIATED_TYPE_MIN,
  REACTION_ASSOCIATED_TYPE_MAX,
} from "./types";
import { MAC_EPOCH } from "../../constants";
import type { MessageImportFilters } from "./types";

/**
 * Nanoseconds per millisecond — macOS Messages stores dates as nanoseconds
 * since the Apple epoch (2001-01-01).
 */
const NANOS_PER_MS = 1_000_000;

/**
 * The lookback window used when the user has expressed NO preference at all
 * (the `lookbackMonths` key is absent). Matches the Settings dropdown's initial
 * selection.
 *
 * BACKLOG-2561: this lives here, exported, because it previously existed as two
 * independent literal `3`s inside `messageImportHandlers.ts` (the import handler
 * and the effective-window label handler). Two copies of a default is how the
 * import and its own label drift apart.
 */
export const DEFAULT_LOOKBACK_MONTHS = 3;

/**
 * BACKLOG-2561: Resolve the stored `lookbackMonths` preference, distinguishing
 * **"no preference stored"** from **"the user explicitly chose All time"**.
 *
 * These are two different facts and the codebase spells them differently:
 *  - key ABSENT (`undefined`) ⇒ the user never touched the setting ⇒ default.
 *  - explicit `null` ⇒ the user picked "All time" in the dropdown
 *    (`MacOSMessagesImportSettings.tsx` writes `null` for `value === "all"`)
 *    ⇒ unbounded, and it MUST survive as `null`.
 *
 * `??` cannot tell those two apart — `null ?? 3 === 3` — so every reader that
 * used it silently rewrote "All time" into "last 3 months". That was the whole
 * of BACKLOG-2561: the count preview honoured `null`, the import and the label
 * did not, and the user was shown an all-time total next to a 3-month label
 * while receiving 3 months of messages.
 *
 * Note the key can also be absent while the surrounding `filters` object exists:
 * changing only the message cap writes `{ maxMessages: N }`, and the
 * preferences deep-merge leaves `lookbackMonths` absent.
 *
 * @param filters - The stored `messageImport.filters` object (may be absent)
 * @param defaultMonths - Window to use when no preference is stored
 * @returns The months to look back, or `null` for an unbounded "All time" window
 */
export function resolveLookbackMonths(
  filters: { lookbackMonths?: number | null } | null | undefined,
  defaultMonths: number = DEFAULT_LOOKBACK_MONTHS
): number | null {
  if (!filters) return defaultMonths;
  const stored = filters.lookbackMonths;
  // `undefined` = absent = no preference. `null` = an explicit "All time" choice.
  return stored === undefined ? defaultMonths : stored;
}

/**
 * BACKLOG-2276: Compute the Apple-epoch (nanoseconds since 2001-01-01) lower-bound
 * cutoff for the macOS Messages import.
 *
 * Correctness rule (audit completeness):
 *  - When `auditPeriodStart` is provided, the import must reach back at least that
 *    far so a wide audit period is not silently truncated.
 *  - When `lookbackMonths` is also set, we take the EARLIER of the two cutoffs, so
 *    we never omit messages an audit needs AND never regress below the user's
 *    explicit lookback preference.
 *  - Returns `null` (no date filter → import everything) when neither is set.
 *
 * BACKLOG-2561: an EXPLICIT "All time" preference (`lookbackMonths === null`, or a
 * non-positive number) is itself unbounded, so it already reaches back further
 * than any audit period and short-circuits to `null`. Without that short-circuit
 * this function was a fourth reader that could not tell an explicit `null` from an
 * absent key: `null` is falsy, so it contributed no cutoff entry, but the audit
 * entry still did — and `Math.min` of that single entry BOUNDED an "All time"
 * import at the earliest audit start. `computeEffectiveImportWindow` below has
 * always returned an unbounded window for the same input, so the label and the
 * import disagreed. An ABSENT key keeps the previous behaviour: `messagesSyncTrigger`
 * passes `{ auditPeriodStart }` alone and depends on the audit period governing.
 *
 * @param filters - Import filters (lookbackMonths and/or auditPeriodStart)
 * @param now - Reference "now" (injectable for deterministic tests)
 * @returns Apple-epoch nanosecond cutoff, or null when no date filter applies
 */
export function computeImportCutoffNano(
  filters:
    | Pick<MessageImportFilters, "lookbackMonths" | "auditPeriodStart">
    | undefined,
  now: Date = new Date()
): number | null {
  const cutoffs: number[] = [];

  // BACKLOG-2561: explicit "All time" ⇒ unbounded, overrides the audit floor
  // (which only ever WIDENS a bounded window and cannot widen an unbounded one).
  // `undefined` falls through — absence is not a choice.
  const lookback = filters?.lookbackMonths;
  if (lookback === null || (typeof lookback === "number" && lookback <= 0)) {
    return null;
  }

  if (filters?.lookbackMonths && filters.lookbackMonths > 0) {
    const cutoffDate = new Date(now.getTime());
    cutoffDate.setMonth(cutoffDate.getMonth() - filters.lookbackMonths);
    cutoffs.push((cutoffDate.getTime() - MAC_EPOCH) * NANOS_PER_MS);
  }

  if (filters?.auditPeriodStart) {
    const auditDate = new Date(filters.auditPeriodStart);
    if (!isNaN(auditDate.getTime())) {
      cutoffs.push((auditDate.getTime() - MAC_EPOCH) * NANOS_PER_MS);
    }
  }

  if (cutoffs.length === 0) {
    return null;
  }

  // Earlier date = smaller nanosecond value = reaches further back in time.
  return Math.min(...cutoffs);
}

/**
 * Which input governs the effective import lower-bound (BACKLOG-2286).
 * - "audit-period": the earliest transaction audit start reaches further back
 *   than the user's lookback preference, so the audit period widens the window.
 * - "lookback-pref": the user's lookback preference governs (either it already
 *   reaches back as far as / further than the audit period, there are no
 *   transactions, or the pref is "All time").
 */
export type EffectiveImportWindowSource = "audit-period" | "lookback-pref";

/**
 * The effective (display-facing) macOS Messages import window (BACKLOG-2286).
 */
export interface EffectiveImportWindow {
  /**
   * ISO instant of the effective lower bound, or `null` when the window is
   * unbounded ("All time" preference and no earlier audit period applies).
   */
  effectiveCutoffISO: string | null;
  /** Which input governs the effective lower bound. */
  source: EffectiveImportWindowSource;
  /** The user's lookback preference in months (`null` = "All time"). */
  lookbackMonths: number | null;
}

/**
 * BACKLOG-2286: Compute the EFFECTIVE macOS Messages import window for DISPLAY.
 *
 * Mirrors the real import lower-bound (`computeImportCutoffNano`) so the Settings
 * label can tell the truth: post-BACKLOG-2276 the import reaches back to the
 * EARLIER of the user's lookback preference and the earliest transaction
 * audit-period start (the pref is a FLOOR the audit window can widen past).
 *
 * This is DISPLAY-ONLY — it never changes what is imported. It returns the same
 * boundary `computeImportCutoffNano` uses, expressed as an ISO instant plus the
 * governing source so the renderer can pick truthful copy.
 *
 * Rules:
 *  - `lookbackMonths` null/≤0 ("All time") ⇒ unbounded window; the pref already
 *    reaches back further than any audit period ⇒ source "lookback-pref",
 *    cutoff `null`.
 *  - Otherwise compare the lookback cutoff (now − lookbackMonths) with the audit
 *    start. The audit period governs only when it is STRICTLY earlier than the
 *    lookback cutoff (it only ever widens, never narrows). An absent/invalid
 *    audit start falls back to the lookback cutoff.
 *
 * @param params - `lookbackMonths` (null = All time) and `auditStartISO`
 *   (earliest audit-period start; null when there are no transactions).
 * @param now - Reference "now" (injectable for deterministic tests).
 * @returns The effective cutoff ISO (or null), its governing source, and the pref.
 */
export function computeEffectiveImportWindow(
  params: { lookbackMonths: number | null; auditStartISO: string | null },
  now: Date = new Date()
): EffectiveImportWindow {
  const { lookbackMonths, auditStartISO } = params;

  // "All time" preference (null / non-positive months) is already unbounded, so
  // it always reaches back at least as far as any audit period.
  let lookbackCutoff: Date | null = null;
  if (lookbackMonths && lookbackMonths > 0) {
    lookbackCutoff = new Date(now.getTime());
    lookbackCutoff.setMonth(lookbackCutoff.getMonth() - lookbackMonths);
  }

  const parsedAudit = auditStartISO ? new Date(auditStartISO) : null;
  const auditStart =
    parsedAudit && !isNaN(parsedAudit.getTime()) ? parsedAudit : null;

  if (!lookbackCutoff) {
    return { effectiveCutoffISO: null, source: "lookback-pref", lookbackMonths };
  }

  // Audit period governs only when it reaches strictly further back than the pref.
  if (auditStart && auditStart.getTime() < lookbackCutoff.getTime()) {
    return {
      effectiveCutoffISO: auditStart.toISOString(),
      source: "audit-period",
      lookbackMonths,
    };
  }

  return {
    effectiveCutoffISO: lookbackCutoff.toISOString(),
    source: "lookback-pref",
    lookbackMonths,
  };
}

/**
 * BACKLOG-2262: Decide whether an imported message has enough to be stored.
 *
 * A message is retained when it has real (non-whitespace) text OR carries an
 * attachment. Caption-less media (empty decoded text + `cache_has_attachments`)
 * MUST be retained so its attachment can link to a stored parent message.
 *
 * This replaces the previous fragile policy of dropping any message whose decoded
 * text started with "[", which discarded caption-less media, orphaned their
 * attachments, and also dropped legitimate messages like "[link]".
 *
 * @param text - Decoded message text ("" when nothing could be decoded)
 * @param cacheHasAttachments - macOS `message.cache_has_attachments` (>0 = has attachment)
 * @returns True when the message should be stored
 */
export function shouldRetainMessageContent(
  text: string | null | undefined,
  cacheHasAttachments: number
): boolean {
  const hasText = !!(text && text.trim().length > 0);
  const hasAttachment = cacheHasAttachments > 0;
  return hasText || hasAttachment;
}

/**
 * BACKLOG-2262/2280: True when a macOS `message.associated_message_type` value
 * identifies a tapback/reaction row (2000–2005 added, 3000–3005 removed).
 *
 * As of BACKLOG-2280 reaction rows are IMPORTED rather than excluded; this
 * predicate is used at import time to ROUTE reaction rows — they bypass the
 * empty-content retention filter and are tagged with their association
 * type/guid in storeMessages.
 *
 * @param associatedMessageType - The message's associated_message_type (nullable)
 * @returns True when the row is a tapback/reaction row
 */
export function isReactionAssociationType(
  associatedMessageType: number | null | undefined
): boolean {
  if (associatedMessageType === null || associatedMessageType === undefined) {
    return false;
  }
  return (
    associatedMessageType >= REACTION_ASSOCIATED_TYPE_MIN &&
    associatedMessageType <= REACTION_ASSOCIATED_TYPE_MAX
  );
}

/**
 * Create a tqdm-style progress bar for console output
 */
export function createProgressBar(label: string): cliProgress.SingleBar {
  return new cliProgress.SingleBar({
    format: `${label} |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s`,
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
    clearOnComplete: true,
  }, cliProgress.Presets.shades_classic);
}

/**
 * Calculate dynamic query batch size based on total message count.
 * Larger imports use larger batches to reduce overhead from yielding/progress updates.
 *
 * - Under 100K messages: 10% of total (min 10K)
 * - 100K - 200K messages: 15% of total
 * - Over 200K messages: 20% of total
 */
export function calculateQueryBatchSize(totalMessages: number): number {
  let percentage: number;
  if (totalMessages < 100000) {
    percentage = 0.10; // 10%
  } else if (totalMessages <= 200000) {
    percentage = 0.15; // 15%
  } else {
    percentage = 0.20; // 20%
  }

  const calculated = Math.floor(totalMessages * percentage);
  return Math.max(calculated, MIN_QUERY_BATCH_SIZE);
}

/**
 * Yield to event loop - allows UI to remain responsive
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * BACKLOG-2814: the thread_id the importer writes for a macOS chat. One chat
 * row -> one thread, so a group's name maps onto a thread without collapsing.
 */
export function macChatThreadId(chatId: number): string {
  return `macos-chat-${chatId}`;
}

/**
 * BACKLOG-2814: normalize Apple's `chat.display_name` into "the group has a
 * name" or "it does not".
 *
 * Apple represents "unnamed" TWO ways and the empty string is by far the more
 * common one. Measured against a real chat.db (2,886 chats): 2,564 empty
 * strings vs 234 NULLs, with only 88 chats actually named. A check that tested
 * `!= null` alone would therefore treat 2,564 unnamed chats as named and
 * render a blank title where the participant list belongs.
 *
 * Whitespace is trimmed for the same reason: a name of " " is not a name.
 */
export function normalizeChatDisplayName(
  raw: string | null | undefined
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * BACKLOG-2814: rows of Apple's `chat` table carrying a candidate group name.
 */
export interface ChatDisplayNameRow {
  chat_id: number;
  display_name: string | null;
}

/**
 * BACKLOG-2814: reduce raw `chat` rows to the chats that genuinely HAVE a name.
 * Both of Apple's "unnamed" representations (NULL and "") drop out here.
 */
export function buildChatNameMap(
  rows: ChatDisplayNameRow[]
): Map<number, string> {
  const names = new Map<number, string>();
  for (const row of rows) {
    const name = normalizeChatDisplayName(row.display_name);
    if (name !== null) {
      names.set(row.chat_id, name);
    }
  }
  return names;
}

/**
 * BACKLOG-2814: what one name-sync pass changed. Reported so a pass that
 * silently did nothing is distinguishable from one that had nothing to do.
 */
export interface ThreadNameSyncCounts {
  named: number;
  cleared: number;
}

/**
 * BACKLOG-2814: make `message_thread_names` match chat.db for this user's
 * macOS threads.
 *
 * WHY THIS IS NOT PART OF THE MESSAGE INSERT. The importer stores messages with
 * `INSERT OR IGNORE` keyed on the Apple GUID, so an ordinary re-import writes
 * ZERO rows for a thread it already has. A name carried on the message row
 * would therefore never reach an existing user's already-imported threads —
 * only a destructive force reimport would place it. This pass is driven by the
 * `chat` table instead, so it runs to completion whether the run stored six
 * hundred messages or none, and one ordinary re-import names the threads a user
 * already had.
 *
 * IT ALSO CLEARS. A user who removes a group's name in Messages must not keep
 * the old one forever, so any macOS thread of theirs that is no longer named
 * loses its row. Scoped by the `macos-chat-` prefix so it can never reach a
 * thread name from another source.
 *
 * Names are never logged — only counts. A group name is user content.
 */
export function syncMacChatThreadNames(
  db: DatabaseType,
  userId: string,
  chatNames: Map<number, string>
): ThreadNameSyncCounts {
  const upsert = db.prepare(
    `INSERT INTO message_thread_names (user_id, thread_id, display_name, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, thread_id) DO UPDATE SET
       display_name = excluded.display_name,
       updated_at = CURRENT_TIMESTAMP`
  );

  const run = db.transaction((): ThreadNameSyncCounts => {
    let named = 0;
    const keep: string[] = [];
    for (const [chatId, name] of chatNames) {
      const threadId = macChatThreadId(chatId);
      upsert.run(userId, threadId, name);
      keep.push(threadId);
      named++;
    }

    // Everything of this user's that this importer owns and chat.db no longer
    // names. `NOT IN` over a parameter list, chunked: SQLite's variable limit
    // is 999 and a heavy user can name more chats than that.
    let cleared = 0;
    const CHUNK = 400;
    if (keep.length === 0) {
      cleared = db
        .prepare(
          `DELETE FROM message_thread_names
            WHERE user_id = ? AND thread_id LIKE 'macos-chat-%'`
        )
        .run(userId).changes;
    } else {
      // Delete in one statement per chunk of KEEPERS would be wrong (a row kept
      // by chunk A would be deleted by chunk B), so collect the doomed ids first.
      const existing = db
        .prepare(
          `SELECT thread_id FROM message_thread_names
            WHERE user_id = ? AND thread_id LIKE 'macos-chat-%'`
        )
        .all(userId) as Array<{ thread_id: string }>;
      const keepSet = new Set(keep);
      const doomed = existing
        .map((r) => r.thread_id)
        .filter((t) => !keepSet.has(t));
      for (let i = 0; i < doomed.length; i += CHUNK) {
        const slice = doomed.slice(i, i + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        cleared += db
          .prepare(
            `DELETE FROM message_thread_names
              WHERE user_id = ? AND thread_id IN (${placeholders})`
          )
          .run(userId, ...slice).changes;
      }
    }

    return { named, cleared };
  });

  return run();
}

/**
 * Sanitize and validate a string field
 */
export function sanitizeString(
  value: string | null | undefined,
  maxLength: number,
  defaultValue = ""
): string {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  const str = String(value);
  return str.length > maxLength ? str.substring(0, maxLength) : str;
}

/**
 * Validate a GUID/external ID format
 */
export function isValidGuid(guid: string | null | undefined): boolean {
  if (!guid || typeof guid !== "string") return false;
  // Allow alphanumeric, hyphens, underscores, colons, and dots
  // macOS message GUIDs can be various formats
  return (
    guid.length > 0 && guid.length <= MAX_GUID_LENGTH && /^[\w\-:.]+$/.test(guid)
  );
}

/**
 * Check if a file extension is a supported media type
 * TASK-1122: Expanded to include videos, audio, and documents
 */
export function isSupportedMediaType(filename: string | null): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return ALL_SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * One attachment row considered for copying (BACKLOG-2743).
 *
 * Shaped to match both the chat.db estimate query and the RawMacAttachment rows
 * the import already carries, so the SAME eligibility rules drive the
 * selection-time estimate and the pre-flight check.
 */
export interface AttachmentSizeRow {
  filename: string | null;
  transfer_name: string | null;
  total_bytes: number;
  /**
   * macOS message GUID owning this attachment. Needed to recognise attachments
   * that are ALREADY stored — see filterUnstoredAttachments.
   */
  message_guid?: string | null;
}

/**
 * Key identifying a stored attachment: `<macOS message GUID>:<display name>`.
 *
 * Must match the key storeAttachments uses for its `existingByExternalId`
 * lookup, and the `external_message_id` + `filename` pair it writes. The display
 * name is `transfer_name || filename` in BOTH places; keying on the raw
 * `filename` alone would never match a row stored under its transfer name.
 */
export function attachmentStoredKey(
  messageGuid: string | null | undefined,
  displayName: string | null | undefined
): string | null {
  if (!messageGuid || !displayName) return null;
  return `${messageGuid}:${displayName}`;
}

/**
 * Drop attachments that are ALREADY stored, leaving only what a copy would
 * actually write (BACKLOG-2743).
 *
 * WHY THIS EXISTS. The import's attachment query is unbounded — every sync hands
 * `storeAttachments` the user's ENTIRE attachment history, not just what is new.
 * The copy loop then skips the already-stored ones before touching the disk. An
 * estimate that summed the raw set would therefore describe the FIRST import
 * forever: after a large library imported successfully and consumed the space it
 * needed, the next routine sync would re-sum the whole history, compare it to the
 * now-smaller free space, and refuse — permanently, and while genuinely new
 * attachments went unimported.
 *
 * Rows that cannot be keyed (no GUID or no name) are KEPT, so an unrecognised
 * row inflates the estimate rather than silently escaping the guard.
 */
export function filterUnstoredAttachments<T extends AttachmentSizeRow>(
  rows: T[],
  storedKeys: ReadonlySet<string>
): T[] {
  if (storedKeys.size === 0) return rows;
  return rows.filter((row) => {
    const key = attachmentStoredKey(row.message_guid, row.transfer_name || row.filename);
    return key === null || !storedKeys.has(key);
  });
}

/**
 * Drop attachments whose owning message is not stored, leaving only what a copy
 * could actually link and write (BACKLOG-2743).
 *
 * WHY THIS EXISTS — this is the SECOND axis of the mistake `filterUnstoredAttachments`
 * fixes, and it bites harder. The import's attachment SELECT is unbounded, so
 * `storeAttachments` receives attachments belonging to messages OUTSIDE the
 * selected window, which were never imported. The copy loop resolves each
 * attachment's message ID and `continue`s when it finds none, so those bytes are
 * never written.
 *
 * Sizing them anyway breaks the refusal's OWN advice. The renderer's estimate is
 * date-bounded, so narrowing the window shows a small number and re-enables
 * Import — and then the unbounded pre-flight refuses again on the whole history.
 * "Choose a shorter time period", which the refusal block recommends, would be a
 * dead end at every setting, and the refusal would be permanent because it
 * returns before any INSERT.
 *
 * Rows with no GUID are KEPT, matching filterUnstoredAttachments: an
 * unrecognised row inflates the estimate rather than escaping the guard.
 */
export function filterResolvableAttachments<T extends AttachmentSizeRow>(
  rows: T[],
  resolvableGuids: ReadonlySet<string>
): T[] {
  return rows.filter((row) => !row.message_guid || resolvableGuids.has(row.message_guid));
}

/**
 * Result of sizing a set of attachments (BACKLOG-2743).
 */
export interface AttachmentEstimate {
  /** Bytes that would be copied — supported type, under the per-file cap. */
  eligibleBytes: number;
  /** Number of attachments that would be copied. */
  eligibleCount: number;
  /** Rejected by MAX_ATTACHMENT_SIZE (the pre-existing per-file cap). */
  skippedOversizeCount: number;
  /** Rejected by extension (not an importable media type). */
  skippedUnsupportedCount: number;
}

/**
 * Sum the bytes a set of attachments would write to disk (BACKLOG-2743).
 *
 * Applies EXACTLY the two per-file gates the copy loop applies, in the same
 * order: `isSupportedMediaType` on the display filename, then
 * `MAX_ATTACHMENT_SIZE`. Any drift between this and storeAttachments turns the
 * estimate into a number that does not describe the import.
 *
 * The result is an UPPER BOUND. The copy loop additionally deduplicates by file
 * CONTENT HASH, so two distinct attachment rows holding identical bytes are
 * counted twice here but written once. Estimating high is the safe direction
 * for a guard: it can refuse an import that would have just fit, but it can
 * never wave through one that overruns the disk.
 */
export function summarizeAttachmentEstimate(
  rows: AttachmentSizeRow[]
): AttachmentEstimate {
  let eligibleBytes = 0;
  let eligibleCount = 0;
  let skippedOversizeCount = 0;
  let skippedUnsupportedCount = 0;

  for (const row of rows) {
    // Mirrors storeAttachments: transfer_name wins, filename is the fallback.
    const displayName = row.transfer_name || row.filename;
    if (!isSupportedMediaType(displayName)) {
      skippedUnsupportedCount++;
      continue;
    }
    const bytes = Number(row.total_bytes) || 0;
    if (bytes > MAX_ATTACHMENT_SIZE) {
      skippedOversizeCount++;
      continue;
    }
    eligibleBytes += bytes;
    eligibleCount++;
  }

  return {
    eligibleBytes,
    eligibleCount,
    skippedOversizeCount,
    skippedUnsupportedCount,
  };
}

/**
 * Check if a file extension is a supported image type (for inline display)
 */
export function isSupportedImageType(filename: string | null): boolean {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Get MIME type from filename
 * TASK-1122: Expanded to support videos, audio, and documents
 */
export function getMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Images
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    // Videos
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    // Audio
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".caf": "audio/x-caf",
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".rtf": "application/rtf",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Generate a content hash for deduplication (async to avoid blocking)
 */
export async function generateContentHash(filePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

/**
 * Process items in chunks, yielding to the event loop between batches
 * so the UI thread stays responsive during large imports. (TASK-2047)
 *
 * This is the core non-blocking processing primitive. It takes an array of items,
 * processes them in configurable batch sizes, and yields to the event loop between
 * each batch via setImmediate. This prevents the main Electron thread from freezing
 * during imports of 10K+ messages.
 *
 * @param items - Array of items to process
 * @param processBatch - Async function to process a batch of items, returns results
 * @param options - Chunked processing options (batchSize, onProgress, abortSignal)
 * @returns ChunkedProcessingResult with all results and cancellation status
 */
export async function processItemsInChunks<TInput, TOutput>(
  items: TInput[],
  processBatch: (batch: TInput[]) => Promise<TOutput[]>,
  options: ChunkedProcessingOptions = {},
): Promise<ChunkedProcessingResult<TOutput>> {
  const batchSize = options.batchSize ?? 500;
  const results: TOutput[] = [];
  const totalBatches = Math.ceil(items.length / batchSize);
  let batchesProcessed = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    // Check for cancellation via AbortSignal
    if (options.abortSignal?.aborted) {
      return {
        results,
        wasCancelled: true,
        batchesProcessed,
        totalBatches,
      };
    }

    const batch = items.slice(i, i + batchSize);
    const processed = await processBatch(batch);

    // Use push loop instead of spread to avoid stack overflow with large result sets
    for (let j = 0; j < processed.length; j++) {
      results.push(processed[j]);
    }

    batchesProcessed++;

    // Yield to event loop -- allows UI to update and prevents freeze
    await yieldToEventLoop();

    // Emit progress
    options.onProgress?.(batchesProcessed, totalBatches);
  }

  return {
    results,
    wasCancelled: false,
    batchesProcessed,
    totalBatches,
  };
}

// ============================================================================
// Cap' — the admitted set, resolved ONCE for both the run and the estimate
// (BACKLOG-2772)
// ============================================================================

/**
 * The SQL a plan's window and protection compile to.
 *
 * Built in one place because the strings are shared by FIVE queries across two
 * methods — the filtered count, the unprotected count, the Nth-newest OFFSET
 * query, the message fetch, and the attachment sizing. Any drift between them
 * does not merely miscount: the fetch loop runs
 * `while (fetchedCount < totalMessageCount)`, so a mismatch terminates the walk
 * early and silently drops the NEWEST rows.
 */
export interface MessageWindowSql {
  /** `""` or `AND message.date > N`. */
  dateFilterClause: string;
  /**
   * "inside a protected period" — `"0"` when nothing is protected.
   *
   * TOTAL by construction: a NULL `message.date` yields FALSE, never NULL, so
   * this clause and its negation partition the filtered set exactly and
   * `protectedCount + unprotectedCount` always equals `filteredMessageCount`.
   * Without the explicit NULL test, `NOT (date > A)` would be NULL for a
   * null-dated row and it would fall out of BOTH buckets.
   */
  protectedClause: string;
}

/** Compile a plan's window and protected periods to SQL. */
export function buildMessageWindowSql(plan: {
  cutoffNano: number | null;
  protectedSpans: ReadonlyArray<{ startNano: number; endNano: number | null }>;
}): MessageWindowSql {
  return {
    dateFilterClause:
      plan.cutoffNano !== null ? `AND message.date > ${plan.cutoffNano}` : "",
    protectedClause:
      plan.protectedSpans.length === 0
        ? "0"
        : plan.protectedSpans
            .map((span) =>
              span.endNano === null
                ? `(message.date IS NOT NULL AND message.date > ${span.startNano})`
                : `(message.date IS NOT NULL AND message.date > ${span.startNano} AND message.date <= ${span.endNano})`
            )
            .join(" OR "),
  };
}

/** What a plan will actually admit, in numbers and in SQL. */
export interface AdmittedMessageSet {
  /** Messages inside the window (before the cap). */
  filteredMessageCount: number;
  /** Of those, the ones inside an audit period — never counted against the cap. */
  protectedCount: number;
  /** Of those, the ones the cap governs. */
  unprotectedCount: number;
  /** ROWID of the Nth-newest UNPROTECTED message, when the cap bites. */
  capWindowStartRowId: number | null;
  /** The cap applies but its window start could not be resolved. */
  capWindowUnresolved: boolean;
  /** The cap actually truncates. */
  importWasCapped: boolean;
  /** Everything the run admits: protected in full, plus the newest N of the rest. */
  targetMessageCount: number;
  /**
   * The cap as a WHERE term: `AND (message.ROWID >= start OR (protected))`,
   * or `""`. A term rather than a cursor seed because under Cap' the kept set
   * is no longer a contiguous ROWID tail — protected messages can be
   * arbitrarily old.
   */
  capFetchClause: string;
}

/**
 * Resolve what a plan admits — the ONE piece of Cap' arithmetic.
 *
 * ## Why this is a function rather than two copies
 *
 * The run and the SELECTION-TIME ESTIMATE must describe the same import. Before
 * Cap' they trivially did: any non-rejected deal switched the cap off entirely,
 * so both simply counted the window. Under Cap' the common case — deals AND a
 * cap — is exactly where a window count and an admitted count diverge, and the
 * estimate reading only the window would have shown Daniel 707,842 messages in
 * Settings for a run that stores ~50,000 plus his deal periods.
 *
 * Worse than the count, the estimate's attachment bytes feed
 * `evaluateAttachmentSpace` and therefore the space guard, so a window-sized
 * sum can refuse an import (or push "Text only") over files the cap will never
 * fetch.
 *
 * Reimplementing the arithmetic on the estimate side would have rebuilt, inside
 * one PR, the very two-readers defect the PR exists to remove.
 *
 * @param all - `(sql, params?) => rows`, bound to the open chat.db handle
 * @param plan - the resolved plan's cap and protected periods
 * @param sql - the compiled window clauses (`buildMessageWindowSql`)
 * @param filteredMessageCount - messages in the window, already counted
 */
export async function resolveAdmittedMessageSet(
  all: <T>(sql: string, params?: unknown[]) => Promise<T[]>,
  plan: {
    effectiveCap: number | null;
    protectedSpans: ReadonlyArray<{ startNano: number; endNano: number | null }>;
  },
  sql: MessageWindowSql,
  filteredMessageCount: number
): Promise<AdmittedMessageSet> {
  const { dateFilterClause, protectedClause } = sql;
  const maxMessages = plan.effectiveCap;

  // The cap acts on the UNPROTECTED remainder, so that is the number to
  // MEASURE. `protectedCount` is derived from it rather than queried
  // separately — the two are guaranteed to sum by the totality of the clause,
  // and deriving the subordinate number keeps them from ever reporting a
  // partition that does not add up.
  //
  // The `length === 0` branch is a PERFORMANCE skip, not a correctness one:
  // with no spans the clause is "0", so the query would return exactly
  // `filteredMessageCount`.
  let unprotectedCount = filteredMessageCount;
  if (plan.protectedSpans.length > 0) {
    const rows = await all<{ count: number }>(`
      SELECT COUNT(*) as count FROM message
      WHERE message.guid IS NOT NULL ${dateFilterClause} AND NOT (${protectedClause})
    `);
    unprotectedCount = rows[0]?.count || 0;
  }
  const protectedCount = filteredMessageCount - unprotectedCount;

  const capApplies = maxMessages !== null && maxMessages > 0;
  const capWouldTruncate = capApplies && unprotectedCount > (maxMessages as number);

  // BACKLOG-2744: when the cap bites, keep the NEWEST N — not the oldest. The
  // fetch is keyset pagination on ROWID ASC, so simply stopping at N walks
  // upward from 0 and keeps the archive, where the Settings copy promises "most
  // recent". Do NOT fix that by flipping the ORDER BY — the ascending order IS
  // the pagination cursor.
  //
  // BACKLOG-2772 adds `AND NOT (protectedClause)`, and it is load-bearing: the
  // offset is taken against the set the cap governs, so a protected row must
  // not occupy an offset slot. With protected rows counted, the Nth-newest
  // lands too far back and the run keeps FEWER than `maxMessages` unprotected
  // messages while believing it kept exactly that many.
  //
  // The query repeats `guid IS NOT NULL` and takes NO join. The count is
  // join-free, and joining `chat_message_join` here would let a message
  // belonging to two chats occupy two offset slots.
  //
  // THIS RUNS BEFORE THE TARGET COUNT IS DECIDED, AND THAT ORDER IS
  // LOAD-BEARING. The first version of BACKLOG-2744 resolved the window start
  // AFTER the target had been pinned to `maxMessages`, so the unresolved branch
  // fell back to walking from the beginning and still stopped at `maxMessages`
  // rows — reproducing the exact defect it existed to fix.
  let capWindowStartRowId: number | null = null;
  if (capWouldTruncate) {
    const rows = await all<{ start_rowid: number }>(
      `
      SELECT message.ROWID as start_rowid
      FROM message
      WHERE message.guid IS NOT NULL
        ${dateFilterClause}
        AND NOT (${protectedClause})
      ORDER BY message.ROWID DESC
      LIMIT 1 OFFSET ?
    `,
      [(maxMessages as number) - 1]
    );
    capWindowStartRowId = rows[0]?.start_rowid ?? null;
  }

  // The cap is honoured only when we know where its window starts. If it cannot
  // be resolved we admit the FULL window — more recent history than the user
  // asked for, which they never notice — rather than silently handing them the
  // archive. Reachable without a throw: each read runs against a live WAL-mode
  // chat.db that Messages is writing to, so a bulk prune between the count and
  // this query sends the OFFSET out of range.
  const capWindowUnresolved = capWouldTruncate && capWindowStartRowId === null;
  const importWasCapped = capWouldTruncate && !capWindowUnresolved;

  return {
    filteredMessageCount,
    protectedCount,
    unprotectedCount,
    capWindowStartRowId,
    capWindowUnresolved,
    importWasCapped,
    // Cap': every protected message PLUS the newest N of the remainder. The
    // two sets are disjoint by construction, so this is exact.
    targetMessageCount: importWasCapped
      ? protectedCount + (maxMessages as number)
      : filteredMessageCount,
    capFetchClause: importWasCapped
      ? `AND (message.ROWID >= ${capWindowStartRowId} OR (${protectedClause}))`
      : "",
  };
}
