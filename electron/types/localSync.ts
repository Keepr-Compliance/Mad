/**
 * Local Sync Protocol Types
 * Type definitions for the encrypted local HTTP transport layer
 * used for SMS and contact sync between Android companion app and Electron desktop.
 *
 * TASK-1429: Android Companion — Encrypted HTTP Transport
 * BACKLOG-1449: Android contacts sync
 */

// ============================================
// MESSAGE TYPES
// ============================================

/**
 * A single SMS/MMS message synced from the Android device.
 */
export interface SyncMessage {
  /** Phone number in E.164 format (e.g., +15555550112) */
  sender: string;
  /**
   * Message text content, or **null when the message has no body**
   * (BACKLOG-2977, founder ruling 2026-09-02).
   *
   * An MMS photo with no caption is a real message with no text. The absence
   * stays an absence all the way to `messages.body_text` (already nullable);
   * only the display layer adds words. A marker string such as `"[Photo]"` was
   * rejected because it writes text nobody typed into an evidence record, and
   * `""` was rejected because it poisons the dedup hash — see
   * {@link SyncMessage.smsId}.
   *
   * `""` is NOT an absence: a `text/plain` part whose text is genuinely empty
   * is an observation, and it stores as `""` and hashes exactly as it always
   * has. Which KIND of absence a null is travels in {@link bodyAbsence}.
   *
   * Widening `string` -> `string | null` is backward compatible: an older
   * companion that always sends a string still type-checks and still stores
   * byte-identically. Mirror of `android-companion/types/sync.ts`; keep the two
   * in sync.
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
   * BACKLOG-2977 made this part of the DESKTOP wire contract. It used to be
   * phone-side only (the local queue's de-dup key, BACKLOG-2199) and the
   * desktop ignored it. The desktop now hashes it IN PLACE OF the body when
   * `body` is null, because `SHA-256(sender|timestamp|"")` makes two
   * caption-less photos from one person in the same millisecond collide and
   * the second is dropped as a duplicate that never existed.
   *
   * ## The contract BACKLOG-3109 must honour
   *
   * **Every wire message derived from an MMS carries `smsId`.**
   * `MappedMms.smsId` is REQUIRED, not optional
   * (`android-companion/services/mmsMapper.ts:144`), and is set unconditionally
   * at `:397` from `` `${MMS_ID_NAMESPACE}${id}` `` — independent of `body`. So
   * neither the `no_text_part` nor the `unreadable` outcome can produce a
   * body-less message without one. A body-less message that arrives WITHOUT an
   * `smsId` has no safe identity and is skipped rather than folded to `""`.
   *
   * **Known limit, accepted by the founder ruling:** the MMS `_id` is
   * phone-local, so clearing app data re-mints ids. A data clear re-sends
   * everything regardless, and every message WITH a body still dedups on
   * sender+timestamp+body, so only caption-less photos can duplicate.
   *
   * Optional because a synthesized/fallback record (a carrier alert with no
   * `_id`) may not carry one. Mirror of `android-companion/types/sync.ts`; keep
   * the two in sync.
   */
  smsId?: string;
  /**
   * The non-SMIL content types of the message's attachment parts, in provider
   * order — e.g. `["image/jpeg"]` (BACKLOG-2977).
   *
   * This is the "record that a photo existed" marker: no bytes are
   * transferred, and the desktop writes one `attachments` row per entry with a
   * NULL `storage_path` that BACKLOG-3071 later fills on the same row.
   * `has_attachments` and `message_type` derive from it.
   *
   * **Orthogonal to {@link body} on purpose.** A CAPTIONED photo is a non-null
   * body WITH a marker, and that has to be representable. (The mapper does not
   * yet emit it for that case — `attachmentContentTypes` currently exists only
   * on the `no_text_part` outcome, and `unreadable` carries `partIds` instead.
   * Both gaps belong to BACKLOG-3109; the wire is already able to carry them.)
   *
   * **The desktop SORTS a copy before deriving filenames**, because this list
   * is built unsorted (`mmsMapper.ts:291-297`, in contrast to the text parts
   * immediately below it at `:311`) and an index into an unsorted list is not
   * stable across re-reads. Mirror of `android-companion/types/sync.ts`; keep
   * the two in sync.
   */
  attachmentContentTypes?: string[];
  /**
   * WHICH kind of absence a null {@link body} is (BACKLOG-2977).
   *
   * Both kinds store `body_text = NULL` — absence stays an absence — so
   * without this field an audit cannot tell "the sender wrote no caption" from
   * "the sender wrote something we could not read". They are different facts
   * and `unreadable` is a READ FAILURE that must never look like an empty
   * message.
   *
   * | value | meaning |
   * |---|---|
   * | `no_text_part` | no `text/plain` part exists — a photo with no caption, or a part-less stub |
   * | `unreadable`   | a `text/plain` part EXISTS but its text sits in the provider's file store, unread |
   *
   * Carried in the message's `metadata` JSON, not a column: recoverable by
   * JSON extraction, never by a `WHERE`. Mirror of
   * `android-companion/types/sync.ts`; keep the two in sync.
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
   * The phone's Supabase user id (BACKLOG-2224 → strict in BACKLOG-2284).
   *
   * Optional on the wire (a legacy build may omit it) but now REQUIRED for a
   * logged-in desktop to accept the batch. The desktop rejects the batch (403)
   * when it is absent OR does not match the desktop's logged-in user
   * (fail-closed); it is accepted only when it equals the desktop user (or the
   * desktop is logged out). Keep this mirror in sync with the companion's
   * `android-companion/types/sync.ts`.
   */
  supabaseUserId?: string;
}

// ============================================
// CONTACT TYPES (BACKLOG-1449)
// ============================================

/**
 * A single contact synced from the Android device.
 */
export interface SyncContact {
  /**
   * `ContactsContract.Contacts._ID` from the Android contacts provider.
   *
   * BACKLOG-2407 — STABLE ON ONE DEVICE, NOT ACROSS DEVICES. Previously
   * documented here as "Stable contact ID from the Android contacts provider",
   * which is wrong as written: Android designates `LOOKUP_KEY` as the
   * sync-stable identifier and `_ID` as explicitly not one. The same incorrect
   * comment sat on the companion's own copy of this type
   * (`android-companion/types/contacts.ts`); BOTH are corrected, because this
   * interface is the DESKTOP MIRROR of that one and a reader can land on either.
   */
  id: string;
  /**
   * `ContactsContract.Contacts.LOOKUP_KEY` — Android's sync-stable identifier
   * (BACKLOG-2407). CAPTURED, MATCHED ON BY NOTHING.
   *
   * OPTIONAL FOR TWO SEPARATE REASONS, and both are load-bearing:
   *  1. It is null by construction for a contact with no structured-name row
   *     (expo-contacts assigns it only inside the StructuredName branch —
   *     `Contact.kt:89`), e.g. an organization-only or phone-only record.
   *  2. WIRE COMPATIBILITY. This is the phone->desktop contract, and an
   *     already-installed companion does not send this field. The contacts
   *     payload is structurally checked for `deviceId`/`contacts` only, with no
   *     per-field validation, so an older companion keeps syncing unchanged and
   *     a newer one talking to an older desktop simply has the field ignored.
   *     Making it required would break every paired phone that has not updated.
   */
  lookupKey?: string;
  /** Display name (first + last or organization fallback) */
  displayName: string;
  /** Phone numbers associated with the contact */
  phones: { number: string; label?: string }[];
  /** Email addresses associated with the contact */
  emails: { address: string; label?: string }[];
  /** Company / organization name */
  company?: string;
  /** Job title */
  title?: string;
}

/**
 * The plaintext payload for contact sync from Android to Electron.
 * This is encrypted before transmission.
 */
export interface ContactSyncPayload {
  /** Unique device identifier from QR pairing */
  deviceId: string;
  /** Array of contacts to sync */
  contacts: SyncContact[];
  /** Unix timestamp (ms) when this sync batch was created */
  syncTimestamp: number;
  /**
   * The phone's Supabase user id (BACKLOG-2224 → strict in BACKLOG-2284). See
   * the note on {@link SyncPayload.supabaseUserId}. Keep this mirror in sync
   * with the companion's `android-companion/types/sync.ts`.
   */
  supabaseUserId?: string;
  /**
   * BACKLOG-2208: whether this batch is a FULL snapshot of the phone's address
   * book (true) or an incremental diff of only new/changed contacts (false).
   *
   * The contact store stale-DELETES any `android_sync` contact missing from the
   * batch, which is only correct for a full snapshot. On a partial diff the
   * desktop upserts only and skips the stale-deletion. When ABSENT (a legacy
   * phone that always sends the whole address book) it is treated as a full
   * sync, preserving the pre-2208 behavior. Keep this mirror in sync with the
   * companion's `android-companion/types/sync.ts`.
   */
  isFullSync?: boolean;
}

/**
 * Result of a contact sync operation.
 */
export interface ContactSyncResult {
  success: boolean;
  /** Number of contacts received */
  contactsReceived?: number;
  /** Number of contacts stored (excluding duplicates) */
  contactsStored?: number;
  /** Error message if success is false */
  error?: string;
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
// SERVER TYPES
// ============================================

/**
 * Result of a sync operation.
 */
export interface LocalSyncResult {
  success: boolean;
  /** Number of messages accepted */
  messagesReceived?: number;
  /** Number of messages stored in the database (excluding duplicates) */
  messagesStored?: number;
  /**
   * How many attachment-marker rows failed to write (BACKLOG-2977). Present
   * only when non-zero.
   *
   * ## Why this is on the response and not just in a log
   *
   * The attachment write happens AFTER `batchInsertMessages` has committed its
   * own transaction, so the message row is already durable and already claims
   * `has_attachments = 1`. BACKLOG-2977 catches each attachment failure
   * per-row so it cannot escape `storeMessages` — deliberately, because
   * wrapping both writes in one transaction would trade a mis-marked message
   * for a LOST one, and for an evidence product the message surviving is
   * better.
   *
   * The consequence is that the failure no longer throws, so it is invisible
   * to the `catch` that BACKLOG-3110 will change. Without this field a failed
   * attachment row would be unobservable at every boundary: `success` is a
   * hardcoded literal and `messagesStored` is a MESSAGE count.
   *
   * **The contract BACKLOG-3110 must honour:** derive the success flag from
   * `attachmentsFailed` as well as from a caught throw. A throw-only fix leaves
   * this case reporting `success: true` forever, the phone never re-enqueues
   * (it retries only on `success === false`), and the message keeps
   * `has_attachments = 1` with no row permanently. Until 3110 consumes this,
   * a failed attachment row is not retried.
   *
   * DESKTOP-ONLY and deliberately not mirrored onto the companion's
   * `SyncResult`. The two result types already diverge in production:
   * `messagesStored` has been sent by the desktop since TASK-1429/1431 and the
   * phone's `SyncResult` (`android-companion/types/sync.ts`) has never declared
   * it. The phone ignores response fields it does not know.
   */
  attachmentsFailed?: number;
  /** Error message if success is false */
  error?: string;
}

/**
 * Status of the local sync HTTP server.
 */
export interface LocalSyncServerStatus {
  /** Whether the HTTP server is currently running */
  running: boolean;
  /** Port the server is listening on (null if not running) */
  port: number | null;
  /** Local network IP address the server is bound to (null if not running) */
  address: string | null;
  /** Total messages received since server started */
  totalMessagesReceived: number;
  /** Unix timestamp (ms) of last successful sync (null if no sync yet) */
  lastSyncTimestamp: number | null;
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
