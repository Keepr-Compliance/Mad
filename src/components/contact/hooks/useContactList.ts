import { useState, useCallback, useEffect, useRef } from "react";
import { ExtendedContact, TransactionWithRoles } from "../types";
import logger from '../../../utils/logger';

interface UseContactListOptions {
  onContactDeleted?: (contactId: string) => void;
}

interface UseContactListResult {
  contacts: ExtendedContact[];
  loading: boolean;
  error: string | undefined;
  loadContacts: () => Promise<void>;
  /**
   * Refresh the contact list without a loading flash, and RETURN what it
   * loaded (BACKLOG-2459).
   *
   * The return value exists because `setContacts` does not make the new rows
   * visible to the caller that awaited it — React state is not readable from
   * the closure that triggered it. A caller that needs the refreshed row (the
   * import path, which stays on the card it just created) has no other way to
   * reach it in the same turn. Empty array on failure, matching the silent
   * contract: a failed refresh keeps the existing state rather than erroring.
   */
  silentLoadContacts: () => Promise<ExtendedContact[]>;
  handleRemoveContact: (contactId: string) => Promise<void>;
  handleConfirmRemove: () => Promise<void>;
  showRemoveConfirmation: boolean;
  setShowRemoveConfirmation: (show: boolean) => void;
  contactToRemove: string | null;
  setContactToRemove: (id: string | null) => void;
  showBlockingModal: boolean;
  setShowBlockingModal: (show: boolean) => void;
  blockingTransactions: TransactionWithRoles[];
  setBlockingTransactions: (txns: TransactionWithRoles[]) => void;
  // External contacts (from macOS Contacts app, etc.)
  externalContacts: ExtendedContact[];
  externalContactsLoading: boolean;
  reloadExternalContacts: () => void;
}

/**
 * Hook for managing contact list operations
 * Handles loading, removing contacts, and related modal states
 */
export function useContactList(userId: string, options?: UseContactListOptions): UseContactListResult {
  const { onContactDeleted } = options || {};
  const [contacts, setContacts] = useState<ExtendedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showBlockingModal, setShowBlockingModal] = useState(false);
  const [blockingTransactions, setBlockingTransactions] = useState<
    TransactionWithRoles[]
  >([]);
  const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false);
  const [contactToRemove, setContactToRemove] = useState<string | null>(null);

  // External contacts state (from macOS Contacts app, etc.)
  const [externalContacts, setExternalContacts] = useState<ExtendedContact[]>([]);
  const [externalContactsLoading, setExternalContactsLoading] = useState(false);
  const externalContactsLoadedRef = useRef(false);
  const isMountedRef = useRef(true);

  const loadContacts = useCallback(async () => {
    try {
      setLoading(true);
      const result = await window.api.contacts.getAll(userId);

      if (result.success) {
        setContacts(result.contacts || []);
      } else {
        setError(result.error || "Failed to load contacts");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load contacts";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Silent refresh - doesn't show loading state (use after importing contacts)
  const silentLoadContacts = useCallback(async (): Promise<ExtendedContact[]> => {
    try {
      const result = await window.api.contacts.getAll(userId);
      if (!isMountedRef.current) return [];

      if (result.success) {
        const loaded = (result.contacts || []) as ExtendedContact[];
        setContacts(loaded);
        // Returned as well as stored: see the interface doc above.
        return loaded;
      }
      // Don't set error on silent refresh - keep existing state
    } catch (err) {
      if (!isMountedRef.current) return [];
      logger.error("Silent refresh failed:", err);
    }
    return [];
  }, [userId]);

  useEffect(() => {
    isMountedRef.current = true;
    loadContacts();
    return () => {
      isMountedRef.current = false;
    };
  }, [loadContacts]);

  /**
   * Load external contacts (from macOS Contacts app, etc.)
   * These are contacts not yet imported into the database.
   */
  const loadExternalContacts = useCallback(async () => {
    if (externalContactsLoadedRef.current) return;
    if (!isMountedRef.current) return;

    setExternalContactsLoading(true);
    try {
      const result = await window.api.contacts.getAvailable(userId);
      if (!isMountedRef.current) return;

      if (result.success && result.contacts) {
        // Mark as external for visual distinction (SourcePill display)
        const external = result.contacts.map((c: ExtendedContact) => ({
          ...c,
          is_message_derived: true,
        }));
        setExternalContacts(external);
        externalContactsLoadedRef.current = true;
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      logger.error("Failed to load external contacts:", err);
    } finally {
      if (isMountedRef.current) {
        setExternalContactsLoading(false);
      }
    }
  }, [userId]);

  // Load external contacts on mount
  useEffect(() => {
    loadExternalContacts();
  }, [loadExternalContacts]);

  // Force reload external contacts (resets cache and fetches fresh data)
  const reloadExternalContacts = useCallback(() => {
    externalContactsLoadedRef.current = false;
    loadExternalContacts();
  }, [loadExternalContacts]);

  const handleRemoveContact = useCallback(async (contactId: string) => {
    try {
      // BACKLOG-2365: this used to call checkCanDelete first and refuse outright
      // — "Cannot delete contact: They are associated with N transactions" —
      // whenever the contact was on a deal. That check is gone along with the
      // main-process guard behind it: removal writes a tombstone now, the
      // contact's roles on those transactions survive it, and the block existed
      // only because the old cascade destroyed them. The round-trip went with
      // it, since gating was the only thing its answer was used for here.
      setContactToRemove(contactId);
      setShowRemoveConfirmation(true);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to check contact";
      alert(`Failed to check contact: ${errorMessage}`);
    }
  }, []);

  const handleConfirmRemove = useCallback(async () => {
    if (!contactToRemove) return;

    try {
      const result = await window.api.contacts.remove(contactToRemove);
      if (result.success) {
        // Optimistic update - remove from state directly without full reload
        setContacts((prev) => prev.filter((c) => c.id !== contactToRemove));
        // Notify parent of deletion (for clearing stale visual state)
        onContactDeleted?.(contactToRemove);
      } else {
        alert(`Failed to remove contact: ${result.error}`);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to remove contact";
      alert(`Failed to remove contact: ${errorMessage}`);
    } finally {
      setShowRemoveConfirmation(false);
      setContactToRemove(null);
    }
  }, [contactToRemove, onContactDeleted]);

  return {
    contacts,
    loading,
    error,
    loadContacts,
    silentLoadContacts,
    handleRemoveContact,
    handleConfirmRemove,
    showRemoveConfirmation,
    setShowRemoveConfirmation,
    contactToRemove,
    setContactToRemove,
    showBlockingModal,
    setShowBlockingModal,
    blockingTransactions,
    setBlockingTransactions,
    // External contacts (from macOS Contacts app, etc.)
    externalContacts,
    externalContactsLoading,
    reloadExternalContacts,
  };
}

export default useContactList;
