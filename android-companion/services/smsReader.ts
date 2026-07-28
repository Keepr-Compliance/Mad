/**
 * SMS Reader Service (Android Companion)
 * Reads SMS messages from the Android content provider.
 *
 * TASK-1430: SMS BroadcastReceiver + background sync service
 *
 * Uses react-native-get-sms-android to query the Android SMS inbox.
 * Messages are read since a given timestamp to avoid re-reading old messages.
 *
 * Android SMS types (from content://sms):
 *   1 = MESSAGE_TYPE_INBOX (inbound)
 *   2 = MESSAGE_TYPE_SENT (outbound)
 *   3 = MESSAGE_TYPE_DRAFT
 *   4 = MESSAGE_TYPE_OUTBOX
 *   5 = MESSAGE_TYPE_FAILED
 *   6 = MESSAGE_TYPE_QUEUED
 *
 * We only sync types 1 (inbox/inbound) and 2 (sent/outbound).
 */

import { Platform, NativeModules } from "react-native";
import type { SyncMessage } from "../types/sync";
import { normalizePhoneNumber } from "./phoneNormalization";

/** Raw SMS record from react-native-get-sms-android */
export interface RawSmsRecord {
  _id: string;
  thread_id: string;
  address: string;
  body: string;
  date: string;
  date_sent: string;
  type: string;
  read: string;
}

/** Filter options for querying SMS messages */
interface SmsFilter {
  box: "inbox" | "sent";
  /** Minimum date in milliseconds — only messages after this timestamp */
  minDate?: number;
  /** Maximum number of messages to read */
  maxCount?: number;
}

/**
 * Categorized reason an SMS read FAILED (BACKLOG-2206).
 *
 * A read failure is fundamentally different from a genuine empty inbox: it means
 * we could not trust the read at all (native module gone, permission revoked
 * mid-run, content-resolver / query error, unparseable native payload).
 * Historically every one of these collapsed to `[]`, so a failed read looked
 * identical to "0 new messages" — and a wrong native-module name once returned
 * zero for an entire release invisibly (BACKLOG-1448). Surfacing the reason lets
 * the sync cycle count the cycle as a FAILED reach (so it never masquerades as a
 * healthy idle sync) and lets the UI show an actionable read-error state.
 */
export type SmsReadErrorReason =
  | "module_unavailable"
  | "permission_denied"
  | "query_failed"
  | "parse_failed";

export interface SmsReadError {
  reason: SmsReadErrorReason;
  /** Diagnostic detail (native failure string / exception message). */
  message: string;
}

/**
 * Outcome of an SMS read. A discriminated union so callers MUST distinguish an
 * explicit empty-but-successful read (`{ ok: true, messages: [] }`) from a read
 * FAILURE (`{ ok: false, error }`) — BACKLOG-2206. The read path NEVER swallows a
 * failure into an empty array.
 */
export type SmsReadResult =
  | { ok: true; messages: SyncMessage[] }
  | { ok: false; error: SmsReadError };

/**
 * Map a native `SmsModule.list` failure string to a read-error reason. The
 * react-native-get-sms-android bridge surfaces a permission problem as a string
 * that mentions "permission" (READ_SMS revoked mid-run); anything else is a
 * generic content-resolver / query failure.
 */
function classifyListFailure(fail: string): SmsReadError {
  const message = fail && fail.length > 0 ? fail : "Unknown SMS query failure";
  const reason: SmsReadErrorReason = /permission/i.test(message)
    ? "permission_denied"
    : "query_failed";
  return { reason, message };
}

/**
 * User-facing copy for a read failure (BACKLOG-2206). Co-located with the error
 * type (mirrors accountMatch.ts `accountMatchMessage`) so the manual-sync alert,
 * the onboarding first-sync screen, and the home read-error banner all share one
 * source of truth. Deliberately actionable — the common cause is a revoked SMS
 * permission.
 */
export function smsReadErrorMessage(error: SmsReadError): {
  title: string;
  body: string;
} {
  switch (error.reason) {
    case "permission_denied":
      return {
        title: "Couldn't read messages",
        body: "Keepr Companion no longer has permission to read SMS. Open Settings and allow SMS access so your texts can keep syncing.",
      };
    case "module_unavailable":
      return {
        title: "Couldn't read messages",
        body: "The SMS reader isn't available on this device. Reopen Keepr Companion — if it keeps happening, reinstall the app.",
      };
    case "parse_failed":
    case "query_failed":
    default:
      return {
        title: "Couldn't read messages",
        body: "Keepr Companion hit an error reading your messages, so this sync didn't complete. Reopen the app to try again, and check that SMS permission is still granted.",
      };
  }
}

/**
 * Content-provider sort order for the SMS query.
 *
 * BACKLOG-2199: the native query truncates to `maxCount` rows AFTER applying
 * this sort. The `content://sms` default order is `date DESC` (newest first),
 * so a bounded read returns the NEWEST N messages — NOT a contiguous prefix of
 * the backlog. When the desktop is offline and a large backlog accumulates,
 * advancing the sync cursor past those newest-N would strand the older,
 * never-read messages below the cursor forever (silent loss).
 *
 * We force `date ASC` so a bounded read returns the OLDEST contiguous prefix
 * since the cursor. Advancing the cursor to the newest message we actually
 * read/enqueued is then provably gap-free: every message with an equal or
 * older timestamp has been captured.
 */
const SMS_SORT_OLDEST_FIRST = "date ASC";

/** Android SMS type constants */
const SMS_TYPE_INBOX = "1";
const SMS_TYPE_SENT = "2";

/**
 * Get a reference to the native SMS module.
 *
 * The react-native-get-sms-android library registers itself as "Sms"
 * (see SmsModule.java getName()). Earlier code incorrectly referenced
 * "SmsAndroid" which resolved to undefined, silently returning zero
 * messages on every read.
 *
 * Fix: BACKLOG-1448
 */
function getSmsNativeModule(): typeof NativeModules.Sms | null {
  const mod = NativeModules.Sms;
  if (!mod) {
    console.warn("[SmsReader] Sms native module not available");
    return null;
  }
  return mod;
}

/**
 * Read SMS messages from the Android content provider.
 *
 * BACKLOG-2199: this is a forward-paging cursor. Each box is read
 * OLDEST-first (`date ASC`) and bounded to `maxCount`, so the result is a
 * contiguous prefix of the un-synced backlog rather than the newest N. The
 * caller may lower `maxCount` to apply back-pressure when the local queue is
 * near capacity — the un-read remainder stays in the SMS provider and is
 * picked up on a later cycle (never advance the cursor past it).
 *
 * @param sinceTimestamp - Unix timestamp (ms) — reads messages at/after this
 *   (the native query uses `minDate >=`, so callers pass `lastSynced + 1`)
 * @param maxCount - Maximum number of messages to read per box (default 100)
 * @returns An {@link SmsReadResult}: `{ ok: true, messages }` (oldest-first) on a
 *   successful read — including a genuinely empty inbox — or `{ ok: false, error }`
 *   on a read FAILURE. BACKLOG-2206: a failure is NEVER collapsed to `[]`.
 */
export async function readSmsMessages(
  sinceTimestamp: number,
  maxCount: number = 100
): Promise<SmsReadResult> {
  if (Platform.OS !== "android") {
    // Not an error — there is genuinely nothing to read off-Android.
    console.log("[SmsReader] Skipping — not Android");
    return { ok: true, messages: [] };
  }

  if (!getSmsNativeModule()) {
    // BACKLOG-2206/1448: a missing native module is a FAILURE, not "0 messages".
    // Reporting it as an error stops a wrong/absent module from silently
    // returning zero for an entire release.
    return {
      ok: false,
      error: {
        reason: "module_unavailable",
        message: "Sms native module not available",
      },
    };
  }

  // A non-positive budget means the queue is full — read nothing so the cursor
  // never advances over un-enqueued history (BACKLOG-2199 back-pressure). This
  // is a DELIBERATE empty read, i.e. an explicit empty-SUCCESS, not a failure.
  if (maxCount <= 0) {
    console.log("[SmsReader] maxCount<=0 — back-pressure, reading nothing");
    return { ok: true, messages: [] };
  }

  console.log(
    `[SmsReader] Reading SMS since=${sinceTimestamp} (${sinceTimestamp > 0 ? new Date(sinceTimestamp).toISOString() : "epoch"}) maxCount=${maxCount}`
  );

  // Read from both inbox and sent
  const [inboxResult, sentResult] = await Promise.all([
    readBox({ box: "inbox", minDate: sinceTimestamp, maxCount }),
    readBox({ box: "sent", minDate: sinceTimestamp, maxCount }),
  ]);

  // BACKLOG-2206: if EITHER box failed, the combined read is untrustworthy —
  // surface the failure rather than returning a partial set that would look like
  // a complete read (and let the cursor advance past unread history).
  if (!inboxResult.ok) return inboxResult;
  if (!sentResult.ok) return sentResult;

  // Combine, sort by timestamp ascending
  const allMessages = [...inboxResult.messages, ...sentResult.messages];
  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  console.log(
    `[SmsReader] Found ${inboxResult.messages.length} inbox + ${sentResult.messages.length} sent = ${allMessages.length} total`
  );

  return { ok: true, messages: allMessages };
}

/**
 * Read messages from a specific SMS box (inbox or sent).
 *
 * BACKLOG-2206: resolves to an {@link SmsReadResult}. A native `list()` failure
 * callback, a missing native module, or an unparseable payload each resolve to
 * `{ ok: false, error }` — NEVER to an empty array — so the caller can tell a
 * genuine empty box apart from a failed read.
 */
function readBox(filter: SmsFilter): Promise<SmsReadResult> {
  return new Promise((resolve) => {
    const smsModule = getSmsNativeModule();
    if (!smsModule) {
      resolve({
        ok: false,
        error: {
          reason: "module_unavailable",
          message: "Sms native module not available",
        },
      });
      return;
    }

    const jsonFilter: Record<string, unknown> = {
      box: filter.box,
      maxCount: filter.maxCount ?? 100,
      // BACKLOG-2199: force oldest-first so the maxCount truncation keeps a
      // contiguous prefix of the backlog (see SMS_SORT_OLDEST_FIRST).
      sortOrder: SMS_SORT_OLDEST_FIRST,
    };

    // Filter by date if provided
    if (filter.minDate !== undefined && filter.minDate > 0) {
      jsonFilter.minDate = filter.minDate;
    }

    console.log(
      `[SmsReader] Querying ${filter.box} with filter:`,
      JSON.stringify(jsonFilter)
    );

    smsModule.list(
      JSON.stringify(jsonFilter),
      (fail: string) => {
        // BACKLOG-2206: a native query failure (permission revoked mid-run,
        // content-resolver/cursor error) is a READ FAILURE, not zero results.
        console.error(`[SmsReader] Failed to read ${filter.box}:`, fail);
        resolve({ ok: false, error: classifyListFailure(fail) });
      },
      (_count: number, smsList: string) => {
        try {
          const records = JSON.parse(smsList) as RawSmsRecord[];
          const messages = records
            .filter((r) => r.address && r.body)
            .map((r) => rawToSyncMessage(r, filter.box));
          console.log(
            `[SmsReader] ${filter.box}: ${records.length} raw records -> ${messages.length} valid messages`
          );
          resolve({ ok: true, messages });
        } catch (err) {
          // BACKLOG-2206: an unparseable native payload is a read FAILURE too —
          // do not silently drop it as "0 messages".
          console.error(`[SmsReader] Failed to parse ${filter.box}:`, err);
          resolve({
            ok: false,
            error: {
              reason: "parse_failed",
              message:
                err instanceof Error
                  ? err.message
                  : "Failed to parse SMS payload",
            },
          });
        }
      }
    );
  });
}

/**
 * Convert a raw SMS record to a SyncMessage.
 *
 * Direction is determined primarily by which box was queried (inbox vs sent),
 * since the native module may not always return a reliable `type` field.
 * The `raw.type` is used as a secondary signal only when `box` is not provided.
 *
 * BACKLOG-1459: raw.type was undefined/null for some sent-box queries, causing
 * the `?? SMS_TYPE_INBOX` fallback to mark all messages as inbound.
 *
 * BACKLOG-1493: Ensure sender is always populated. Android SMS content provider
 * may return empty or null address for some message types (carrier alerts,
 * voicemail notifications). We fall back to "unknown" so messages are never
 * silently dropped.
 *
 * Direction mapping (BACKLOG-1495 Data Parsing Spec):
 *   inbox box = inbound (received by user)
 *   sent box  = outbound (sent by user)
 */
export function rawToSyncMessage(raw: RawSmsRecord, box?: "inbox" | "sent"): SyncMessage {
  // Primary: use the box we explicitly queried
  // Fallback: use raw.type from the native module
  const direction: "inbound" | "outbound" = box
    ? (box === "sent" ? "outbound" : "inbound")
    : ((raw.type ?? SMS_TYPE_INBOX) === SMS_TYPE_SENT ? "outbound" : "inbound");

  // Use date_sent if available and non-zero, otherwise use date.
  //
  // BACKLOG-2202: this timestamp is a DEDUP-CRITICAL field. The desktop derives
  // its uniqueness key as SHA-256(`sender|timestamp|body`)
  // (electron/services/localSyncService.ts generateExternalId), so the value
  // MUST be deterministic across independent reads of the same SMS — otherwise
  // the same message hashes to two different external_ids and stores twice
  // (duplicate) instead of being an INSERT-OR-IGNORE no-op.
  const dateSent = parseInt(raw.date_sent, 10);
  const date = parseInt(raw.date, 10);
  const timestamp = dateSent > 0 ? dateSent : date;

  // BACKLOG-1493: Ensure sender always has a value.
  // normalizePhoneNumber handles alphanumeric senders (returns trimmed original)
  // and short codes (returns digits only). If address is still empty/null,
  // fall back to "unknown" so the message is not silently dropped.
  const rawAddress = (raw.address || "").trim();
  const sender = rawAddress.length > 0 ? normalizePhoneNumber(rawAddress) : "unknown";

  // BACKLOG-2199: carry the content-provider row id as a stable, phone-side
  // de-dup key for the local queue. Left undefined when the native module did
  // not supply one, in which case queue de-dup falls back to the composite.
  const smsId =
    raw._id !== undefined && raw._id !== null && String(raw._id).length > 0
      ? String(raw._id)
      : undefined;

  return {
    sender,
    body: raw.body,
    // BACKLOG-2202: fall back to a DETERMINISTIC sentinel (0), never Date.now().
    // `Date.now()` is time-at-read: it made re-reads of the same date-less
    // record (carrier alerts / voicemail rows with no parseable date) hash to a
    // different desktop external_id each cycle, silently duplicating them. `0`
    // is already a legitimate value the mapper can emit today (a literal
    // `date="0"` row yields timestamp 0), so this introduces no new semantics —
    // it only removes the volatility. Real SMS always carry a valid `date`, so
    // this branch is a defensive guard, not a normal path.
    timestamp: isNaN(timestamp) ? 0 : timestamp,
    threadId: raw.thread_id ?? "",
    direction,
    smsId,
  };
}

/**
 * Get the count of unread SMS messages in the inbox.
 * Useful for displaying badge counts or status information.
 */
export async function getUnreadSmsCount(): Promise<number> {
  if (Platform.OS !== "android") {
    return 0;
  }

  const smsModule = getSmsNativeModule();
  if (!smsModule) {
    return 0;
  }

  return new Promise((resolve) => {
    const jsonFilter = JSON.stringify({
      box: "inbox",
      read: 0,
      maxCount: 1000,
    });

    smsModule.list(
      jsonFilter,
      () => resolve(0),
      (count: number) => resolve(count)
    );
  });
}
