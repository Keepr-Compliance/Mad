/**
 * WindowApi Contacts sub-interface
 * Contact management methods exposed to renderer process
 */

import type { Contact, NewContact, Transaction, Communication, ContactMessageThread } from "../models";

/**
 * Transaction shape returned by `checkCanDelete` (databaseService.getTransactionsByContact).
 * BACKLOG-1930: `roles` is a typed, deduped `string[]` at this boundary (NOT a
 * pre-joined display string). Display formatting (the ", " join) is owned by the
 * renderer. This replaces the pre-joined-string that caused BACKLOG-1898's
 * `t.roles?.join is not a function` runtime error — `roles` is now honestly
 * typed as an array, matching the producer (`TransactionWithRoles.roles: string[]`).
 */
export interface ContactBlockingTransaction extends Transaction {
  roles?: string[];
}

/**
 * Contact methods on window.api
 */
export interface WindowApiContacts {
  getAll: (
    userId: string,
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  getSortedByActivity: (
    userId: string,
    propertyAddress?: string,
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  getAvailable: (
    userId: string,
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  checkCanDelete: (contactId: string) => Promise<{
    success: boolean;
    canDelete?: boolean;
    transactionCount?: number;
    transactions?: ContactBlockingTransaction[];
    count?: number;
    error?: string;
  }>;
  create: (
    userId: string,
    contactData: Record<string, unknown>,
  ) => Promise<{ success: boolean; contact?: Contact; error?: string }>;
  update: (
    contactId: string,
    updates: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  /** TASK-1995: Get email/phone entries with row IDs for multi-entry editing */
  getEditData: (contactId: string) => Promise<{
    success: boolean;
    emails?: { id: string; email: string; is_primary: boolean }[];
    phones?: { id: string; phone: string; is_primary: boolean }[];
    error?: string;
  }>;
  delete: (
    contactId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  remove: (
    contactId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  import: (
    userId: string,
    contacts: NewContact[],
  ) => Promise<{ success: boolean; imported?: number; error?: string }>;
  /** Listen for import progress updates */
  onImportProgress: (
    callback: (progress: { current: number; total: number; percent: number }) => void
  ) => () => void;
  /**
   * Sync external contacts from macOS Contacts app
   * @param userId - User ID to sync contacts for
   * @returns Sync result with inserted/deleted/total counts
   */
  syncExternal: (userId: string) => Promise<{
    success: boolean;
    inserted?: number;
    deleted?: number;
    total?: number;
    error?: string;
  }>;
  /**
   * Get external contacts sync status
   * @param userId - User ID to check status for
   * @returns Sync status (lastSyncAt, isStale, contactCount)
   */
  getExternalSyncStatus: (userId: string) => Promise<{
    success: boolean;
    lastSyncAt?: string | null;
    isStale?: boolean;
    contactCount?: number;
    error?: string;
  }>;
  /**
   * Get contact source stats - per-source counts (TASK-1991)
   * @param userId - User ID to get stats for
   * @returns Per-source contact counts
   */
  getSourceStats: (userId: string) => Promise<{
    success: boolean;
    stats?: Record<string, number>;
    error?: string;
  }>;
  /** Sync Outlook contacts to external_contacts table */
  syncOutlookContacts: (userId: string) => Promise<{
    success: boolean;
    count?: number;
    reconnectRequired?: boolean;
    error?: string;
  }>;
  /** Sync Google contacts to external_contacts table (TASK-2303) */
  syncGoogleContacts: (userId: string) => Promise<{
    success: boolean;
    count?: number;
    reconnectRequired?: boolean;
    error?: string;
  }>;
  /** Force re-import: wipe ALL external contacts then return */
  forceReimport: (userId: string) => Promise<{
    success: boolean;
    cleared: number;
    error?: string;
  }>;
  /** Look up contact names by phone numbers (batch) */
  getNamesByPhones: (phones: string[]) => Promise<{
    success: boolean;
    names: Record<string, string>;
    error?: string;
  }>;
  /** TASK-2026: Resolve any mix of phones, emails, Apple IDs to contact names */
  resolveHandles: (handles: string[], userId?: string) => Promise<{
    success: boolean;
    names: Record<string, string>;
    error?: string;
  }>;
  /**
   * BACKLOG-1762: Get an email address -> display_name map for the user's
   * contacts. Keys are lowercase email addresses. Email views use this to
   * resolve display names when the email header carries no name.
   */
  getEmailNameMap: (userId: string) => Promise<{
    success: boolean;
    nameMap: Record<string, string>;
    error?: string;
  }>;
  /**
   * BACKLOG-1933: Get ALL emails involving this contact's addresses, aggregated
   * across every transaction. Each element is a hydrated `Communication` ready
   * to mount in EmailViewModal; `transaction_id` is undefined for emails not
   * linked to any transaction.
   */
  getEmailsForContact: (contactId: string) => Promise<{
    success: boolean;
    emails?: Communication[];
    error?: string;
  }>;
  /**
   * BACKLOG-1933: Get ALL text-message threads involving this contact's phones,
   * aggregated across every transaction. Each group carries the required
   * `phoneNumber` for ConversationViewModal.
   */
  getMessagesForContact: (contactId: string) => Promise<{
    success: boolean;
    messages?: ContactMessageThread[];
    error?: string;
  }>;
  /** Update the default_role on a contact (manual override) */
  updateDefaultRole: (contactId: string, role: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Search contacts at database level (for selection modal) */
  searchContacts: (userId: string, query: string) => Promise<{
    success: boolean;
    contacts?: Contact[];
    error?: string;
  }>;
  /** Listen for external contacts sync completion */
  onExternalSyncComplete: (callback: () => void) => () => void;
}
