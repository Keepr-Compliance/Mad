import React, { useState, useCallback } from "react";
import {
  ContactFormModal,
  RemoveConfirmationModal,
  BlockingTransactionsModal,
  useContactList,
  useContactsLayout,
  ExtendedContact,
} from "./contact";
import { useAppStateMachine } from "../appCore";
import { ContactSearchList } from "./shared/ContactSearchList";
import {
  ContactPreview,
  type ContactTransaction,
} from "./shared/ContactPreview";
import logger from '../utils/logger';
import { OfflineNotice } from './common/OfflineNotice';

interface ContactsProps {
  userId: string;
  onClose: () => void;
  /**
   * Open a transaction by id (BACKLOG-1898 T5). Wired from AppModals so a click
   * on a transaction row in the contact detail card opens that transaction.
   * Optional so standalone/test renders of Contacts don't require it.
   */
  onOpenTransaction?: (transactionId: string) => void;
}

/**
 * Contacts Component
 * Full contact management interface using ContactSearchList for consistent UX
 * - List all contacts (imported + external from Contacts App)
 * - Import external contacts
 * - Add/Edit/Delete contacts
 * - View contact details
 */
function Contacts({ userId, onClose, onOpenTransaction }: ContactsProps) {
  // Database initialization guard (belt-and-suspenders defense)
  const { isDatabaseInitialized } = useAppStateMachine();

  // Responsive master-detail layout state (BACKLOG-1898 T5).
  // Owns selected contact + narrow/wide viewport class; keeps this component
  // compositional (no layout logic inline).
  const {
    isNarrow,
    showDetailPane,
    selectContact,
    clearSelection,
    selectedContactId,
  } = useContactsLayout();

  // Modal states
  const [showAddEdit, setShowAddEdit] = useState(false);
  const [selectedContact, setSelectedContact] = useState<
    ExtendedContact | undefined
  >(undefined);

  // ContactPreview state (for external contacts)
  const [previewContact, setPreviewContact] = useState<ExtendedContact | null>(
    null
  );
  const [previewTransactions, setPreviewTransactions] = useState<
    ContactTransaction[]
  >([]);
  const [loadingPreviewTransactions, setLoadingPreviewTransactions] =
    useState(false);

  // Track imported contact IDs for visual feedback
  const [importedContactIds, setImportedContactIds] = useState<Set<string>>(
    new Set()
  );

  // Clear stale imported IDs when a contact is deleted
  const handleContactDeleted = useCallback(() => {
    // Clear all imported IDs - the external contact may reappear and shouldn't show checkmark
    setImportedContactIds(new Set());
  }, []);

  // Contact list and removal state
  const {
    contacts,
    loading,
    error,
    loadContacts,
    silentLoadContacts,
    handleRemoveContact,
    handleConfirmRemove,
    showRemoveConfirmation,
    setShowRemoveConfirmation,
    setContactToRemove,
    showBlockingModal,
    setShowBlockingModal,
    blockingTransactions,
    setBlockingTransactions,
    // External contacts (from macOS Contacts app, etc.)
    externalContacts,
    externalContactsLoading,
  } = useContactList(userId, { onContactDeleted: handleContactDeleted });

  // Helper to check if a contact is external (message-derived or from Contacts app)
  const isExternal = (contact: ExtendedContact): boolean => {
    return contact.is_message_derived === 1 || contact.is_message_derived === true;
  };

  // DEFENSIVE CHECK: Return loading state if database not initialized
  if (!isDatabaseInitialized) {
    return (
      <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
          <p className="text-gray-500 text-sm">Waiting for database...</p>
        </div>
      </div>
    );
  }

  // Load transactions for a contact using checkCanDelete (returns transactions list)
  const loadContactTransactions = useCallback(async (contactId: string) => {
    setLoadingPreviewTransactions(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await window.api.contacts.checkCanDelete(contactId);
      if (result.success && result.transactions) {
        setPreviewTransactions(
          // Backend (getTransactionsByContact) already formats `roles` as a
          // single comma-joined display string (e.g. "client",
          // "Buyer, Seller") — it is never a string[] at this boundary.
          // Calling `.join` on it threw `TypeError: t.roles?.join is not a
          // function` (BACKLOG-1898).
          result.transactions.map((t: { id: string; property_address: string; roles?: string }) => ({
            id: t.id,
            property_address: t.property_address,
            role: t.roles || "Contact",
          }))
        );
      } else {
        setPreviewTransactions([]);
      }
    } catch (error) {
      // Previously a bare `catch {}` swallowed this error and silently
      // rendered an empty Transactions section (BACKLOG-1898).
      logger.error("Failed to load contact transactions:", error, { contactId });
      setPreviewTransactions([]);
    } finally {
      setLoadingPreviewTransactions(false);
    }
  }, []);

  // Handle clicking on a contact to view details
  const handleContactClick = useCallback((contact: ExtendedContact) => {
    // Open the detail view (pane on wide viewports, full-screen card on narrow)
    setPreviewContact(contact);
    setPreviewTransactions([]);
    selectContact(contact.id);

    if (isExternal(contact)) {
      // External contact - no transactions to load
      setLoadingPreviewTransactions(false);
    } else {
      // Imported contact - load associated transactions
      loadContactTransactions(contact.id);
    }
  }, [loadContactTransactions, selectContact]);

  // Close/clear the detail view (narrow Back button, wide pane close, modal X)
  const handleCloseDetail = useCallback(() => {
    setPreviewContact(null);
    clearSelection();
  }, [clearSelection]);

  // Handle importing an external contact (from ContactSearchList's + Add Contact button)
  const handleImportContact = useCallback(
    async (contact: ExtendedContact): Promise<ExtendedContact> => {
      const contactName = contact.display_name || contact.name || "";

      try {
        const result = await window.api.contacts.create(userId, {
          name: contactName,
          email: contact.email || contact.allEmails?.[0] || "",
          phone: contact.phone || contact.allPhones?.[0] || "",
          company: contact.company || "",
          title: contact.title || "",
          source: contact.source || "contacts_app",
          allEmails: contact.allEmails || [],
          allPhones: contact.allPhones || [],
        });

        if (result.success && result.contact) {
          // Mark as imported for visual feedback
          setImportedContactIds((prev) => new Set(prev).add(contact.id));
          // Silent refresh to avoid showing loading state
          await silentLoadContacts();
          return result.contact as ExtendedContact;
        }

        throw new Error(result.error || "Failed to import contact");
      } catch (err) {
        logger.error("Failed to import contact:", err);
        throw err;
      }
    },
    [userId, silentLoadContacts]
  );

  // Handle importing from preview modal
  const handlePreviewImport = async () => {
    if (!previewContact) return;

    const hasName = !!(previewContact.display_name || previewContact.name);
    const hasEmail = !!(previewContact.email || previewContact.allEmails?.[0]);
    const hasPhone = !!(previewContact.phone || previewContact.allPhones?.[0]);

    if (!hasName || (!hasEmail && !hasPhone)) {
      // Missing required data - open edit form
      setPreviewContact(null);
      setSelectedContact(previewContact);
      setShowAddEdit(true);
      return;
    }

    try {
      await handleImportContact(previewContact);
      setPreviewContact(null);
    } catch (err) {
      logger.error("Failed to import contact:", err);
    }
  };

  // Handle editing from preview modal
  const handlePreviewEdit = () => {
    if (previewContact) {
      setPreviewContact(null);
      setSelectedContact(previewContact);
      setShowAddEdit(true);
    }
  };

  // Handle adding a new contact manually
  const handleAddManually = () => {
    setSelectedContact(undefined);
    setShowAddEdit(true);
  };

  // Render the contact detail as an inline pane (shared by the wide two-pane
  // layout and the narrow full-screen card). Transaction rows are clickable and
  // open the transaction via onOpenTransaction (BACKLOG-1898 T5).
  const renderDetailPane = () => {
    if (!previewContact) return null;
    const external = isExternal(previewContact);
    return (
      <ContactPreview
        contact={previewContact}
        isExternal={external}
        transactions={previewTransactions}
        isLoadingTransactions={loadingPreviewTransactions}
        variant="pane"
        onEdit={handlePreviewEdit}
        onImport={external ? handlePreviewImport : undefined}
        onRemove={
          !external
            ? () => {
                handleCloseDetail();
                handleRemoveContact(previewContact.id);
              }
            : undefined
        }
        onClose={handleCloseDetail}
        onTransactionClick={onOpenTransaction}
      />
    );
  };

  return (
    <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-gradient-to-r from-purple-500 to-pink-600 px-3 pt-6 pb-3 sm:px-6 sm:pt-10 sm:pb-4 flex items-center justify-between shadow-lg">
        <button
          onClick={onClose}
          className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 sm:px-4 transition-all flex items-center gap-1 sm:gap-2 font-medium text-sm sm:text-base"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          <span className="hidden sm:inline">Back to Dashboard</span>
          <span className="sm:hidden">Back</span>
        </button>
        <div className="text-right">
          <h2 className="text-lg sm:text-2xl font-bold text-white">
            Clients &amp; Contacts
          </h2>
          <p className="text-purple-100 text-xs sm:text-sm">
            {contacts.length + externalContacts.length} contacts
            {externalContacts.length > 0 &&
              ` (${externalContacts.length} from Contacts App)`}
          </p>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex-shrink-0 mx-2 sm:mx-4 mt-2 sm:mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      <OfflineNotice />

      {/*
        Master-detail content area (BACKLOG-1898 T5, breakpoint raised to
        1200px in Phase-1 layout polish — see useContactsLayout.ts).
        - Wide (>=1200px): two-pane grid `list | detail`; the detail pane renders
          ContactPreview inline (variant="pane") or an empty-state prompt.
          Bounded by the modal width (Contacts renders inside the AppModals shell).
        - Narrow (<1200px): single column, full-width list; the list shows until
          a contact is selected, then a full-screen detail card with a Back button.
      */}
      {isNarrow && previewContact && showDetailPane ? (
        /* Narrow: full-screen detail card with Back button */
        <div
          className="flex-1 min-h-0 flex flex-col bg-white mx-0 my-0 overflow-hidden"
          data-testid="contacts-detail-view"
        >
          <div className="flex-shrink-0 px-3 py-2 border-b border-gray-200">
            <button
              onClick={handleCloseDetail}
              className="flex items-center gap-1 text-purple-600 hover:text-purple-800 font-medium text-sm px-2 py-1 rounded-lg transition-colors"
              data-testid="contacts-detail-back"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {renderDetailPane()}
          </div>
        </div>
      ) : (
        /* Wide: two-pane grid; Narrow (no selection): list only */
        <div
          className={
            !isNarrow
              ? "flex-1 min-h-0 grid grid-cols-1 min-[1200px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-0 min-[1200px]:gap-4 mx-0 my-0 sm:mx-4 sm:my-4 overflow-hidden"
              : "flex-1 min-h-0 mx-0 my-0 overflow-hidden"
          }
          data-testid="contacts-master-detail"
        >
          {/* List pane */}
          <div className="h-full min-h-0 flex flex-col bg-white sm:rounded-xl sm:shadow-lg overflow-hidden">
            <ContactSearchList
              contacts={contacts}
              externalContacts={externalContacts}
              selectedIds={[]}
              activeContactId={selectedContactId}
              onSelectionChange={() => {}}
              onContactClick={handleContactClick}
              onImportContact={handleImportContact}
              onAddManually={handleAddManually}
              addedContactIds={importedContactIds}
              isLoading={loading || externalContactsLoading}
              error={error}
              searchPlaceholder="Search contacts by name, email, or phone..."
              showCategoryFilter={true}
              sortOrder="alphabetical"
              className="h-full"
              compact
            />
          </div>

          {/* Detail pane (wide only) */}
          {!isNarrow && (
            <div
              className="hidden min-[1200px]:flex min-h-0 bg-white rounded-xl shadow-lg overflow-hidden"
              data-testid="contacts-detail-pane"
            >
              {previewContact ? (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {renderDetailPane()}
                </div>
              ) : (
                <div
                  className="flex-1 flex items-center justify-center text-gray-400 text-sm p-8 text-center"
                  data-testid="contacts-detail-empty"
                >
                  Select a contact to view details
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Contact Modal */}
      {showAddEdit && (
        <ContactFormModal
          userId={userId}
          contact={selectedContact}
          onClose={() => {
            setShowAddEdit(false);
            setSelectedContact(undefined);
          }}
          onSuccess={() => {
            setShowAddEdit(false);
            setSelectedContact(undefined);
            loadContacts();
          }}
        />
      )}


      {/* Blocking Modal - Cannot Delete Contact with Transactions */}
      {showBlockingModal && (
        <BlockingTransactionsModal
          transactions={blockingTransactions}
          onClose={() => {
            setShowBlockingModal(false);
            setBlockingTransactions([]);
          }}
        />
      )}

      {/* Remove Confirmation Modal */}
      {showRemoveConfirmation && (
        <RemoveConfirmationModal
          onClose={() => {
            setShowRemoveConfirmation(false);
            setContactToRemove(null);
          }}
          onConfirm={handleConfirmRemove}
        />
      )}
    </div>
  );
}

export default Contacts;
