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
}

/**
 * Contact update input
 */
export interface ContactUpdateInput {
  /**
   * BACKLOG-2528 — `name`, NOT `display_name`.
   *
   * This field said `display_name`, which is the COLUMN name. The
   * `contacts:update` channel does not accept it: `validateContactData` reads
   * only `name`, so a `display_name` key is dropped by the validator before the
   * writer is reached, and the handler still returns success. That is the same
   * silent-drop shape as the rename defect this item is about, one layer up —
   * latent only because this method has no production callers yet.
   *
   * The channel's vocabulary is the renderer's: reads come back with `name`
   * (`getContactById` selects `display_name as name`), and `name` goes back.
   */
  name?: string;
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
/**
 * BACKLOG-2631 — THE THREE READ METHODS ARE GONE, AND THEIR ABSENCE IS THE
 * POINT.
 *
 * `getAll`, `getSortedByActivity` and `getAvailable` lived here as
 * `{success, contacts}` -> `{success, data}` rewraps and nothing else.
 * `getAvailable` had already had no application caller for some time;
 * `ContactsContext` was the last caller of the other two, and it now reads the
 * picker's data through `useContactDirectory` along with the other two
 * containers.
 *
 * DELETED RATHER THAN LEFT SITTING: three exported functions named exactly what
 * the next person will search for is a trap, not dead weight. They would fix
 * `contactService.getAvailable` — the obvious-looking place — and nothing would
 * happen, because nothing calls it. BACKLOG-2511 was itself caused by a refresh
 * function sitting exported with zero callers.
 *
 * The one place these channels are read is `src/hooks/contacts/useContactDirectory.ts`.
 */
export const contactService = {

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
          canDelete: result.canDelete ?? false,
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
          // BACKLOG-2510 — COUNT THE ROWS THAT CAME BACK. This read
          // `result.imported`, a field `contacts:import` has never sent: it
          // returns `contacts`, the created rows. So a successful import of 40
          // people reported `imported: 0`, always, and the declared IPC type
          // said `imported?: number` so nothing complained. Correcting the type
          // is what surfaced this — the compiler found it immediately, which is
          // the argument for keeping IPC types honest.
          //
          // Nothing in `src/` calls this method today; its own test supplied the
          // `imported` value its fixture invented, so the test agreed with the
          // code about a response neither had seen the handler produce.
          data: {
            imported: result.contacts?.length ?? 0,
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
