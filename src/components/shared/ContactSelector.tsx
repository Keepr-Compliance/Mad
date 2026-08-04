/**
 * ContactSelector Component
 *
 * A reusable multi-select contact selection component with search/filter functionality.
 * This is a controlled component that receives contacts and selected IDs from the parent.
 *
 * Features:
 * - Search filtering by name, email, or phone (case-insensitive)
 * - Multi-select via checkboxes
 * - Keyboard navigation (arrow keys, space/enter to toggle, escape to clear search)
 * - Selection count footer
 * - Loading and empty states
 * - ARIA accessibility attributes
 *
 * @see BACKLOG-418: Redesign Contact Selection UX (Select First, Assign Roles Second)
 */

import React, {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
  forwardRef,
} from "react";
import type { ExtendedContact } from "../../types/components";
import { labelForContact } from "../../utils/contactDisplayLabel";
import { formatPhoneNumber } from "../../utils/phoneNormalization";

export interface ContactSelectorProps {
  /** All available contacts (loaded once by parent) */
  contacts: ExtendedContact[];
  /** Currently selected contact IDs */
  selectedIds: string[];
  /** Callback when selection changes */
  onSelectionChange: (selectedIds: string[]) => void;
  /** Show loading state */
  isLoading?: boolean;
  /** Error message to display */
  error?: string | null;
  /** Maximum number of contacts that can be selected (optional) */
  maxSelection?: number;
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /** Optional class name for styling */
  className?: string;
  /** Show the "Include message contacts" filter checkbox (TASK-1752) */
  showMessageContactsFilter?: boolean;
}

/**
 * ContactListItem - Individual contact row with checkbox
 */
interface ContactListItemProps {
  contact: ExtendedContact;
  isSelected: boolean;
  isFocused: boolean;
  isDisabled: boolean;
  onToggle: () => void;
}

const ContactListItem = forwardRef<HTMLDivElement, ContactListItemProps>(
  function ContactListItem(
    { contact, isSelected, isFocused, isDisabled, onToggle },
    ref
  ) {
    // BACKLOG-2461: falls through organisation -> phone -> email -> "No name"
    // instead of the bare "Unknown" this used to show.
    const displayName = labelForContact(contact);

    // Get primary email and phone.
    //
    // BACKLOG-2461: when the label above already fell back to one of these, the
    // row printed the same string twice (name line and detail line), which
    // reads as a rendering fault rather than as a contact.
    const rawEmail = contact.email || (contact.allEmails?.[0] ?? null);
    const rawPhone = contact.phone || (contact.allPhones?.[0] ?? null);
    const email = rawEmail === displayName ? null : rawEmail;
    const phone =
      rawPhone && formatPhoneNumber(rawPhone) === displayName ? null : rawPhone;

    return (
      <div
        ref={ref}
        role="option"
        aria-selected={isSelected}
        aria-disabled={isDisabled}
        tabIndex={isFocused ? 0 : -1}
        onClick={() => !isDisabled && onToggle()}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !isDisabled) {
            e.preventDefault();
            onToggle();
          }
        }}
        className={`flex items-center p-3 cursor-pointer border-b border-gray-100 transition-all ${
          isSelected ? "bg-purple-50" : "bg-white hover:bg-gray-50"
        } ${isFocused ? "ring-2 ring-inset ring-purple-500" : ""} ${
          isDisabled ? "opacity-50 cursor-not-allowed" : ""
        }`}
      >
        {/* Checkbox */}
        <div
          className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mr-3 ${
            isSelected
              ? "bg-purple-500 border-purple-500"
              : "border-gray-300 bg-white"
          }`}
          aria-hidden="true"
        >
          {isSelected && (
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </div>

        {/* Avatar */}
        <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 mr-3">
          {displayName.charAt(0).toUpperCase()}
        </div>

        {/* Contact Info */}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 truncate">{displayName}</div>
          <div className="text-sm text-gray-500 truncate">
            {email}
            {email && phone && " | "}
            {phone}
          </div>
        </div>
      </div>
    );
  }
);

/**
 * ContactSelector - Main component
 */
export function ContactSelector({
  contacts,
  selectedIds,
  onSelectionChange,
  isLoading = false,
  error = null,
  maxSelection,
  searchPlaceholder = "Search contacts...",
  className,
  showMessageContactsFilter = false,
}: ContactSelectorProps): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [includeMessageContacts, setIncludeMessageContacts] = useState(false);

  // Refs for keyboard navigation
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter contacts by search query and message contacts filter (TASK-1752)
  // TASK-1760: Selected contacts are always shown regardless of filter state
  const filteredContacts = useMemo(() => {
    let filtered = contacts;

    // Apply message contacts filter if enabled and filter is active
    if (showMessageContactsFilter && !includeMessageContacts) {
      filtered = filtered.filter((contact) => {
        // Always show selected contacts regardless of filter
        if (selectedIds.includes(contact.id)) {
          return true;
        }
        // Filter out contacts that are message-only (source is 'sms' or is_message_derived is true)
        const isMessageOnly =
          contact.source === "sms" ||
          contact.is_message_derived === true ||
          contact.is_message_derived === 1;
        return !isMessageOnly;
      });
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((contact) => {
        const name = (contact.display_name || contact.name || "").toLowerCase();
        const email = (contact.email || "").toLowerCase();
        const phone = (contact.phone || "").toLowerCase();
        // Also check allEmails and allPhones arrays
        const allEmails = (contact.allEmails || []).join(" ").toLowerCase();
        const allPhones = (contact.allPhones || []).join(" ").toLowerCase();
        return (
          name.includes(query) ||
          email.includes(query) ||
          phone.includes(query) ||
          allEmails.includes(query) ||
          allPhones.includes(query)
        );
      });
    }

    return filtered;
  }, [contacts, searchQuery, showMessageContactsFilter, includeMessageContacts, selectedIds]);

  // Reset focused index when filtered list changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [filteredContacts.length]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < itemRefs.current.length) {
      const element = itemRefs.current[focusedIndex];
      if (element) {
        // scrollIntoView may not be available in test environments (JSDOM)
        if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        element.focus();
      }
    }
  }, [focusedIndex]);

  // Check if selection is at max capacity
  const isAtMaxSelection = maxSelection
    ? selectedIds.length >= maxSelection
    : false;

  // Toggle contact selection
  const handleToggle = useCallback(
    (contactId: string) => {
      const isSelected = selectedIds.includes(contactId);
      if (isSelected) {
        onSelectionChange(selectedIds.filter((id) => id !== contactId));
      } else {
        if (maxSelection && selectedIds.length >= maxSelection) {
          return; // Max reached, don't add
        }
        onSelectionChange([...selectedIds, contactId]);
      }
    },
    [selectedIds, onSelectionChange, maxSelection]
  );

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((i) =>
            i < filteredContacts.length - 1 ? i + 1 : i
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((i) => (i > 0 ? i - 1 : 0));
          break;
        case " ":
        case "Enter":
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < filteredContacts.length) {
            const contact = filteredContacts[focusedIndex];
            const isCurrentlySelected = selectedIds.includes(contact.id);
            // Only toggle if not at max or if deselecting
            if (!isAtMaxSelection || isCurrentlySelected) {
              handleToggle(contact.id);
            }
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
    [filteredContacts, focusedIndex, handleToggle, isAtMaxSelection, selectedIds]
  );

  // Handle search input change
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setFocusedIndex(-1);
  };

  // Set ref for a list item
  const setItemRef = (index: number) => (el: HTMLDivElement | null) => {
    itemRefs.current[index] = el;
  };

  return (
    <div
      className={`flex flex-col overflow-hidden ${
        className || ""
      }`}
    >
      {/* Selection Count */}
      <div className="p-3 text-sm text-gray-600">
        Selected: {selectedIds.length} contact
        {selectedIds.length !== 1 ? "s" : ""}
        {maxSelection && (
          <span className="text-gray-400"> (max {maxSelection})</span>
        )}
      </div>

      {/* Search Input */}
      <div className="p-3">
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            placeholder={searchPlaceholder}
            aria-label="Search contacts"
            className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none text-gray-900 bg-white min-h-[44px]"
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
      </div>

      {/* Message Contacts Filter (TASK-1752) */}
      {showMessageContactsFilter && (
        <div className="px-3 py-2">
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeMessageContacts}
              onChange={(e) => setIncludeMessageContacts(e.target.checked)}
              className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 cursor-pointer"
            />
            <span>Include message contacts</span>
          </label>
        </div>
      )}

      {/* Contact List */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Contacts"
        aria-multiselectable="true"
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-y-auto max-h-80 pr-2"
      >
        {/* Loading State */}
        {isLoading && (
          <div className="p-8 text-center">
            <svg
              className="w-8 h-8 text-purple-500 mx-auto mb-3 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <p className="text-gray-500">Loading contacts...</p>
          </div>
        )}

        {/* Error State */}
        {error && !isLoading && (
          <div className="p-8 text-center">
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
        {!isLoading && !error && filteredContacts.length === 0 && (
          <div className="p-8 text-center text-gray-500">
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
              <p>No contacts match "{searchQuery}"</p>
            ) : (
              <p>No contacts available</p>
            )}
          </div>
        )}

        {/* Contact List Items */}
        {!isLoading &&
          !error &&
          filteredContacts.map((contact, index) => {
            const isSelected = selectedIds.includes(contact.id);
            const isDisabled = isAtMaxSelection && !isSelected;

            return (
              <ContactListItem
                key={contact.id}
                ref={setItemRef(index)}
                contact={contact}
                isSelected={isSelected}
                isFocused={focusedIndex === index}
                isDisabled={isDisabled}
                onToggle={() => handleToggle(contact.id)}
              />
            );
          })}
      </div>
    </div>
  );
}

export default ContactSelector;
