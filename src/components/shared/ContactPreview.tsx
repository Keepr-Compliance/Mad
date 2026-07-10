import React from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import { SourcePill, ImportStatusPill, mapToSourcePillSource } from "./SourcePill";
import { formatRoleLabel } from "../../utils/transactionRoleUtils";
import type { ExtendedContact } from "../../types/components";

/**
 * Transaction associated with a contact
 */
export interface ContactTransaction {
  id: string;
  property_address: string;
  role: string;
}

export interface ContactPreviewProps {
  /** Contact to display - uses ExtendedContact for all contacts */
  contact: ExtendedContact;
  /** Whether this is an external contact (not yet imported) */
  isExternal: boolean;
  /** Transactions this contact is involved in (imported only) */
  transactions?: ContactTransaction[];
  /** Loading state for transactions */
  isLoadingTransactions?: boolean;
  /** Callback to edit the contact (imported only) */
  onEdit?: () => void;
  /** Callback to remove the contact */
  onRemove?: () => void;
  /** Callback to import the contact (external only) */
  onImport?: () => void;
  /** Callback to close the preview */
  onClose: () => void;
  /**
   * Callback fired when a transaction row is clicked. Receives the transaction
   * id so the caller can open that transaction (BACKLOG-1898 T5). When omitted,
   * transaction rows render as static (non-interactive) content.
   */
  onTransactionClick?: (transactionId: string) => void;
  /**
   * Render mode (BACKLOG-1898 T5):
   * - "modal" (default): renders inside a ResponsiveModal shell with backdrop —
   *   the original behaviour; existing modal callers are unaffected.
   * - "pane": renders the same body inline (no ResponsiveModal shell / backdrop)
   *   for the wide-viewport master-detail two-pane layout.
   */
  variant?: "modal" | "pane";
}

/**
 * Gets the display name for a contact
 */
function getDisplayName(contact: ExtendedContact): string {
  return contact.display_name || contact.name || "Unknown Contact";
}

/**
 * Gets the first initial from a name for avatar display
 */
function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/**
 * ContactPreview Component
 *
 * Displays a modal preview of contact details when a ContactCard is clicked.
 * Shows full contact information including:
 * - Large avatar with initial
 * - Name, emails, phones, company, title
 * - Source pill (Imported/External)
 * - Transaction list for imported contacts
 * - "Not yet imported" message for external contacts
 * - Contextual action button (Edit for imported, Import for external)
 *
 * @example
 * // Imported contact with transactions
 * <ContactPreview
 *   contact={importedContact}
 *   isExternal={false}
 *   transactions={transactions}
 *   onEdit={() => handleEdit()}
 *   onClose={() => setPreviewContact(null)}
 * />
 *
 * @example
 * // External contact
 * <ContactPreview
 *   contact={externalContact}
 *   isExternal={true}
 *   onImport={() => handleImport()}
 *   onClose={() => setPreviewContact(null)}
 * />
 */
export function ContactPreview({
  contact,
  isExternal,
  transactions = [],
  isLoadingTransactions = false,
  onEdit,
  onRemove,
  onImport,
  onClose,
  onTransactionClick,
  variant = "modal",
}: ContactPreviewProps): React.ReactElement {
  const displayName = getDisplayName(contact);
  const initial = getInitial(displayName);
  const sourcePillSource = mapToSourcePillSource(contact.source, isExternal);

  // Collect emails and phones
  const emails =
    contact.allEmails && contact.allEmails.length > 0
      ? contact.allEmails
      : contact.email
        ? [contact.email]
        : [];

  const phones =
    contact.allPhones && contact.allPhones.length > 0
      ? contact.allPhones
      : contact.phone
        ? [contact.phone]
        : [];

  const body = (
    <div
      data-testid="contact-preview-modal"
      className={
        variant === "pane"
          ? "flex flex-col h-full min-h-0 bg-white overflow-y-auto"
          : undefined
      }
    >
        {/* Header with close button */}
        <div className="flex justify-end p-3 sm:p-4">
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
            aria-label="Close preview"
            data-testid="contact-preview-close"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Contact Info Section */}
        <div className="px-6 pb-6 text-center">
          {/* Large Avatar */}
          <div
            className="w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold text-2xl mx-auto mb-4"
            data-testid="contact-preview-avatar"
          >
            {initial}
          </div>

          {/* Name */}
          <h2
            className="text-xl font-bold text-gray-900 mb-2"
            data-testid="contact-preview-name"
          >
            {displayName}
          </h2>

          {/* Contact Details */}
          <div className="text-gray-600 space-y-1 mb-4">
            {emails.length > 0 && (
              <p data-testid="contact-preview-emails">{emails.join(" | ")}</p>
            )}
            {phones.length > 0 && (
              <p data-testid="contact-preview-phones">{phones.join(" | ")}</p>
            )}
            {contact.company && (
              <p className="font-medium" data-testid="contact-preview-company">
                {contact.company}
              </p>
            )}
            {contact.title && (
              <p className="text-sm" data-testid="contact-preview-title">
                {contact.title}
              </p>
            )}
          </div>

          {/* Source & Status Pills */}
          <div className="flex items-center gap-2">
            <SourcePill source={sourcePillSource} size="md" />
            <ImportStatusPill isImported={!isExternal} size="md" />
          </div>
        </div>

        {/* Transactions Section (imported contacts only) */}
        {!isExternal && (isLoadingTransactions || transactions.length > 0) && (
        <div className="flex-1 overflow-y-auto border-t border-gray-200 px-6 py-4">
          {isLoadingTransactions ? (
            <div
              className="text-center py-4"
              data-testid="contact-preview-loading"
            >
              <div className="w-6 h-6 border-2 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                Transactions ({transactions.length})
              </h3>
              <div
                className="space-y-2"
                data-testid="contact-preview-transactions"
              >
                {transactions.map((txn) => (
                  <button
                    key={txn.id}
                    type="button"
                    onClick={
                      onTransactionClick
                        ? () => onTransactionClick(txn.id)
                        : undefined
                    }
                    disabled={!onTransactionClick}
                    className="w-full flex items-center justify-between text-sm text-left rounded-lg -mx-2 px-2 py-1.5 transition-colors enabled:hover:bg-purple-50 enabled:cursor-pointer disabled:cursor-default"
                    data-testid={`contact-preview-transaction-${txn.id}`}
                  >
                    <span className="text-gray-900 truncate flex-1">
                      {txn.property_address}
                    </span>
                    <span className="text-gray-500 ml-2 flex-shrink-0">
                      {formatRoleLabel(txn.role)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        )}

        {/* Footer with Action Buttons */}
        <div className="border-t border-gray-200 p-4 pb-safe flex justify-between gap-3">
          {isExternal ? (
            <button
              onClick={onImport}
              className="px-4 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-indigo-700 transition-all shadow-md"
              data-testid="contact-preview-import"
            >
              Import to Software
            </button>
          ) : (
            <>
              {onRemove && (
                <button
                  onClick={onRemove}
                  className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg font-medium transition-all"
                  data-testid="contact-preview-remove"
                >
                  Remove
                </button>
              )}
              {onEdit && (
                <button
                  onClick={onEdit}
                  className="ml-auto px-4 py-2 bg-gradient-to-r from-purple-500 to-pink-600 text-white font-semibold rounded-lg hover:from-purple-600 hover:to-pink-700 transition-all shadow-md"
                  data-testid="contact-preview-edit"
                >
                  Edit Contact
                </button>
              )}
            </>
          )}
        </div>
      </div>
  );

  // "pane" variant (BACKLOG-1898 T5): render the same body inline, WITHOUT the
  // ResponsiveModal shell/backdrop, for the wide-viewport master-detail layout.
  if (variant === "pane") {
    return body;
  }

  // "modal" variant (default): original behaviour — wrapped in ResponsiveModal.
  return (
    <ResponsiveModal
      onClose={onClose}
      overlayClassName="bg-black bg-opacity-50"
      testId="contact-preview-backdrop"
      panelClassName="max-w-md max-h-[80vh] !h-auto !w-[calc(100%-2rem)] rounded-xl shadow-2xl"
    >
      {body}
    </ResponsiveModal>
  );
}

export default ContactPreview;
