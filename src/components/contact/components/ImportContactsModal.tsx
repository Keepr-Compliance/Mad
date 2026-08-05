import React, { useState, useEffect, useCallback } from "react";
import { ResponsiveModal, MODAL_PANEL } from "../../common/ResponsiveModal";
import { ExtendedContact } from "../types";
import { OfflineNotice } from "../../common/OfflineNotice";
import { contactSourceLabel } from "../../../utils/contactFilterModel";

interface ImportContactsModalProps {
  userId: string;
  onClose: () => void;
  /** Called when import succeeds, passing the IDs of imported contacts */
  onSuccess: (importedContactIds: string[]) => void;
  onAddManually: () => void;
}

/**
 * Import Contacts Modal
 * Browse and import contacts from external sources (Contacts app, Outlook)
 */
function ImportContactsModal({
  userId,
  onClose,
  onSuccess,
  onAddManually,
}: ImportContactsModalProps) {
  const [availableContacts, setAvailableContacts] = useState<ExtendedContact[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedContacts, setSelectedContacts] = useState(new Set<string>());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const loadAvailableContacts = useCallback(async () => {
    try {
      setLoading(true);
      const result = await window.api.contacts.getAvailable(userId);

      if (result.success) {
        setAvailableContacts(result.contacts || []);
      } else {
        setError(result.error || "Failed to load available contacts");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Failed to load available contacts";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Load contacts on mount
  useEffect(() => {
    loadAvailableContacts();
  }, [loadAvailableContacts]);

  // TASK-1955: Listen for external sync completion to refresh contacts list
  // When user triggers a manual sync from Settings, this refreshes the modal
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contactsApi = window.api.contacts as any;

    if (!contactsApi?.onExternalSyncComplete) return;

    const cleanup = contactsApi.onExternalSyncComplete(() => {
      loadAvailableContacts();
    });

    return cleanup;
  }, [loadAvailableContacts]);

  const handleToggleContact = (contactId: string) => {
    const newSelected = new Set(selectedContacts);
    if (newSelected.has(contactId)) {
      newSelected.delete(contactId);
    } else {
      newSelected.add(contactId);
    }
    setSelectedContacts(newSelected);
  };

  const handleImportSelected = async () => {
    if (selectedContacts.size === 0) {
      setError("Please select at least one contact to import");
      return;
    }

    setImporting(true);
    setError(undefined);

    try {
      const contactsToImport = availableContacts.filter((c) =>
        selectedContacts.has(c.id),
      );
      const result = (await window.api.contacts.import(
        userId,
        contactsToImport
      )) as { success: boolean; contacts?: ExtendedContact[]; error?: string };

      if (result.success) {
        // Extract IDs from imported contacts to return to caller
        const importedIds = result.contacts?.map((c) => c.id) || [];
        onSuccess(importedIds);
      } else {
        setError(result.error || "Failed to import contacts");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to import contacts";
      setError(errorMessage);
    } finally {
      setImporting(false);
    }
  };

  const filteredContacts = availableContacts.filter(
    (c) =>
      c.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.company?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[60]" panelClassName={MODAL_PANEL.lg}>
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-500 to-pink-600 px-6 py-4 flex items-center justify-between rounded-t-xl flex-shrink-0">
          <h3 className="text-lg font-bold text-white">Import Contacts</h3>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
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
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <OfflineNotice />

        {/* Search and Add Manually */}
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            {/* Search */}
            <div className="flex-1 relative">
              <input
                type="text"
                placeholder="Search available contacts..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
              />
              <svg
                className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>

            {/* Add Manually Button */}
            <button
              onClick={onAddManually}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition-all flex items-center gap-2"
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
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              Add Manually
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Selected count */}
          {selectedContacts.size > 0 && (
            <div className="mt-3 text-sm text-purple-600 font-medium">
              {selectedContacts.size} contact
              {selectedContacts.size !== 1 ? "s" : ""} selected
            </div>
          )}
        </div>

        {/* Contacts List */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="w-12 h-12 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                <p className="text-gray-600">Loading available contacts...</p>
              </div>
            </div>
          ) : filteredContacts.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-md">
                <svg
                  className="w-16 h-16 text-gray-300 mx-auto mb-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  {searchQuery
                    ? "No matching contacts"
                    : "No available contacts"}
                </h3>
                <p className="text-gray-600 mb-4">
                  {searchQuery
                    ? "Try adjusting your search or add the contact manually."
                    : "All contacts from your Contacts app have been imported, or no contacts are available."}
                </p>
                {searchQuery && (
                  <button
                    onClick={onAddManually}
                    className="px-4 py-2 bg-gradient-to-r from-purple-500 to-pink-600 text-white rounded-lg font-semibold hover:from-purple-600 hover:to-pink-700 transition-all"
                  >
                    Add "{searchQuery}" Manually
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredContacts.map((contact) => (
                <div
                  key={contact.id}
                  onClick={() => handleToggleContact(contact.id)}
                  className={`border-2 rounded-lg p-4 cursor-pointer transition-all ${
                    selectedContacts.has(contact.id)
                      ? "border-purple-500 bg-purple-50"
                      : "border-gray-200 hover:border-purple-300 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* Checkbox */}
                    <div
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                        selectedContacts.has(contact.id)
                          ? "bg-purple-500 border-purple-500"
                          : "border-gray-300"
                      }`}
                    >
                      {selectedContacts.has(contact.id) && (
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
                    <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
                      {contact.name?.charAt(0).toUpperCase() || "?"}
                    </div>

                    {/* Contact Info */}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-gray-900">
                        {contact.name}
                      </div>
                      <div className="text-sm text-gray-600 space-y-1">
                        {contact.email && (
                          <div className="truncate">{contact.email}</div>
                        )}
                        {contact.phone && <div>{contact.phone}</div>}
                        {contact.company && (
                          <div className="truncate">{contact.company}</div>
                        )}
                      </div>
                    </div>

                    {/*
                      Source Badge — BACKLOG-2483.

                      Was a two-way ternary over a vocabulary of nine, so every
                      source that was not `contacts_app` announced itself as
                      "Outlook": Android, Google and iPhone records all claimed
                      an address book they had never been in. `contactSourceLabel`
                      derives the name from the same filter vocabulary the Source
                      dropdown renders, so the badge and the filter cannot
                      disagree, and an unrecognised source reads "Other" instead
                      of naming a provider it did not come from.
                    */}
                    <span
                      data-testid="contact-source-badge"
                      className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700 flex-shrink-0"
                    >
                      {contactSourceLabel(contact.source)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 bg-gray-50 rounded-b-xl flex items-center gap-3 justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleImportSelected}
            disabled={importing || selectedContacts.size === 0}
            className={`px-4 py-2 rounded-lg font-semibold transition-all ${
              importing || selectedContacts.size === 0
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700"
            }`}
          >
            {importing
              ? "Importing..."
              : `Import Selected (${selectedContacts.size})`}
          </button>
        </div>
    </ResponsiveModal>
  );
}

export default ImportContactsModal;
