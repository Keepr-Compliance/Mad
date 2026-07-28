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
  /** Phone number in E.164 format (e.g., +15551234567) */
  sender: string;
  /** Message text content */
  body: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Android thread ID for conversation grouping */
  threadId?: string;
  /** Message direction relative to the device owner */
  direction: "inbound" | "outbound";
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
  /** Stable contact ID from the Android contacts provider */
  id: string;
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
