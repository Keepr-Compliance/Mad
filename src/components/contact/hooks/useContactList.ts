import { useState, useCallback } from "react";
import { ExtendedContact, TransactionWithRoles } from "../types";
import { labelForContact } from "../../../utils/contactDisplayLabel";
import { useContactDirectory } from "../../../hooks/contacts/useContactDirectory";

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
   * Refresh BOTH lists, and commit them as ONE render (BACKLOG-2526/2627).
   *
   * ==========================================================================
   * THE MECHANICS NOW LIVE IN `useContactDirectory` (BACKLOG-2631)
   * ==========================================================================
   * Parallel fetch, single-commit, all-or-nothing, never raises the external
   * loading flag, and the return-value rule (the CARD, not the list) — all of it
   * is in `src/hooks/contacts/useContactDirectory.ts`, with the incident record
   * that produced each rule. This hook re-exports it unchanged.
   *
   * It moved because it had to be reachable from the two transaction surfaces.
   * They each held their OWN saved-half reload behind their OWN once-per-mount
   * address-book guard, so answering a duplicate question inside the wizard left
   * the merged-away record on screen for the life of the modal — the same defect
   * BACKLOG-2627 fixed here, in the two copies that fix could not reach.
   *
   * ==========================================================================
   * WHO CALLS IT ON THIS SCREEN, AND WHY THE NAME DOES NOT SAY "IMPORT"
   * ==========================================================================
   * The callers are the things that change which source records
   * `contacts:get-available` still offers, i.e. that write or delete a
   * `contact_source_links` row:
   *
   *   - the IMPORT path, which writes a crosswalk row for the record it saved;
   *   - ANSWERING a duplicate question (`contacts:confirm-link`);
   *   - MANUAL LINK and UNLINK (BACKLOG-2629).
   *
   * It was `refreshAfterImport`. The founder answered two questions in the
   * review queue with Clients & Contacts open behind it and the list did not
   * move: the answer path called `silentLoadContacts`, which re-reads the SAVED
   * half only. The app's own funnel proves it — the last `picker:` line was
   * logged BEFORE either answer.
   *
   * That defect cost more than a stale screen. The list was read as evidence
   * that a DIFFERENT fix had failed to remove a record; it had worked, and the
   * screen was ten minutes old. A verification that reads a cached list cannot
   * tell "the fix failed" from "the screen is old".
   *
   * So the name names the CONTRACT — refresh both, commit once — and not the
   * first caller to need it.
   */
  refreshBothLists: () => Promise<ExtendedContact[]>;
}

/**
 * Hook for managing contact list operations
 * Handles loading, removing contacts, and related modal states
 */
export function useContactList(userId: string, options?: UseContactListOptions): UseContactListResult {
  const { onContactDeleted } = options || {};
  const [showBlockingModal, setShowBlockingModal] = useState(false);
  const [blockingTransactions, setBlockingTransactions] = useState<
    TransactionWithRoles[]
  >([]);
  const [showRemoveConfirmation, setShowRemoveConfirmation] = useState(false);
  const [contactToRemove, setContactToRemove] = useState<string | null>(null);

  /**
   * BACKLOG-2631 — BOTH HALVES AND THEIR REFRESH NOW COME FROM THE SHARED HOOK.
   *
   * Everything that used to be written out here — the two fetchers, the mount
   * loads, the once-per-mount address-book guard, `refreshBothLists` — is in
   * `useContactDirectory`, unchanged in behaviour, so the transaction wizard and
   * the Add Contacts overlay run the SAME refresh instead of two near-copies of
   * it. What is left in this hook is what is genuinely this screen's: removal,
   * undo, and the blocking-transactions modal.
   *
   * No `propertyAddress`: Clients & Contacts is not looking at a deal, so the
   * saved half is read through `contacts:get-all` exactly as before. Loads on
   * mount, as before.
   */
  const {
    contacts,
    contactsLoading: loading,
    contactsError,
    setContacts,
    externalContacts,
    externalContactsLoading,
    loadContacts,
    silentLoadContacts,
    refreshBothLists,
  } = useContactDirectory({ userId });

  // This screen's `error` is `string | undefined`; the shared hook's is
  // `string | null`. Narrowed here rather than changed there — every consumer of
  // `UseContactListResult.error` passes it into props typed `string | undefined`.
  const error = contactsError ?? undefined;

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
    refreshBothLists,
  };
}

export default useContactList;
