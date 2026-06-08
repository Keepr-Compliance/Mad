/**
 * Contact Service
 *
 * Service abstraction for contact-related API calls.
 * Centralizes all window.api.contacts calls and provides type-safe wrappers.
 */

import type { Contact, NewContact } from "@/types";
import { type ApiResult, getErrorMessage } from "./index";

/**
 * Contact creation input
 */
export interface ContactCreateInput {
  /** Required by backend validation */
  name?: string;
  display_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  source?: string;
  /** All email addresses (BACKLOG-1270) */
  allEmails?: string[];
  /** All phone numbers (BACKLOG-1270) */
  allPhones?: string[];
  /**
   * BACKLOG-1745 Part 2: optional engagement timestamps. When importing a contact
   * from an external (message-derived) row, callers pass these through so the new
   * contact row inherits the external's recency. Without this, freshly imported
   * contacts get NULL timestamps and the unified sort (Part 1) sinks them to the
   * bottom of the list — appearing as if the picker reordered.
   */
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  last_communication_at?: string | null;
}

/**
 * Contact update input
 */
export interface ContactUpdateInput {
  display_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Contact import result
 */
export interface ContactImportResult {
  imported: number;
  skipped?: number;
  errors?: string[];
}

/**
 * Contact deletion check result
 */
export interface ContactDeleteCheck {
  canDelete: boolean;
  transactionCount?: number;
}

/**
 * Contact Service
 * Provides a clean abstraction over window.api.contacts
 */
export const contactService = {
  /**
   * Get all contacts for a user
   */
  async getAll(userId: string): Promise<ApiResult<Contact[]>> {
    try {
      const result = await window.api.contacts.getAll(userId);
      if (result.success) {
        return { success: true, data: result.contacts || [] };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get contacts sorted by recent activity
   */
  async getSortedByActivity(
    userId: string,
    propertyAddress?: string
  ): Promise<ApiResult<Contact[]>> {
    try {
      const result = await window.api.contacts.getSortedByActivity(
        userId,
        propertyAddress
      );
      if (result.success) {
        return { success: true, data: result.contacts || [] };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get available contacts (not linked to any transaction)
   */
  async getAvailable(userId: string): Promise<ApiResult<Contact[]>> {
    try {
      const result = await window.api.contacts.getAvailable(userId);
      if (result.success) {
        return { success: true, data: result.contacts || [] };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Create a new contact
   */
  async create(
    userId: string,
    contactData: ContactCreateInput
  ): Promise<ApiResult<Contact>> {
    try {
      const result = await window.api.contacts.create(
        userId,
        contactData as Record<string, unknown>
      );
      if (result.success && result.contact) {
        return { success: true, data: result.contact };
      }
      return { success: false, error: result.error || "Failed to create contact" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Update an existing contact
   */
  async update(
    contactId: string,
    updates: ContactUpdateInput
  ): Promise<ApiResult> {
    try {
      const result = await window.api.contacts.update(
        contactId,
        updates as Record<string, unknown>
      );
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Delete a contact
   */
  async delete(contactId: string): Promise<ApiResult> {
    try {
      const result = await window.api.contacts.delete(contactId);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Remove a contact (alias for delete)
   */
  async remove(contactId: string): Promise<ApiResult> {
    try {
      const result = await window.api.contacts.remove(contactId);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if a contact can be deleted (not linked to transactions)
   */
  async checkCanDelete(contactId: string): Promise<ApiResult<ContactDeleteCheck>> {
    try {
      const result = await window.api.contacts.checkCanDelete(contactId);
      return {
        success: true,
        data: {
          canDelete: result.canDelete,
          transactionCount: result.transactionCount,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Update the default_role on a contact
   */
  async updateDefaultRole(
    contactId: string,
    role: string
  ): Promise<ApiResult> {
    try {
      const result = await window.api.contacts.updateDefaultRole(contactId, role);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Import multiple contacts
   */
  async import(
    userId: string,
    contacts: NewContact[]
  ): Promise<ApiResult<ContactImportResult>> {
    try {
      const result = await window.api.contacts.import(userId, contacts);
      if (result.success) {
        return {
          success: true,
          data: {
            imported: result.imported || 0,
          },
        };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },
};

export default contactService;
