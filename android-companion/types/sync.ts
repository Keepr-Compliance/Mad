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
  /**
   * Android SMS content-provider row id (`content://sms._id`).
   *
   * Phone-side only: used as the stable de-duplication key for the local
   * queue (BACKLOG-2199). It is NOT part of the desktop wire contract — the
   * desktop dedups on a SHA-256 of `sender|timestamp|body` and simply ignores
   * this field. Optional because some synthesized/fallback records (carrier
   * alerts with no `_id`) may not carry one, in which case queue de-dup falls
   * back to the `sender|timestamp|body` composite.
   */
  smsId?: string;
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
 * BACKLOG-1496: Distinguish network errors in companion app
 */
export type SyncErrorType =
  | "connection_refused"
  | "timeout"
  | "network_after_connect"
  | "server_error"
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
