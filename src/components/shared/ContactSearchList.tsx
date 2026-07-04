/**
 * ContactSearchList Component
 *
 * A search-enabled contact selection list that combines imported and external contacts.
 * Features:
 * - Search filtering by name, email, and phone (case-insensitive)
 * - Multi-select with checkboxes
 * - Imported contacts shown with [Imported] pill
 * - External contacts shown with [External] pill and optional [+] import button
 * - Auto-import: selecting an external contact triggers import callback
 * - Loading, error, and empty states
 * - Keyboard navigation (via ContactRow)
 *
 * @see BACKLOG-418: Redesign Contact Selection UX (Select First, Assign Roles Second)
 * @see TASK-1763: ContactSearchList Component
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { ContactRow } from "./ContactRow";
import type { ExtendedContact } from "../../types/components";
import { sortByRecentCommunication } from "../../utils/contactSortUtils";
import logger from '../../utils/logger';

/**
 * Internal type for combined contact list
 * All contacts use ExtendedContact - isExternal flag distinguishes external ones.
 * External contacts have is_message_derived=true or source="external".
 */
interface CombinedContact {
  contact: ExtendedContact;
  isExternal: boolean;
}

export interface ContactSearchListProps {
  /** Imported/existing contacts */
  contacts: ExtendedContact[];
  /** External contacts (from address book, not yet imported) - now uses ExtendedContact with isExternal flag */
  externalContacts?: ExtendedContact[];
  /** Currently selected contact IDs */
  selectedIds: string[];
  /** Callback when selection changes */
  onSelectionChange: (selectedIds: string[]) => void;
  /** Callback to import an external contact - returns the imported contact */
  onImportContact?: (contact: ExtendedContact) => Promise<ExtendedContact>;
  /**
   * Whether to show add/import button for already-imported contacts.
   * - true: Show button for ALL contacts (use in transaction flows to add to transaction)
   * - false: Only show button for external contacts (use in Contacts screen for import only)
   * Default: false
   */
  showAddButtonForImported?: boolean;
  /** Callback when a contact is clicked (for viewing details). If provided, clicking a contact calls this instead of selection. */
  onContactClick?: (contact: ExtendedContact) => void;
  /** Callback to add a new contact manually */
  onAddManually?: () => void;
  /** Contact IDs that have been added (for visual feedback) */
  addedContactIds?: Set<string>;
  /** Show loading state */
  isLoading?: boolean;
  /** Error message to display */
  error?: string | null;
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /** Whether to show the built-in category filter (default: true) */
  showCategoryFilter?: boolean;
  /**
   * Sort order for contacts.
   * - "recent": Most recent communication first (for transaction flows)
   * - "alphabetical": A-Z by name (for Contacts screen)
   * Default: "recent"
   */
  sortOrder?: "recent" | "alphabetical";
  /** Additional CSS classes */
  className?: string;
}

/**
 * Checks if a contact matches the search query.
 * Searches by name, email, and phone (case-insensitive).
 */
function matchesSearch(
  contact: ExtendedContact,
  query: string
): boolean {
  const lowerQuery = query.trim().toLowerCase();

  // Check name (handle both name and display_name)
  const nameValue =
    "display_name" in contact
      ? contact.display_name || contact.name || ""
      : contact.name || "";
  const name = nameValue.toLowerCase();
  if (name.includes(lowerQuery)) return true;

  // Check email
  const email = (contact.email || "").toLowerCase();
  if (email.includes(lowerQuery)) return true;

  // Check allEmails if available (ExtendedContact)
  if ("allEmails" in contact && contact.allEmails) {
    const allEmails = contact.allEmails.join(" ").toLowerCase();
    if (allEmails.includes(lowerQuery)) return true;
  }

  // Check phone
  const phone = (contact.phone || "").toLowerCase();
  if (phone.includes(lowerQuery)) return true;

  // Check allPhones if available (ExtendedContact)
  if ("allPhones" in contact && contact.allPhones) {
    const allPhones = contact.allPhones.join(" ").toLowerCase();
    if (allPhones.includes(lowerQuery)) return true;
  }

  return false;
}

/**
 * ContactSearchList Component
 *
 * Displays a searchable list of contacts with multi-select capability.
 * Combines imported contacts and external contacts into a unified list.
 *
 * @example
 * // Basic usage
 * <ContactSearchList
 *   contacts={importedContacts}
 *   selectedIds={selectedIds}
 *   onSelectionChange={setSelectedIds}
 * />
 *
 * @example
 * // With external contacts and auto-import
 * <ContactSearchList
 *   contacts={importedContacts}
 *   externalContacts={addressBookContacts}
 *   selectedIds={selectedIds}
 *   onSelectionChange={setSelectedIds}
 *   onImportContact={async (contact) => {
 *     const imported = await importContactFromAddressBook(contact);
 *     return imported;
 *   }}
 * />
 */
/**
 * Category filter state - matches SourcePill display variants
 * - manual: Green "Manual" pill (user-created contacts)
 * - imported: Blue "Imported" pill (imported from Contacts App, non-message-derived)
 * - external: Violet "Contacts App" pill (message-derived contacts, not yet imported)
 * - messages: Amber "Message" pill (SMS source)
 * - outlook: Indigo "Outlook" pill (from Outlook Graph API import)
 */
interface CategoryFilter {
  manual: boolean;
  imported: boolean;
  external: boolean;
  messages: boolean;
  outlook: boolean;
}

const DEFAULT_CATEGORY_FILTER: CategoryFilter = {
  manual: true,
  imported: true,
  external: true,
  messages: false,
  outlook: true,
};

/**
 * Determines the filter category of a contact based on source and external status.
 * This is the single source of truth for contact categorization.
 *
 * Categories map to pill display:
 * - "outlook" → "Outlook" pill (indigo) - from Outlook Graph API import
 * - "messages" → "Message" pill (amber) - from SMS/iMessage sync
 * - "external" → "Contacts App" pill (violet) - from Contacts App, not imported
 * - "manual" → "Manual" pill (green) - user-created via Add Manually
 * - "imported" → "Imported" pill (blue) - imported from Contacts App
 */
function getContactCategory(contact: ExtendedContact, isExternalContact: boolean = false): keyof CategoryFilter {
  // Outlook contacts (from Outlook Graph API import)
  if (contact.source === "outlook") {
    return "outlook";
  }
  // SMS/messages source shows as "Message" pill
  if (contact.source === "sms" || contact.source === "messages") {
    return "messages";
  }
  // External contacts (from Contacts App, not yet imported) show as "Contacts App" pill
  if (isExternalContact || contact.is_message_derived === true || contact.is_message_derived === 1) {
    return "external";
  }
  // Manual source - user-created contacts via Add Manually
  if (contact.source === "manual") {
    return "manual";
  }
  // Everything else shows as "Imported" pill (contacts_app, email, inferred, etc.)
  return "imported";
}

export function ContactSearchList({
  contacts,
  externalContacts = [],
  selectedIds,
  onSelectionChange,
  onImportContact,
  showAddButtonForImported = false,
  onContactClick,
  onAddManually,
  addedContactIds = new Set(),
  isLoading = false,
  error = null,
  searchPlaceholder = "Search contacts...",
  showCategoryFilter = true,
  sortOrder = "recent",
  className = "",
}: ContactSearchListProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(DEFAULT_CATEGORY_FILTER);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Normalize phone to last 10 digits for consistent matching (mirrors backend normalizeToE164 logic)
  const normPhone = (p: string) => p.replace(/\D/g, "").slice(-10);

  // Build sets of emails/phones from imported contacts for deduplication and isAdded check
  const { importedEmails, importedPhones } = useMemo(() => {
    const emails = new Set<string>();
    const phones = new Set<string>();
    contacts.forEach((c) => {
      if (c.email) emails.add(c.email.toLowerCase());
      c.allEmails?.forEach((e) => emails.add(e.toLowerCase()));
      if (c.phone) phones.add(normPhone(c.phone));
      c.allPhones?.forEach((p) => phones.add(normPhone(p)));
    });
    return { importedEmails: emails, importedPhones: phones };
  }, [contacts]);

  // Helper to check if an external contact is already imported (by email/phone)
  const isContactImported = useCallback((contact: ExtendedContact): boolean => {
    const emails = [contact.email, ...(contact.allEmails || [])].filter(Boolean);
    const emailMatch = emails.some((e) => importedEmails.has(e!.toLowerCase()));
    if (emailMatch) return true;

    const phones = [contact.phone, ...(contact.allPhones || [])].filter(Boolean);
    const phoneMatch = phones.some((p) => importedPhones.has(normPhone(p!)));
    return phoneMatch;
  }, [importedEmails, importedPhones]);

  // ----------------------------------------------------------------------
  // Stable Visible Order (SVO) — see BACKLOG-1745
  //
  // The visible order of rows is treated as renderer state distinct from
  // the data-layer's sorted order. Background data refreshes (silent
  // refetch after import, sync arrival, polling) must NOT reorder rows
  // under the user's pointer. Only explicit user list-change events
  // (search text, category filter, sort-order toggle, mount) trigger a
  // fresh sort.
  //
  // Implementation:
  // - `combinedUnsorted` — pure assembly/filter/dedup, no order
  // - `visibleOrder`     — derives order via `stableOrderRef` keyed on `sortKeyRef`
  // - Identity keys:
  //     imported → `contact.id`
  //     external → `ext_<normalized-email-or-phone>`
  //   When an external becomes imported (same email/phone, new UUID),
  //   the new contact.id is substituted into the old ext_* slot in
  //   place — so the new row inherits the old visual position.
  // ----------------------------------------------------------------------

  // Build identity key for a CombinedContact
  const identityKeyFor = useCallback((c: CombinedContact): string => {
    if (!c.isExternal) return c.contact.id;
    const email = (c.contact.email || "").toLowerCase().trim();
    if (email) return `ext_email_${email}`;
    const phone = c.contact.phone ? normPhone(c.contact.phone) : "";
    if (phone) return `ext_phone_${phone}`;
    // Fallback: use the contact id namespaced so it doesn't collide
    return `ext_id_${c.contact.id}`;
  }, []);

  // Stage 1: pure assembly + filter + dedup (no order)
  const combinedUnsorted = useMemo((): CombinedContact[] => {
    const imported: CombinedContact[] = contacts.map((c) => ({
      contact: c,
      isExternal: false,
    }));

    const external: CombinedContact[] = externalContacts
      .filter((c) => !isContactImported(c))
      .map((c) => ({
        contact: c,
        isExternal: true,
      }));

    const combined = [...imported, ...external];

    // Apply category filter only if enabled
    const categoryFiltered = showCategoryFilter
      ? combined.filter(({ contact, isExternal }) => {
          const category = getContactCategory(contact, isExternal);
          return categoryFilter[category];
        })
      : combined;

    // Apply search filter
    if (!searchQuery.trim()) {
      return categoryFiltered;
    }
    return categoryFiltered.filter(({ contact }) =>
      matchesSearch(contact, searchQuery),
    );
  }, [
    contacts,
    externalContacts,
    isContactImported,
    searchQuery,
    categoryFilter,
    showCategoryFilter,
  ]);

  // Stage 2: derive visible order using sticky-order ref
  const stableOrderRef = useRef<string[]>([]);
  const sortKeyRef = useRef<string>("");

  const combinedContacts = useMemo((): CombinedContact[] => {
    // Build identity-key → CombinedContact map for the current data
    const byKey = new Map<string, CombinedContact>();
    for (const c of combinedUnsorted) {
      byKey.set(identityKeyFor(c), c);
    }

    // Sort-key inputs that justify a fresh sort. When ANY of these change,
    // we recompute order from scratch (the user explicitly changed something).
    const sortKey = JSON.stringify({
      sortOrder,
      searchQuery,
      categoryFilter,
      showCategoryFilter,
    });

    const isFreshSort =
      sortKey !== sortKeyRef.current || stableOrderRef.current.length === 0;

    if (isFreshSort) {
      // Compute order from scratch using the data-layer sort.
      let sorted: CombinedContact[];
      if (sortOrder === "alphabetical") {
        sorted = [...combinedUnsorted].sort((a, b) => {
          const nameA = (a.contact.display_name || a.contact.name || "").toLowerCase();
          const nameB = (b.contact.display_name || b.contact.name || "").toLowerCase();
          return nameA.localeCompare(nameB);
        });
      } else {
        const contactsWithIndex = combinedUnsorted.map((item, index) => ({
          index,
          last_communication_at: item.contact.last_communication_at,
        }));
        const sortedIndices = sortByRecentCommunication(contactsWithIndex);
        sorted = sortedIndices.map((item) => combinedUnsorted[item.index]);
      }

      stableOrderRef.current = sorted.map((c) => identityKeyFor(c));
      sortKeyRef.current = sortKey;
      return sorted;
    }

    // Data-only change (silent refresh). Preserve prior visible order.
    //
    // Step A: identity substitution — for each external→imported transition,
    // swap the imported contact's identity key into the slot held by the
    // matching ext_* key.
    //
    // Detection: an imported contact whose normalized email/phone matches an
    // ext_email_* / ext_phone_* key currently in stableOrderRef BUT whose own
    // identity key (contact.id) is NOT yet in stableOrderRef → this is the
    // newly-imported version of a previously-external row.
    const priorOrder = stableOrderRef.current;
    const priorOrderSet = new Set(priorOrder);
    const nextOrder: string[] = priorOrder.slice();

    for (const c of combinedUnsorted) {
      if (c.isExternal) continue;
      const ownKey = c.contact.id;
      if (priorOrderSet.has(ownKey)) continue; // already placed
      // Look for a matching ext_* key currently in prior order
      const email = (c.contact.email || "").toLowerCase().trim();
      const phone = c.contact.phone ? normPhone(c.contact.phone) : "";
      const emailKey = email ? `ext_email_${email}` : null;
      const phoneKey = phone ? `ext_phone_${phone}` : null;
      let substituted = false;
      for (let i = 0; i < nextOrder.length; i++) {
        const k = nextOrder[i];
        if ((emailKey && k === emailKey) || (phoneKey && k === phoneKey)) {
          nextOrder[i] = ownKey;
          substituted = true;
          break;
        }
      }
      if (substituted) {
        // Mark substituted: prevent the same key being substituted twice
        priorOrderSet.add(ownKey);
      }
    }

    // Step B: filter survivors (keys present in current data)
    // Step C: append any not-yet-placed new keys at the tail
    const placedKeys = new Set<string>();
    const result: CombinedContact[] = [];
    for (const key of nextOrder) {
      const c = byKey.get(key);
      if (c) {
        result.push(c);
        placedKeys.add(key);
      }
    }
    for (const c of combinedUnsorted) {
      const key = identityKeyFor(c);
      if (!placedKeys.has(key)) {
        result.push(c);
        placedKeys.add(key);
      }
    }

    // Persist the new visible order
    stableOrderRef.current = result.map((c) => identityKeyFor(c));
    return result;
  }, [
    combinedUnsorted,
    identityKeyFor,
    sortOrder,
    searchQuery,
    categoryFilter,
    showCategoryFilter,
  ]);

  // Reset focused index when list changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [combinedContacts.length]);

  // Handle regular contact selection (toggle)
  const handleSelect = useCallback(
    (contactId: string) => {
      if (selectedIds.includes(contactId)) {
        onSelectionChange(selectedIds.filter((id) => id !== contactId));
      } else {
        onSelectionChange([...selectedIds, contactId]);
      }
    },
    [selectedIds, onSelectionChange]
  );

  // Handle external contact import
  const handleImport = useCallback(
    async (contact: ExtendedContact, autoSelect: boolean = false) => {
      if (!onImportContact || importingIds.has(contact.id)) {
        return;
      }

      setImportingIds((prev) => new Set(prev).add(contact.id));

      try {
        const imported = await onImportContact(contact);
        // Add the imported contact to selection if autoSelect is true
        if (autoSelect) {
          onSelectionChange([...selectedIds, imported.id]);
        }
      } catch (err) {
        // Error handling - parent should handle via try/catch in onImportContact
        logger.error("Failed to import contact:", err);
      } finally {
        setImportingIds((prev) => {
          const next = new Set(prev);
          next.delete(contact.id);
          return next;
        });
      }
    },
    [onImportContact, importingIds, selectedIds, onSelectionChange]
  );

  // Handle selecting an external contact (auto-import and select)
  const handleExternalSelect = useCallback(
    async (contact: ExtendedContact) => {
      if (onImportContact) {
        // Auto-import when selecting external contact
        await handleImport(contact, true);
      }
    },
    [onImportContact, handleImport]
  );

  // Handle row click based on contact type and mode
  const handleRowSelect = useCallback(
    (combined: CombinedContact) => {
      // If onContactClick is provided, use it for viewing details (non-selection mode)
      if (onContactClick) {
        onContactClick(combined.contact);
        return;
      }
      // External contacts: auto-import when selecting, just toggle when deselecting
      if (combined.isExternal && onImportContact && !selectedIds.includes(combined.contact.id)) {
        handleExternalSelect(combined.contact);
      } else {
        handleSelect(combined.contact.id);
      }
    },
    [handleSelect, handleExternalSelect, onContactClick, onImportContact, selectedIds]
  );

  // Handle add contact button click - works for all contacts
  const handleImportButtonClick = useCallback(
    (combined: CombinedContact) => {
      handleImport(combined.contact, false);
    },
    [handleImport]
  );

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((i) =>
            i < combinedContacts.length - 1 ? i + 1 : i
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((i) => (i > 0 ? i - 1 : 0));
          break;
        case "Enter":
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < combinedContacts.length) {
            handleRowSelect(combinedContacts[focusedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setSearchQuery("");
          setFocusedIndex(-1);
          searchInputRef.current?.focus();
          break;
      }
    },
    [combinedContacts, focusedIndex, handleRowSelect]
  );

  // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setFocusedIndex(-1);
  };

  return (
    <div
      className={`flex flex-col overflow-hidden ${className}`}
      data-testid="contact-search-list"
    >
      {/* Search bar + Category filter - flex-shrink-0 keeps them pinned at top */}
      <div className="flex-shrink-0">
        {/* Search Input and Add Manually Button */}
        <div className="p-2 sm:p-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="w-full pl-10 pr-4 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none text-gray-900 bg-white text-sm sm:text-base min-h-[44px]"
                aria-label="Search contacts"
                data-testid="contact-search-input"
              />
              <svg
                className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            {onAddManually && (
              <button
                type="button"
                onClick={onAddManually}
                className="flex-shrink-0 px-2 py-2 sm:px-3 text-sm font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors flex items-center gap-1"
                data-testid="add-manually-button"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                <span className="hidden sm:inline">Add Manually</span>
                <span className="sm:hidden">Add</span>
              </button>
            )}
          </div>
        </div>

        {/* Category Filter - matches SourcePill display */}
        {showCategoryFilter && (
          <div className="px-2 sm:px-3 py-2 border-b border-gray-100 flex items-center gap-1.5 sm:gap-2 overflow-x-auto scrollbar-hide">
          <span className="text-xs text-gray-400 mr-0.5 sm:mr-1 flex-shrink-0">
            <span className="hidden sm:inline">Filter:</span>
            <svg className="w-3.5 h-3.5 sm:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCategoryFilter(prev => ({ ...prev, manual: !prev.manual }));
            }}
            className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
              categoryFilter.manual
                ? "bg-green-100 text-green-700"
                : "bg-gray-100 text-gray-400"
            }`}
            data-testid="filter-manual"
          >
            Manual
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCategoryFilter(prev => ({ ...prev, imported: !prev.imported }));
            }}
            className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
              categoryFilter.imported
                ? "bg-blue-100 text-blue-700"
                : "bg-gray-100 text-gray-400"
            }`}
            data-testid="filter-imported"
          >
            Imported
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCategoryFilter(prev => ({ ...prev, external: !prev.external }));
            }}
            className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
              categoryFilter.external
                ? "bg-violet-100 text-violet-700"
                : "bg-gray-100 text-gray-400"
            }`}
            data-testid="filter-external"
          >
            Contacts App
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCategoryFilter(prev => ({ ...prev, messages: !prev.messages }));
            }}
            className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
              categoryFilter.messages
                ? "bg-amber-100 text-amber-700"
                : "bg-gray-100 text-gray-400"
            }`}
            data-testid="filter-messages"
          >
            Messages
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCategoryFilter(prev => ({ ...prev, outlook: !prev.outlook }));
            }}
            className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
              categoryFilter.outlook
                ? "bg-indigo-100 text-indigo-700"
                : "bg-gray-100 text-gray-400"
            }`}
            data-testid="filter-outlook"
          >
            Outlook
          </button>
        </div>
        )}
      </div>

      {/* Contact List */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Contact list"
        onKeyDown={handleKeyDown}
        data-testid="contact-list"
      >
        {/* Loading State */}
        {isLoading && (
          <div className="p-8 text-center" data-testid="loading-state">
            <div
              className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"
              role="status"
              aria-label="Loading"
            />
            <p className="text-gray-500">Loading contacts...</p>
          </div>
        )}

        {/* Error State */}
        {!isLoading && error && (
          <div className="p-8 text-center" data-testid="error-state">
            <svg
              className="w-12 h-12 text-red-400 mx-auto mb-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-red-600">{error}</p>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && combinedContacts.length === 0 && (
          <div
            className="p-8 text-center text-gray-500"
            data-testid="empty-state"
          >
            <svg
              className="w-16 h-16 text-gray-300 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
            {searchQuery ? (
              <p>No contacts match &quot;{searchQuery}&quot;</p>
            ) : (
              <p>No contacts available</p>
            )}
          </div>
        )}

        {/* Contact List Items */}
        {!isLoading &&
          !error &&
          combinedContacts.map((combined, index) => {
            const isSelected = selectedIds.includes(combined.contact.id);
            const isImporting = importingIds.has(combined.contact.id);
            const isAdded = addedContactIds.has(combined.contact.id);
            // Selection mode (audit/edit): checkboxes, no buttons
            // Preview mode (contacts screen): buttons, no checkboxes
            const isSelectionMode = !onContactClick;

            return (
              <ContactRow
                key={combined.contact.id}
                contact={combined.contact}
                isExternal={combined.isExternal}
                isSelected={isSelected}
                isAdded={isAdded}
                isAdding={isImporting}
                showCheckbox={isSelectionMode}
                showImportButton={!isSelectionMode && !!onImportContact && (combined.isExternal || showAddButtonForImported)}
                onSelect={() => handleRowSelect(combined)}
                onImport={() => handleImportButtonClick(combined)}
                className={focusedIndex === index ? "ring-2 ring-inset ring-purple-500" : ""}
              />
            );
          })}
      </div>

    </div>
  );
}

export default ContactSearchList;
