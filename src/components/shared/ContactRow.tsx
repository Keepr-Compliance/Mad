import React from "react";
import { SourcePill, ImportStatusPill, mapToSourcePillSource } from "./SourcePill";
import type { ExtendedContact } from "../../types/components";

export interface ContactRowProps {
  /** The contact to display */
  contact: ExtendedContact;
  /** Whether this is an external contact (from Contacts App, not yet imported) */
  isExternal?: boolean;
  /** Whether this contact is currently selected */
  isSelected?: boolean;
  /** Whether this contact has been added to the transaction */
  isAdded?: boolean;
  /** Whether this contact is currently being added (loading state) */
  isAdding?: boolean;
  /** Whether to show a checkbox for selection */
  showCheckbox?: boolean;
  /** Whether to show import button for external contacts */
  showImportButton?: boolean;
  /**
   * Compact mode (BACKLOG-1898 Phase-1 layout polish). Opt-in, default `false`
   * so shared consumers (ContactSelectModal, transaction add-contact flows)
   * are unaffected. When `true`:
   * - The avatar circle is not rendered.
   * - The source/import-status pills only render at wide (>=1200px) viewports
   *   instead of `sm:` (>=640px).
   * - The per-row "+ Add Contact" button is never rendered (import happens via
   *   the detail pane's Import button instead).
   */
  compact?: boolean;
  /** Called when the row is selected (clicked or keyboard) */
  onSelect?: () => void;
  /** Called when the import button is clicked */
  onImport?: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Gets the first initial from a name for avatar display
 */
function getInitial(name: string | undefined): string {
  if (!name) return "?";
  return name.charAt(0).toUpperCase();
}

/**
 * Gets the display name for a contact, preferring display_name over name
 */
function getDisplayName(contact: ExtendedContact): string {
  return contact.display_name || contact.name || "Unknown Contact";
}

/**
 * Gets the primary email for display
 */
function getPrimaryEmail(contact: ExtendedContact): string | undefined {
  // Prefer allEmails array if available, otherwise fall back to email field
  if (contact.allEmails && contact.allEmails.length > 0) {
    return contact.allEmails[0];
  }
  return contact.email;
}

/**
 * Checks if a contact is external (message-derived, can be imported)
 * External contacts are those derived from message participants rather than explicitly imported
 */
function isExternalContact(contact: ExtendedContact): boolean {
  // is_message_derived can be number (1) or boolean (true)
  return contact.is_message_derived === 1 || contact.is_message_derived === true;
}

/**
 * ContactRow Component
 *
 * Displays a single contact in a horizontal row format with optional
 * checkbox selection, source pill, and import button for external contacts.
 *
 * @example
 * // Basic usage with selection
 * <ContactRow
 *   contact={contact}
 *   isSelected={selectedId === contact.id}
 *   onSelect={() => setSelectedId(contact.id)}
 * />
 *
 * @example
 * // With checkbox and import button
 * <ContactRow
 *   contact={contact}
 *   showCheckbox
 *   showImportButton
 *   isSelected={selected.has(contact.id)}
 *   onSelect={() => toggleSelection(contact.id)}
 *   onImport={() => importContact(contact)}
 * />
 */
export function ContactRow({
  contact,
  isExternal: isExternalProp,
  isSelected = false,
  isAdded = false,
  isAdding = false,
  showCheckbox = false,
  showImportButton = false,
  compact = false,
  onSelect,
  onImport,
  className = "",
}: ContactRowProps): React.ReactElement {
  const displayName = getDisplayName(contact);
  const email = getPrimaryEmail(contact);
  const initial = getInitial(displayName);
  // Use prop if provided, otherwise check contact's is_message_derived flag
  const isExternal = isExternalProp ?? isExternalContact(contact);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.();
    }
  };

  const handleImportClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onImport?.();
  };

  const baseClasses = [
    "flex items-center gap-3 px-3 py-3 sm:py-2 border-b border-gray-100",
    "cursor-pointer transition-colors duration-150",
    isSelected ? "bg-purple-50" : "hover:bg-gray-50",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      className={baseClasses}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      data-testid="contact-row"
    >
      {/* Checkbox */}
      {showCheckbox && (
        <div className="flex-shrink-0">
          <div
            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
              isSelected
                ? "bg-purple-600 border-purple-600"
                : "border-gray-300 bg-white"
            }`}
            data-testid="contact-row-checkbox"
          >
            {isSelected && (
              <svg
                className="w-3 h-3 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Avatar - hidden on mobile, visible on sm+ (omitted entirely in compact mode) */}
      {!compact && (
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-600 items-center justify-center hidden sm:flex"
          data-testid="contact-row-avatar"
        >
          <span className="text-white text-sm font-medium">{initial}</span>
        </div>
      )}

      {/* Name, Source Pill, and Email */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p
            className="text-sm font-medium text-gray-900 truncate"
            data-testid="contact-row-name"
          >
            {displayName}
          </p>
          <span className={compact ? "hidden min-[1200px]:inline-flex" : "hidden sm:inline-flex"}>
            <SourcePill
              source={mapToSourcePillSource(contact.source, isExternal)}
              size="sm"
            />
          </span>
          {!isAdded && (
            <span className={compact ? "hidden min-[1200px]:inline-flex" : "hidden sm:inline-flex"}>
              <ImportStatusPill isImported={!isExternal} size="sm" />
            </span>
          )}
        </div>
        {email && (
          <p
            className="text-xs text-gray-500 truncate"
            data-testid="contact-row-email"
          >
            {email}
          </p>
        )}
      </div>

      {/* Adding spinner */}
      {isAdding && (
        <div
          className="flex-shrink-0 flex items-center gap-1.5 px-2 py-1 text-purple-600 text-xs font-medium"
          data-testid="contact-row-adding-indicator"
        >
          <svg
            className="w-3.5 h-3.5 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
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
          Adding...
        </div>
      )}

      {/* Added indicator with checkmark */}
      {!isAdding && isAdded && (
        <div
          className="flex-shrink-0 flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium"
          data-testid="contact-row-added-indicator"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
          Added
        </div>
      )}

      {/* Add Contact Button (never rendered in compact mode — import happens
          via the detail pane's Import button instead) */}
      {!compact && !isAdding && !isAdded && showImportButton && (
        <button
          type="button"
          onClick={handleImportClick}
          className="flex-shrink-0 px-2 py-1 text-xs font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded transition-colors"
          aria-label={`Add ${displayName}`}
          data-testid="contact-row-import-button"
        >
          + Add Contact
        </button>
      )}
    </div>
  );
}

export default ContactRow;
