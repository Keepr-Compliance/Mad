import React, { useState, useCallback } from "react";
import {
  ContactFormModal,
  RemoveConfirmationModal,
  BlockingTransactionsModal,
  useContactList,
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
}

/**
 * Contacts Component
 * Full contact management interface using ContactSearchList for consistent UX
 * - List all contacts (imported + external from Contacts App)
 * - Import external contacts
 * - Add/Edit/Delete contacts
 * - View contact details
 */
function Contacts({ userId, onClose }: ContactsProps) {
  // Database initialization guard (belt-and-suspenders defense)
  const { isDatabaseInitialized } = useAppStateMachine();

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
          result.transactions.map((t: { id: string; property_address: string; roles?: string[] }) => ({
            id: t.id,
            property_address: t.property_address,
            role: t.roles?.join(", ") || "Contact",
          }))
        );
      } else {
        setPreviewTransactions([]);
      }
    } catch {
      setPreviewTransactions([]);
    } finally {
      setLoadingPreviewTransactions(false);
    }
  }, []);

  // Handle clicking on a contact to view details
  const handleContactClick = useCallback((contact: ExtendedContact) => {
    // Always open the preview modal
    setPreviewContact(contact);
    setPreviewTransactions([]);

    if (isExternal(contact)) {
      // External contact - no transactions to load
      setLoadingPreviewTransactions(false);
    } else {
      // Imported contact - load associated transactions
      loadContactTransactions(contact.id);
    }
  }, [loadContactTransactions]);

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

      {/* ContactSearchList - main content area */}
      <div className="flex-1 min-h-0 bg-white mx-0 my-0 sm:mx-4 sm:my-4 sm:rounded-xl sm:shadow-lg overflow-hidden">
        <ContactSearchList
          contacts={contacts}
          externalContacts={externalContacts}
          selectedIds={[]}
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
        />
      </div>

      {/* Contact Preview Modal (all contacts) */}
      {previewContact && (
        <ContactPreview
          contact={previewContact}
          isExternal={isExternal(previewContact)}
          transactions={previewTransactions}
          isLoadingTransactions={loadingPreviewTransactions}
          onEdit={handlePreviewEdit}
          onImport={isExternal(previewContact) ? handlePreviewImport : undefined}
          onRemove={!isExternal(previewContact) ? () => {
            setPreviewContact(null);
            handleRemoveContact(previewContact.id);
          } : undefined}
          onClose={() => setPreviewContact(null)}
        />
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
