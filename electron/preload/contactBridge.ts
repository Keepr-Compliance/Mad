/**
 * Contact Bridge
 * Manages contacts, imports, and contact-transaction associations
 */

import { ipcRenderer } from "electron";
import type { NewContact, Contact, Communication, ContactMessageThread } from "../types/models";

export const contactBridge = {
  /**
   * Retrieves all contacts for a user
   * @param userId - User ID to get contacts for
   * @returns All user contacts
   */
  getAll: (userId: string) => ipcRenderer.invoke("contacts:get-all", userId),

  /**
   * Gets contacts available for assignment (not deleted/archived)
   * @param userId - User ID to get available contacts for
   * @returns Available contacts
   */
  getAvailable: (userId: string) =>
    ipcRenderer.invoke("contacts:get-available", userId),

  /**
   * Imports contacts from system address book or external source
   * @param userId - User ID importing contacts
   * @param contactsToImport - Array of contact objects to import
   * @returns Import results
   */
  import: (userId: string, contactsToImport: NewContact[]) =>
    ipcRenderer.invoke("contacts:import", userId, contactsToImport),

  /**
   * Gets contacts sorted by activity/relevance for a property
   * @param userId - User ID
   * @param propertyAddress - Property address to find relevant contacts for
   * @returns Sorted contacts
   */
  getSortedByActivity: (userId: string, propertyAddress?: string) =>
    ipcRenderer.invoke(
      "contacts:get-sorted-by-activity",
      userId,
      propertyAddress,
    ),

  /**
   * Creates a new contact
   * @param userId - User ID creating the contact
   * @param contactData - Contact details (name, email, phone, company, etc.)
   * @returns Created contact
   */
  create: (userId: string, contactData: NewContact) =>
    ipcRenderer.invoke("contacts:create", userId, contactData),

  /**
   * Updates contact details
   * @param contactId - Contact ID to update
   * @param updates - Fields to update (name, email, phone, etc.)
   * @returns Updated contact
   */
  update: (contactId: string, updates: Partial<Contact>) =>
    ipcRenderer.invoke("contacts:update", contactId, updates),

  /**
   * TASK-1995: Get contact email/phone entries with row IDs for multi-entry editing
   * @param contactId - Contact ID to get edit data for
   * @returns Email and phone entries with IDs and is_primary flags
   */
  getEditData: (contactId: string): Promise<{
    success: boolean;
    emails?: { id: string; email: string; is_primary: boolean }[];
    phones?: { id: string; phone: string; is_primary: boolean }[];
    error?: string;
  }> => ipcRenderer.invoke("contacts:get-edit-data", contactId),

  /**
   * Checks if a contact can be deleted (not assigned to transactions)
   * @param contactId - Contact ID to check
   * @returns Deletion eligibility
   */
  checkCanDelete: (contactId: string) =>
    ipcRenderer.invoke("contacts:checkCanDelete", contactId),

  /**
   * Deletes a contact (only if not assigned to transactions)
   * @param contactId - Contact ID to delete
   * @returns Deletion result
   */
  delete: (contactId: string) =>
    ipcRenderer.invoke("contacts:delete", contactId),

  /**
   * Removes a contact (soft delete/archive)
   * @param contactId - Contact ID to remove
   * @returns Removal result
   */
  remove: (contactId: string) =>
    ipcRenderer.invoke("contacts:remove", contactId),

  /**
   * Look up contact names by phone numbers (batch)
   * @param phones - Array of phone numbers to look up
   * @returns Map of phone -> contact name
   */
  getNamesByPhones: (phones: string[]): Promise<{ success: boolean; names: Record<string, string>; error?: string }> =>
    ipcRenderer.invoke("contacts:get-names-by-phones", phones),

  /**
   * TASK-2026: Resolve any mix of phone numbers, emails, and Apple IDs to contact names
   * Uses shared ContactResolutionService (imported contacts + macOS Contacts + email lookup)
   * @param handles - Array of phone numbers, emails, or Apple IDs to resolve
   * @returns Map of handle -> contact name
   */
  resolveHandles: (handles: string[], userId?: string): Promise<{ success: boolean; names: Record<string, string>; error?: string }> =>
    ipcRenderer.invoke("contacts:resolve-handles", handles, userId),

  /**
   * BACKLOG-1762: Get an email address -> display_name map for the user's contacts.
   * Email views use this to resolve display names when the email header carries
   * no name. Keys are lowercase email addresses.
   * @param userId - User ID to build the map for
   * @returns Map of lowercase email address -> contact display name
   */
  getEmailNameMap: (userId: string): Promise<{ success: boolean; nameMap: Record<string, string>; error?: string }> =>
    ipcRenderer.invoke("contacts:get-email-name-map", userId),

  /**
   * BACKLOG-1933: Get ALL emails involving this contact's addresses, aggregated
   * across every transaction. Rows are hydrated Communication objects ready to
   * mount in EmailViewModal. `transaction_id` is undefined for non-linked emails.
   * @param contactId - Contact ID
   * @returns Contact's emails (newest-first, deduped by email id)
   */
  getEmailsForContact: (contactId: string): Promise<{ success: boolean; emails?: Communication[]; error?: string }> =>
    ipcRenderer.invoke("contacts:get-emails", contactId),

  /**
   * BACKLOG-1933: Get ALL text-message threads involving this contact's phones,
   * aggregated across every transaction. Each group is ready to mount in
   * ConversationViewModal (carries the required `phoneNumber`).
   * @param contactId - Contact ID
   * @returns Contact's text threads (newest-activity-first)
   */
  getMessagesForContact: (contactId: string): Promise<{ success: boolean; messages?: ContactMessageThread[]; error?: string }> =>
    ipcRenderer.invoke("contacts:get-messages", contactId),

  /**
   * Update the default_role on a contact (manual override)
   * @param contactId - Contact ID to update
   * @param role - New default role value
   * @returns Update result
   */
  updateDefaultRole: (contactId: string, role: string): Promise<{
    success: boolean;
    error?: string;
  }> => ipcRenderer.invoke("contacts:update-default-role", contactId, role),

  /**
   * Search contacts at database level (for selection modal)
   * This enables searching beyond the initial LIMIT 200 contacts.
   * @param userId - User ID to search contacts for
   * @param query - Search query (name, email, phone, company)
   * @returns Matching contacts sorted by relevance
   */
  searchContacts: (userId: string, query: string): Promise<{
    success: boolean;
    contacts?: Contact[];
    error?: string;
  }> => ipcRenderer.invoke("contacts:search", userId, query),

  /**
   * TASK-1773: Trigger manual sync of external contacts from macOS
   * @param userId - User ID to sync contacts for
   * @returns Sync results (inserted, deleted, total)
   */
  syncExternal: (userId: string): Promise<{
    success: boolean;
    inserted?: number;
    deleted?: number;
    total?: number;
    error?: string;
  }> => ipcRenderer.invoke("contacts:syncExternal", userId),

  /**
   * TASK-1773: Get external contacts sync status
   * @param userId - User ID to check status for
   * @returns Sync status (lastSyncAt, isStale, contactCount)
   */
  getExternalSyncStatus: (userId: string): Promise<{
    success: boolean;
    lastSyncAt?: string | null;
    isStale?: boolean;
    contactCount?: number;
    error?: string;
  }> => ipcRenderer.invoke("contacts:getExternalSyncStatus", userId),

  /**
   * TASK-1991: Get contact source stats (per-source counts)
   * Returns counts grouped by source: { macos, iphone, outlook }
   * @param userId - User ID to get stats for
   * @returns Per-source contact counts
   */
  getSourceStats: (userId: string): Promise<{
    success: boolean;
    stats?: Record<string, number>;
    error?: string;
  }> => ipcRenderer.invoke("contacts:getSourceStats", userId),

  /**
   * Force re-import: wipes ALL external contacts (every source),
   * then the caller triggers normal import to re-fetch from enabled sources.
   * @param userId - User ID to force re-import for
   * @returns Wipe result (cleared count)
   */
  forceReimport: (userId: string): Promise<{
    success: boolean;
    cleared: number;
    error?: string;
  }> => ipcRenderer.invoke("contacts:forceReimport", userId),

  /**
   * TASK-1921: Sync Outlook contacts to external_contacts table
   * Fetches contacts from Microsoft Graph API and syncs to local SQLite
   * @param userId - User ID to sync contacts for
   * @returns Sync result (count of contacts synced, reconnectRequired flag)
   */
  syncOutlookContacts: (userId: string): Promise<{
    success: boolean;
    count?: number;
    reconnectRequired?: boolean;
    error?: string;
  }> => ipcRenderer.invoke("contacts:syncOutlookContacts", userId),

  /**
   * Sync Google contacts to external_contacts table (TASK-2303)
   * Fetches contacts from Google People API and syncs to local SQLite
   * @param userId - User ID to sync contacts for
   * @returns Sync result (count of contacts synced, reconnectRequired flag)
   */
  syncGoogleContacts: (userId: string): Promise<{
    success: boolean;
    count?: number;
    reconnectRequired?: boolean;
    error?: string;
  }> => ipcRenderer.invoke("contacts:syncGoogleContacts", userId),

  /**
   * Listen for import progress updates
   * @param callback - Called with progress updates during contact import
   * @returns Cleanup function to remove listener
   */
  onImportProgress: (
    callback: (progress: { current: number; total: number; percent: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { current: number; total: number; percent: number }
    ) => {
      callback(progress);
    };
    ipcRenderer.on("contacts:import-progress", handler);
    return () => {
      ipcRenderer.removeListener("contacts:import-progress", handler);
    };
  },

  /**
   * TASK-1773: Listen for external contacts sync completion
   * @param callback - Called when background sync completes
   * @returns Cleanup function to remove listener
   */
  onExternalSyncComplete: (callback: () => void): (() => void) => {
    const handler = () => {
      callback();
    };
    ipcRenderer.on("contacts:external-sync-complete", handler);
    return () => {
      ipcRenderer.removeListener("contacts:external-sync-complete", handler);
    };
  },
};

/**
 * Address Verification Bridge
 * Integrates with Google Places API for address validation and geocoding
 */
export const addressBridge = {
  /**
   * Initializes Google Places API with API key
   * @param apiKey - Google Places API key
   * @returns Initialization result
   */
  initialize: (apiKey: string) =>
    ipcRenderer.invoke("address:initialize", apiKey),

  /**
   * Gets address autocomplete suggestions
   * @param input - Partial address input
   * @param sessionToken - Session token for request batching
   * @returns Address suggestions
   */
  getSuggestions: (input: string, sessionToken: string) =>
    ipcRenderer.invoke("address:get-suggestions", input, sessionToken),

  /**
   * Gets detailed information for a specific place
   * @param placeId - Google Place ID
   * @returns Place details
   */
  getDetails: (placeId: string) =>
    ipcRenderer.invoke("address:get-details", placeId),

  /**
   * Geocodes an address to coordinates
   * @param address - Address to geocode
   * @returns Geocoding result
   */
  geocode: (address: string) =>
    ipcRenderer.invoke("address:geocode", address),

  /**
   * Validates and standardizes an address
   * @param address - Address to validate
   * @returns Validation result
   */
  validate: (address: string) =>
    ipcRenderer.invoke("address:validate", address),
};
