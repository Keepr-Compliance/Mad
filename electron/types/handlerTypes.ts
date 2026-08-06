/**
 * Handler-specific types for SQLite query results and IPC handler parameters
 * These types replace `any` types in handler files for better type safety
 */

import type { Transaction } from "./models";

// ============================================
// TRANSACTION HANDLER RESPONSE TYPES
// ============================================

/**
 * Standard response shape for transaction IPC handlers.
 * Consolidated from duplicate definitions in transactionCrudHandlers,
 * transactionExportHandlers, and emailSyncHandlers (TASK-2000).
 */
export interface TransactionResponse {
  success: boolean;
  error?: string;
  transaction?: Transaction | null;
  transactions?: Array<Partial<Transaction> & { id: string }>;
  [key: string]: unknown;
}

// ============================================
// SQLITE ROW TYPES
// ============================================

/**
 * SQLite row result for conversation/chat queries
 */
export interface ConversationRow {
  chat_id: number;
  chat_identifier: string;
  display_name: string | null;
  contact_id: string | null;
  last_message_date: number;
  message_count: number;
}

/**
 * SQLite row result for message queries
 */
export interface MessageRow {
  id: number;
  text: string | null;
  date: number;
  is_from_me: number;
  sender: string | null;
  cache_has_attachments?: number;
  attributedBody?: Buffer | null;
  chat_id?: number;
}

/**
 * SQLite row result for participant queries
 */
export interface ParticipantRow {
  contact_id: string;
}

/**
 * SQLite row result for chat info queries
 */
export interface ChatInfoRow {
  chat_id: number;
  chat_identifier: string;
  display_name: string | null;
  contact_id?: string;
}

/**
 * SQLite row result for chat ID lookup queries
 */
export interface ChatIdQueryRow {
  chat_id: number;
  display_name?: string | null;
  chat_identifier?: string;
}

/**
 * Group chat data structure for export operations
 */
export interface GroupChatData {
  info: ChatInfoRow;
  messages: MessageRow[];
}

// ============================================
// CONTACT INFO TYPES
// ============================================

/**
 * Contact information with phones and emails
 * Used for resolving contact details from various sources
 */
export interface ContactInfoData {
  name: string;
  phones: string[];
  emails: string[];
}

/**
 * Processed conversation data for display
 */
export interface ProcessedConversation {
  id: number | string;
  chatId?: number;
  name: string;
  contactId: string | null;
  phones: string[];
  emails: string[];
  showBothNameAndNumber: boolean;
  messageCount: number;
  lastMessageDate: number;
  directChatCount: number;
  directMessageCount: number;
  groupChatCount: number;
  groupMessageCount: number;
}

// ============================================
// EXPORT CONTACT TYPES
// ============================================

/**
 * Contact data structure for export operations
 * chatId can be number (actual ID) or string (group-contact-* placeholder)
 */
export interface ExportContact {
  name: string;
  chatId?: number | string;
  phones?: string[];
  emails?: string[];
}

/**
 * Get numeric chat ID from ExportContact, filtering out placeholder IDs
 */
export function getNumericChatId(contact: ExportContact): number | null {
  if (typeof contact.chatId === "number") {
    return contact.chatId;
  }
  if (typeof contact.chatId === "string" && !contact.chatId.startsWith("group-contact-")) {
    const num = parseInt(contact.chatId, 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Progress callback function type for handler operations
 * Note: Named with Handler suffix to avoid conflict with existing ExportProgress in ipc.ts
 */
export interface HandlerExportProgress {
  stage?: string;
  message?: string;
  current?: number;
  total?: number;
  contactName?: string;
}

export type ExportProgressCallback = (progress: HandlerExportProgress) => void;

/**
 * Result for individual contact export
 */
export interface ContactExportResult {
  contactName: string;
  success: boolean;
  textMessageCount: number;
  emailCount: number;
  error: string | null;
}

// ============================================
// DATABASE WRAPPER TYPES
// ============================================

/**
 * Typed wrapper for SQLite db.all() function
 */
export type SqliteDbAll<T> = (sql: string, params?: unknown) => Promise<T[]>;

// ============================================
// IMPORT CONTACT TYPES
// ============================================

/**
 * Contact data for import operations (available contacts list)
 */
export interface AvailableContact {
  id: string;
  name: string | null | undefined;
  phone: string | null;
  email: string | null;
  company?: string | null;
  source: string;
  isFromDatabase: boolean;
  allPhones?: string[];
  allEmails?: string[];
  last_communication_at?: string | null;  // TASK-1773: Pre-computed from shadow table

  /**
   * BACKLOG-2401 — the SOURCE identity, carried so a link can be written at
   * import time.
   *
   * `id` above is the shadow-table row's own UUID, which is regenerated on
   * every upsert attempt and therefore useless as identity. These two are the
   * pair that actually identifies the record in its origin system, and until
   * now the handler discarded them here — which is why a saved contact had no
   * way back to where it came from except its display name.
   *
   * Optional because a row that came from the local `contacts` table (the
   * iPhone-sync path) has no external record behind it.
   */
  externalRecordId?: string | null;
  externalSourceType?: string | null;
  /** macOS ZEXTERNALUUID. Captured for later; nothing matches on it. */
  externalUuid?: string | null;
}

/**
 * Contact data from database for import (with isFromDatabase flag)
 */
export interface ImportableContact {
  id: string;
  name?: string | null;
  display_name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  source?: string;
  isFromDatabase: boolean;
  allPhones?: string[];
  allEmails?: string[];

  /** BACKLOG-2401 — see AvailableContact. Round-trips through the renderer. */
  externalRecordId?: string | null;
  externalSourceType?: string | null;
  externalUuid?: string | null;
}

/**
 * Existing database contact record for import tracking
 */
export interface ExistingDbContactRecord {
  id: string;
  contact: ImportableContact;
}

/**
 * New contact data to be created during import
 */
export interface NewContactData {
  user_id: string;
  display_name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  source: string;
  is_imported: boolean;
  allPhones?: string[];
  allEmails?: string[];
}
