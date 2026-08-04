import React, { useState } from "react";
import type { ExtendedContact } from "../../types/components";
import { labelForContact } from "../../utils/contactDisplayLabel";
import type { FoldedRecord } from "../../utils/contactCollapseDisclosure";
import {
  collapsedRecordSummary,
  describeIdentifier,
} from "../../utils/contactCollapseVocabulary";

export interface ContactRowProps {
  /** The contact to display */
  contact: ExtendedContact;
  /**
   * Whether this is an external contact (from Contacts App, not yet imported).
   * Retained for API compatibility; as of BACKLOG-2356 the row is name-only and
   * no longer renders source/import-status pills, so this no longer affects
   * rendering. Import gating is driven by `showImportButton` from the parent.
   */
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
   * Whether to show a "+ Add" affordance (BACKLOG-2400 two-pane picker). Unlike
   * `showImportButton` (which calls `onImport` to import WITHOUT selecting), this
   * button calls `onSelect` — the row's add-to-selection action — so a single
   * click moves the contact into the "Added" column. Used by the
   * ContactAssignmentStep two-pane selection context ONLY; every other consumer
   * leaves it `false` (default) and is unaffected.
   */
  showAddButton?: boolean;
  /**
   * Records the picker folded INTO this row (BACKLOG-2459), from both the
   * main-process suppression and the renderer's residual pass — see
   * `contactCollapseDisclosure.foldedRecordsFor`.
   *
   * The founder watched `picker: 1126 in -> dup-suppressed 21 -> shown 1105` and
   * said "a user must have a way to see that". Twenty-one people were folded
   * together and nothing on screen said so; he only noticed because he already
   * knew one contact existed twice. A contact here is a party to a transaction
   * under audit, so two people wrongly folded together is a compliance error —
   * and it was being made with no notice and nothing to inspect.
   *
   * Undefined/empty (the overwhelming majority of rows) renders nothing at all.
   */
  collapsedRecords?: FoldedRecord[];
  /**
   * Compact mode (BACKLOG-1898 Phase-1 layout polish). Opt-in, default `false`
   * so shared consumers (ContactSelectModal, transaction add-contact flows)
   * are unaffected. When `true`:
   * - The avatar circle is not rendered.
   * - The per-row "+ Add Contact" button is never rendered (import happens via
   *   the detail pane's Import button instead).
   *
   * Note (BACKLOG-2356): rows are now name-only in every mode, so `compact` no
   * longer changes pill visibility (pills were removed entirely).
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
 * Gets the label for a contact.
 *
 * BACKLOG-2461: was `display_name || name || "Unknown Contact"`. On a verified
 * store 18 of 1,124 macOS contacts have no name, so all 18 rendered as the same
 * string and could not be told apart — while their phone numbers sat unused on
 * the same object. The chain now falls through to what we actually hold, and is
 * shared with the audit PDF so the two surfaces cannot drift apart again (they
 * previously used two different literals for one condition).
 */
function getDisplayName(contact: ExtendedContact): string {
  return labelForContact(contact);
}

/**
 * ContactRow Component
 *
 * Displays a single contact in a horizontal row format (name only, as of
 * BACKLOG-2356) with optional checkbox selection and an import button for
 * external contacts.
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
  isSelected = false,
  isAdded = false,
  isAdding = false,
  showCheckbox = false,
  showImportButton = false,
  showAddButton = false,
  collapsedRecords,
  compact = false,
  onSelect,
  onImport,
  className = "",
}: ContactRowProps): React.ReactElement {
  const displayName = getDisplayName(contact);
  const initial = getInitial(displayName);

  // BACKLOG-2459 — the folded records, and whether the user has asked to see
  // which ones. Collapsed by default: the disclosure has to be quiet enough to
  // sit on 1,105 rows without becoming noise, and loud enough that nobody can
  // say they were not told.
  const collapsedCount = collapsedRecords?.length ?? 0;
  const [showCollapsed, setShowCollapsed] = useState(false);

  const handleCollapsedToggle = (event: React.MouseEvent) => {
    // The row's own onClick opens the contact; expanding the evidence must not.
    event.stopPropagation();
    setShowCollapsed((open) => !open);
  };

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

  // BACKLOG-2400: "+ Add" affordance triggers the row's selection action
  // (onSelect). stopPropagation prevents the row's own onClick from ALSO firing
  // onSelect (a double-toggle that would cancel itself out).
  const handleAddClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onSelect?.();
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
      data-contact-id={contact.id}
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

      {/* Name only (BACKLOG-2356). The secondary email/phone line and the
          source/import-status pills were intentionally removed so every
          ContactRow (picker + Clients & Contacts list) shows just the name;
          full details live in the contact detail/preview pane. */}
      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-medium text-gray-900 truncate"
          data-testid="contact-row-name"
        >
          {displayName}
        </p>

        {/* BACKLOG-2459 — say that a collapse happened, and let it be inspected.
            The count is a count of records the user owns, written out next to
            what it counts; there is no score anywhere in this block. */}
        {collapsedCount > 0 && (
          <>
            <button
              type="button"
              onClick={handleCollapsedToggle}
              aria-expanded={showCollapsed}
              className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-purple-700 hover:text-purple-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded"
              data-testid="contact-row-collapsed-toggle"
            >
              {collapsedCount} {collapsedCount === 1 ? "record" : "records"} combined
              <svg
                className={`w-3 h-3 transition-transform ${showCollapsed ? "rotate-180" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showCollapsed && (
              <ul
                className="mt-1 mb-1 space-y-1.5 border-l-2 border-purple-200 pl-2"
                data-testid="contact-row-collapsed-detail"
              >
                {(collapsedRecords ?? []).map((record) => (
                  <li key={record.key} data-testid="contact-row-collapsed-record">
                    <p
                      className="text-xs font-medium text-gray-900 truncate"
                      data-testid="contact-row-collapsed-record-name"
                    >
                      {record.label?.trim() || "No name"}
                    </p>
                    {/* The sentence asserts ONLY what the collapse established:
                        which record was folded in, where it came from, and the
                        detail the two agreed on. Nothing about this row's own
                        source, and nothing about anything being "already saved"
                        — the picker checks neither, and this row is frequently
                        an unimported address-book record still showing its own
                        import button. See `collapsedRecordSummary`. */}
                    <p
                      className="text-xs text-gray-500"
                      data-testid="contact-row-collapsed-record-reason"
                    >
                      {collapsedRecordSummary({
                        foldedLabel: record.label,
                        foldedSourceLabel: record.sourceLabel,
                        identifierPhrase: describeIdentifier(record.matchedOn, [
                          record.matchedValue,
                        ]),
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
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

      {/* "+ Add" affordance (BACKLOG-2400 two-pane picker). Replaces the checkbox
          in the ContactAssignmentStep "Available" column: one click adds the
          contact (imports it first if external) and moves it to the "Added"
          column. */}
      {!isAdding && !isAdded && showAddButton && (
        <button
          type="button"
          onClick={handleAddClick}
          className="flex-shrink-0 px-3 py-1 text-xs font-semibold text-purple-700 bg-purple-100 hover:bg-purple-200 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
          aria-label={`Add ${displayName}`}
          data-testid="contact-row-add-button"
        >
          + Add
        </button>
      )}
    </div>
  );
}

export default ContactRow;
