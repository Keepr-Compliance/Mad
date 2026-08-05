import { useState, useCallback, useEffect, useRef } from "react";
import { ExtendedContact, TransactionWithRoles } from "../types";
import { labelForContact } from "../../../utils/contactDisplayLabel";
import logger from '../../../utils/logger';

interface UseContactListOptions {
  onContactDeleted?: (contactId: string) => void;
}

/**
 * Who was just removed (BACKLOG-2501).
 *
 * `handleConfirmRemove` returns this so the caller can raise a "{Name} removed"
 * toast with an Undo button. It has to come back from the hook rather than be
 * read at the call site, for two reasons:
 *
 *   1. By the time the caller regains control the person is GONE from the
 *      `contacts` list — `handleConfirmRemove` filters them out optimistically —
 *      and `contactToRemove` has been reset to null. Nothing at the call site
 *      can still name them.
 *   2. Returning `null` on failure is the only way a caller can tell a real
 *      removal from a failed one. Before this, the handler returned void and
 *      swallowed every failure into `alert()`, so a toast raised at the call
 *      site would have fired cheerfully over a removal that never happened.
 */
export interface RemovedContactSummary {
  id: string;
  displayName: string;
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
  /**
   * Perform the staged removal. Resolves with the removed person's id and
   * display name, or `null` if nothing was removed (no staged contact, backend
   * failure, or a thrown error — the last two still `alert()` as before).
   */
  handleConfirmRemove: () => Promise<RemovedContactSummary | null>;
  /**
   * Undo a removal (BACKLOG-2501).
   *
   * Calls the SAME `contacts:restore` channel the "Show removed contacts"
   * section restores through (`RemovedContactsSection.restoreGroup`). There is
   * deliberately no second un-remove path here — one IPC channel, two callers.
   *
   * Lives in this hook because the restored person has to reappear in the list,
   * and `silentLoadContacts` is the refresh that does it without a spinner.
   * Resolves true when the contact is back.
   */
  handleUndoRemove: (contactId: string) => Promise<boolean>;
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
  /**
   * Re-fetch the address-book list, ignoring the once-per-mount guard
   * (BACKLOG-2511).
   *
   * AWAITABLE ON PURPOSE. This used to return void, so the only thing a caller
   * could do was start the refetch and hope. The one caller that exists — the
   * import path — needs the address book to have caught up before it hands
   * control back, because what it is fixing is the user seeing the row it just
   * imported still sitting there. A fire-and-forget refresh fixes that only by
   * winning a race.
   *
   * Resolves when the fetch has settled, whether or not it succeeded: a failed
   * refresh keeps the existing rows, matching `silentLoadContacts`.
   */
  reloadExternalContacts: () => Promise<void>;
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
  const loadExternalContacts = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (externalContactsLoadedRef.current) return;
      if (!isMountedRef.current) return;

      /**
       * BACKLOG-2511 — `silent` EXISTS TO PROTECT THE USER'S PLACE IN THE LIST.
       *
       * `externalContactsLoading` is handed to `ContactSearchList` as part of
       * `isLoading` (`Contacts.tsx`), and every row is gated on `!isLoading`
       * (`ContactSearchList.tsx:847-849`). Raising it does not show a spinner
       * NEXT TO the list — it replaces the list with one, unmounting every row.
       *
       * On the wide two-pane layout, where the founder imports from the detail
       * pane with the list still on screen beside it, nothing else is keeping
       * his place: the scroll container simply stays mounted and keeps its
       * `scrollTop`. Collapse its contents to a spinner and the offset has
       * nowhere to point, so the list comes back at the top — regressing
       * BACKLOG-2459, which he has already tested and passed.
       *
       * So the post-import refetch is silent, for the same reason
       * `silentLoadContacts` is (:122-140) and `handleUndoRemove` is (:254-256).
       * The mount-time load keeps its spinner: there are no rows to preserve
       * yet, and a first load with no feedback is the BACKLOG-1780 complaint.
       */
      if (!silent) setExternalContactsLoading(true);
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
        if (!silent && isMountedRef.current) {
          setExternalContactsLoading(false);
        }
      }
    },
    [userId],
  );

  // Load external contacts on mount
  useEffect(() => {
    loadExternalContacts();
  }, [loadExternalContacts]);

  // Force reload external contacts (resets cache and fetches fresh data).
  // SILENT, so the rows are never swapped for a spinner, and the promise is
  // RETURNED rather than dropped — see the interface doc above for both.
  const reloadExternalContacts = useCallback((): Promise<void> => {
    externalContactsLoadedRef.current = false;
    return loadExternalContacts({ silent: true });
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

  const handleConfirmRemove =
    useCallback(async (): Promise<RemovedContactSummary | null> => {
      if (!contactToRemove) return null;

      // BACKLOG-2501: resolve the label BEFORE the optimistic filter below drops
      // the row. After that `setContacts` call nothing in scope can name this
      // person, and the toast has to name them. `labelForContact` is the app's
      // one naming rule — it is what the contact cards, the transaction role
      // rows and the removed-contacts section all display, so the toast says
      // exactly what the user was looking at when they hit Remove.
      const target = contacts.find((c) => c.id === contactToRemove);
      const displayName = labelForContact(target ?? {});

      try {
        const result = await window.api.contacts.remove(contactToRemove);
        if (result.success) {
          // Optimistic update - remove from state directly without full reload
          setContacts((prev) => prev.filter((c) => c.id !== contactToRemove));
          // Notify parent of deletion (for clearing stale visual state)
          onContactDeleted?.(contactToRemove);
          return { id: contactToRemove, displayName };
        }
        alert(`Failed to remove contact: ${result.error}`);
        return null;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to remove contact";
        alert(`Failed to remove contact: ${errorMessage}`);
        return null;
      } finally {
        setShowRemoveConfirmation(false);
        setContactToRemove(null);
      }
    }, [contactToRemove, contacts, onContactDeleted]);

  const handleUndoRemove = useCallback(
    async (contactId: string): Promise<boolean> => {
      try {
        const result = await window.api.contacts.restore(contactId);
        if (!result.success) {
          alert(`Failed to restore contact: ${result.error}`);
          return false;
        }
        // Silent on purpose: a spinner here would unmount the list the user is
        // looking at, which is the BACKLOG-1780 failure the removed-contacts
        // section was careful to avoid.
        await silentLoadContacts();
        return true;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to restore contact";
        alert(`Failed to restore contact: ${errorMessage}`);
        return false;
      }
    },
    [silentLoadContacts],
  );

  return {
    contacts,
    loading,
    error,
    loadContacts,
    silentLoadContacts,
    handleRemoveContact,
    handleConfirmRemove,
    handleUndoRemove,
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
