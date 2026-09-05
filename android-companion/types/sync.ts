/**
 * Sync Protocol Types (Android Companion)
 * Matches the Electron types in electron/types/localSync.ts.
 *
 * TASK-1429: Android Companion — Encrypted HTTP Transport
 * BACKLOG-1449: Android contacts sync
 */

import type { SyncContact } from "./contacts";

// ============================================
// MESSAGE TYPES
// ============================================

/**
 * A single SMS/MMS message to sync to the desktop.
 */
export interface SyncMessage {
  /** Phone number in E.164 format (e.g., +15555550112) */
  sender: string;
  /**
   * Message text content, or **null when the message has no body**
   * (BACKLOG-2977, founder ruling 2026-09-02).
   *
   * An MMS photo with no caption is a real message with no text. The absence
   * stays an absence all the way to the desktop's `messages.body_text` (already
   * nullable); only the display layer adds words. A marker string such as
   * `"[Photo]"` was rejected because it writes text nobody typed into an
   * evidence record, and `""` was rejected because it poisons the desktop's
   * dedup hash — see {@link SyncMessage.smsId}.
   *
   * `""` is NOT an absence: a `text/plain` part whose text is genuinely empty
   * is an observation, and it stores as `""` and hashes exactly as it always
   * has. Which KIND of absence a null is travels in {@link bodyAbsence}.
   *
   * Widening `string` -> `string | null` is backward compatible: an older
   * companion build that always sends a string still type-checks and the
   * desktop still stores it byte-identically. Mirror of
   * `electron/types/localSync.ts`; keep the two in sync.
   */
  body: string | null;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Android thread ID for conversation grouping */
  threadId?: string;
  /** Message direction relative to the device owner */
  direction: "inbound" | "outbound";
  /**
   * Android content-provider row id — `content://sms._id`, or `mms:<_id>` for
   * an MMS (BACKLOG-2974's `MMS_ID_NAMESPACE`).
   *
   * Used as the stable de-duplication key for the local queue (BACKLOG-2199).
   *
   * **BACKLOG-2977 made this part of the DESKTOP wire contract too.** It used
   * to be phone-side only, and this doc block used to say the desktop ignores
   * it — that is no longer true. The desktop hashes it IN PLACE OF the body
   * when `body` is null, because `SHA-256(sender|timestamp|"")` makes two
   * caption-less photos from one person in the same millisecond collide and
   * the second is dropped as a duplicate that never existed.
   *
   * ## The contract BACKLOG-3109 must honour
   *
   * **Every wire message derived from an MMS carries `smsId`.**
   * `MappedMms.smsId` is REQUIRED, not optional (`services/mmsMapper.ts:144`),
   * and is set unconditionally at `:397` from
   * `` `${MMS_ID_NAMESPACE}${id}` `` — independent of `body`. So neither the
   * `no_text_part` nor the `unreadable` outcome can produce a body-less message
   * without one. A body-less message that reaches the desktop WITHOUT an
   * `smsId` has no safe identity and is skipped there rather than folded to
   * `""`.
   *
   * **Known limit, accepted by the founder ruling:** the MMS `_id` is
   * phone-local, so clearing app data re-mints ids. A data clear re-sends
   * everything regardless, and every message WITH a body still dedups on
   * sender+timestamp+body, so only caption-less photos can duplicate.
   *
   * Still optional: a synthesized/fallback record (a carrier alert with no
   * `_id`) may not carry one, in which case queue de-dup falls back to the
   * `sender|timestamp|body` composite. Mirror of
   * `electron/types/localSync.ts`; keep the two in sync.
   */
  smsId?: string;
  /**
   * The non-SMIL content types of the message's attachment parts, in provider
   * order — e.g. `["image/jpeg"]` (BACKLOG-2977).
   *
   * This is the "record that a photo existed" marker: no bytes are
   * transferred, and the desktop writes one attachment row per entry with a
   * NULL storage path that BACKLOG-3071 later fills on the same row. The
   * desktop's `has_attachments` and `message_type` derive from it, and the
   * queue grows ~100 bytes per photo.
   *
   * **Orthogonal to {@link body} on purpose.** A CAPTIONED photo is a non-null
   * body WITH a marker, and that has to be representable. The mapper does not
   * yet emit it for that case — `attachmentContentTypes` currently exists only
   * on `MmsBody`'s `no_text_part` outcome, and `unreadable` carries `partIds`
   * instead. Both gaps belong to BACKLOG-3109; the wire already carries them.
   *
   * **The desktop SORTS a copy before deriving filenames**, because
   * `extractMmsBody` builds this list unsorted (`services/mmsMapper.ts:291-297`
   * — in contrast to the text parts immediately below at `:311`) and an index
   * into an unsorted list is not stable across re-reads. Mirror of
   * `electron/types/localSync.ts`; keep the two in sync.
   */
  attachmentContentTypes?: string[];
  /**
   * WHICH kind of absence a null {@link body} is (BACKLOG-2977).
   *
   * Both kinds store `body_text = NULL` on the desktop — absence stays an
   * absence — so without this field an audit cannot tell "the sender wrote no
   * caption" from "the sender wrote something we could not read". They are
   * different facts, and `unreadable` is a READ FAILURE that must never look
   * like an empty message.
   *
   * | value | meaning |
   * |---|---|
   * | `no_text_part` | no `text/plain` part exists — a photo with no caption, or a part-less stub |
   * | `unreadable`   | a `text/plain` part EXISTS but its text sits in the provider's file store, unread |
   *
   * These are `MmsBody`'s own two non-text outcomes (`services/mmsMapper.ts`).
   * The desktop carries the value in the message's `metadata` JSON, not a
   * column. Mirror of `electron/types/localSync.ts`; keep the two in sync.
   */
  bodyAbsence?: "no_text_part" | "unreadable";
}

// ============================================
// PAYLOAD TYPES
// ============================================

/**
 * The plaintext payload sent from Android to Electron.
 * This is encrypted before transmission.
 */
export interface SyncPayload {
  /** Unique device identifier from QR pairing */
  deviceId: string;
  /** Array of messages to sync */
  messages: SyncMessage[];
  /** Unix timestamp (ms) when this sync batch was created */
  syncTimestamp: number;
  /**
   * The phone's Supabase user id (BACKLOG-2224 soft backstop).
   *
   * Sent inside the encrypted payload so the desktop can reject a batch (403)
   * when it does not match the desktop's logged-in user. Optional/additive —
   * mirror of `electron/types/localSync.ts`; keep the two in sync.
   */
  supabaseUserId?: string;
}

/**
 * The plaintext payload for contact sync from Android to Electron.
 * This is encrypted before transmission.
 *
 * BACKLOG-1449: Android contacts sync
 */
export interface ContactSyncPayload {
  /** Unique device identifier from QR pairing */
  deviceId: string;
  /** Array of contacts to sync */
  contacts: SyncContact[];
  /** Unix timestamp (ms) when this sync batch was created */
  syncTimestamp: number;
  /**
   * The phone's Supabase user id (BACKLOG-2224 soft backstop). See the note on
   * {@link SyncPayload.supabaseUserId}. Mirror of `electron/types/localSync.ts`.
   */
  supabaseUserId?: string;
  /**
   * BACKLOG-2208: whether this batch is a FULL snapshot of the address book
   * (true) or an incremental diff of only new/changed contacts (false).
   *
   * The desktop stale-DELETES any `android_sync` contact missing from a batch,
   * so it must only do so for a full snapshot. When ABSENT (legacy phone that
   * always sends everything) the desktop treats it as a full sync — preserving
   * the pre-2208 behavior. Mirror of `electron/types/localSync.ts`.
   */
  isFullSync?: boolean;
}

/**
 * The encrypted envelope transmitted over the network.
 * All fields are hex-encoded strings.
 */
export interface EncryptedPayload {
  /** Initialization vector (hex) — random per message */
  iv: string;
  /** AES-256-GCM encrypted ciphertext (hex) */
  encrypted: string;
  /** GCM authentication tag (hex) */
  tag: string;
}

// ============================================
// ERROR TYPES
// ============================================

/**
 * Categorized sync error types for user-facing guidance.
 *
 * BACKLOG-1496: Distinguish network errors in companion app.
 * BACKLOG-2296: `phone_offline` distinguishes "the PHONE has no Wi-Fi / is not on
 * the LAN" (case b — checked FIRST via NetInfo) from a desktop that is genuinely
 * unreachable while the phone IS on Wi-Fi (`connection_refused`/`timeout`/
 * `network_after_connect`, case a). A `server_error` (e.g. a 403 account
 * rejection, BACKLOG-2284) means the desktop WAS reached and answered — it is
 * NEVER reclassified as offline/unreachable.
 */
export type SyncErrorType =
  | "connection_refused"
  | "timeout"
  | "network_after_connect"
  | "phone_offline"
  | "server_error"
  /**
   * BACKLOG-2956: the STORED pairing names an address that is not on a private
   * LAN, so the request was refused before it was issued. This is NOT a
   * reachability failure — retrying, changing Wi-Fi, or opening the desktop app
   * all change nothing. The only fix is to pair again, so it carries its own
   * type rather than falling into the generic "can't reach your computer" copy.
   */
  | "invalid_address"
  | "unknown";

// ============================================
// RESULT TYPES
// ============================================

/**
 * Result of a sync operation returned by the desktop server.
 */
export interface SyncResult {
  success: boolean;
  /** Number of messages accepted */
  messagesReceived?: number;
  /** Error message if success is false */
  error?: string;
  /** Categorized error type for UI guidance (BACKLOG-1496) */
  errorType?: SyncErrorType;
}

/**
 * Pairing information needed to connect to the desktop.
 * Generated during QR pairing (TASK-1428).
 */
export interface PairingInfo {
  /** Local network IP of the desktop */
  ip: string;
  /** Port the sync server is listening on */
  port: number;
  /** Shared secret (base64) for bearer auth + encryption key derivation */
  secret: string;
  /** Unique device identifier */
  deviceId: string;
}
