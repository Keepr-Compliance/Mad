/**
 * Contact Category Utilities
 *
 * Utilities for categorizing and filtering contacts by source type.
 * Used in contact selection screens to provide multi-category filtering.
 *
 * @deprecated (BACKLOG-1898 T3) This module is DEAD CODE. Its `CategoryFilter`
 * shape was one of three divergent filter models (§4a "THREE definitions collapse
 * to ONE") and its only remaining importer is its own test file — it was already
 * orphaned from the runtime UI (ContactSearchList used a separate inline copy).
 * The single source of truth for contact filtering is now the grouped Source/Role
 * model in `contactFilterModel.ts`, wired into `ContactSearchList.tsx`. These
 * exports are retained only for back-compat and will be removed in a follow-up.
 * DO NOT wire this into new UI.
 *
 * @see TASK-1769: Multi-Category Contact Filtering
 * @see BACKLOG-566: Multi-Category Contact Filtering in EditContactsModal
 * @see BACKLOG-1898: Clients & Contacts Phase 1 (filter reconciliation)
 */

import type { ExtendedContact } from "../types/components";

/**
 * Category filter state for contact selection.
 * @deprecated Use `ContactFilters` from `contactFilterModel.ts` (BACKLOG-1898 T3).
 */
export interface CategoryFilter {
  imported: boolean;
  manuallyAdded: boolean;
  external: boolean;
  messageDerived: boolean;
}

/**
 * Default category filter state:
 * - Imported, Manual, External: ON (checked)
 * - Message-derived: OFF (unchecked)
 * @deprecated Use `defaultContactFilters()` from `contactFilterModel.ts` (BACKLOG-1898 T3).
 */
export const DEFAULT_CATEGORY_FILTER: CategoryFilter = {
  imported: true,
  manuallyAdded: true,
  external: true,
  messageDerived: false,
};

/**
 * Contact category types
 */
export type ContactCategory =
  | "imported"
  | "manually_added"
  | "message_derived"
  | "external";

/**
 * Determines the category of a contact based on its source and flags.
 *
 * Category logic (aligned with SourcePill display):
 * - External contacts: isExternal param OR is_message_derived flag -> 'external' (blue badge)
 * - Message sources: source in ['email', 'sms', 'inferred'] without is_message_derived -> 'message_derived'
 * - Manually created: source='manual' -> 'manually_added'
 * - All other: typically source='contacts_app' -> 'imported' (green badge)
 *
 * NOTE: is_message_derived contacts show "External" badge in UI, so they're categorized
 * as 'external' to match. The "External" checkbox controls what shows "External" badge.
 *
 * @param contact - The contact to categorize
 * @param isExternal - Whether this is an external contact not yet imported
 * @returns The contact category
 * @deprecated Use the grouped predicates in `contactFilterModel.ts` (BACKLOG-1898 T3).
 */
export function getContactCategory(
  contact: ExtendedContact,
  isExternal = false
): ContactCategory {
  // External contacts from address book OR message-derived contacts
  // Both show "External" badge in UI, so both should be in "external" category
  if (isExternal) {
    return "external";
  }

  // Message-derived contacts show "External" badge in ContactRow
  // So they should be categorized as "external" to match UI
  if (
    contact.is_message_derived === 1 ||
    contact.is_message_derived === true
  ) {
    return "external";
  }

  // Check source for message-derived sources (without is_message_derived flag)
  // These are contacts extracted from communications but already "imported"
  const messageSourceValues = ["email", "sms", "inferred"];
  if (messageSourceValues.includes(contact.source || "")) {
    return "message_derived";
  }

  // Manually created contacts
  if (contact.source === "manual") {
    return "manually_added";
  }

  // Default: imported from contacts app
  return "imported";
}

/**
 * Checks if a contact should be shown based on the current category filter.
 *
 * @param contact - The contact to check
 * @param filter - The category filter state
 * @param isExternal - Whether this is an external contact
 * @returns Whether the contact should be shown
 * @deprecated Use `matchesContactFilters()` from `contactFilterModel.ts` (BACKLOG-1898 T3).
 */
export function shouldShowContact(
  contact: ExtendedContact,
  filter: CategoryFilter,
  isExternal = false
): boolean {
  const category = getContactCategory(contact, isExternal);

  switch (category) {
    case "imported":
      return filter.imported;
    case "manually_added":
      return filter.manuallyAdded;
    case "external":
      return filter.external;
    case "message_derived":
      return filter.messageDerived;
    default:
      return true;
  }
}

/**
 * LocalStorage key for category filter persistence.
 * @deprecated Superseded by `contactModal.filterModel.v1` owned by `ContactSearchList.tsx`
 * (BACKLOG-1898 T3). This key is now read once for one-time migration, then no longer written.
 */
export const CATEGORY_FILTER_STORAGE_KEY = "contactModal.categoryFilter";

/**
 * Loads category filter from localStorage, falling back to defaults.
 *
 * @returns The saved category filter or defaults
 * @deprecated Use `loadContactFilters()` inside `ContactSearchList.tsx` (BACKLOG-1898 T3).
 */
export function loadCategoryFilter(): CategoryFilter {
  try {
    const stored = localStorage.getItem(CATEGORY_FILTER_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<CategoryFilter>;
      // Merge with defaults to handle any missing keys
      return {
        ...DEFAULT_CATEGORY_FILTER,
        ...parsed,
      };
    }
  } catch {
    // Ignore localStorage errors
  }
  return DEFAULT_CATEGORY_FILTER;
}

/**
 * Saves category filter to localStorage.
 *
 * @param filter - The category filter to save
 * @deprecated Use `saveContactFilters()` inside `ContactSearchList.tsx` (BACKLOG-1898 T3).
 */
export function saveCategoryFilter(filter: CategoryFilter): void {
  try {
    localStorage.setItem(CATEGORY_FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // Ignore localStorage errors
  }
}
