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
   * Refresh BOTH lists, and commit them as ONE render (BACKLOG-2526).
   *
   * ==========================================================================
   * WHO CALLS IT, AND WHY THE NAME NO LONGER SAYS "IMPORT" (BACKLOG-2627)
   * ==========================================================================
   * Two callers, and they are the two things that change which source records
   * `contacts:get-available` still offers:
   *
   *   - the IMPORT path, which writes a crosswalk row for the record it saved;
   *   - ANSWERING a duplicate question, where `contacts:confirm-link` writes one
   *     for the record the user just said is the same person.
   *
   * It was `refreshAfterImport`. The founder answered two questions in the
   * review queue with Clients & Contacts open behind it and the list did not
   * move: the answer path called `silentLoadContacts`, which re-reads the SAVED
   * half only, and `loadExternalContacts`'s once-per-mount guard
   * (`externalContactsLoadedRef`, :255) means the address-book half is never
   * asked again for the life of the mount. The app's own funnel proves it —
   * the last `picker:` line was logged BEFORE either answer.
   *
   * That defect cost more than a stale screen. The list was read as evidence
   * that a DIFFERENT fix had failed to remove a record; it had worked, and the
   * screen was ten minutes old. A verification that reads a cached list cannot
   * tell "the fix failed" from "the screen is old".
   *
   * So the name names the CONTRACT — refresh both, commit once — and not the
   * first caller to need it. Nothing about the behaviour changed with it.
   *
   * ==========================================================================
   * WHY THIS REPLACED `reloadExternalContacts` RATHER THAN JOINING IT
   * ==========================================================================
   * BACKLOG-2511 made the import path refresh both lists, awaited together with
   * `Promise.all([silentLoadContacts(), reloadExternalContacts()])`. That gates
   * the code AFTER the call. It does not gate the two commits INSIDE it: each
   * function wrote its own state the moment its own IPC returned, in separate
   * React continuations, so they were separate renders.
   *
   * Between those two renders the list held the new saved contact AND the
   * address-book row it was made from — `assembleContacts` collapses on exact
   * `id` only (`contactPickerList.ts:268-285`) and the two ids differ (a fresh
   * contact UUID vs the shadow-table UUID), so nothing merged them and a shared
   * `stableIdentityKey` sorted them adjacent. The founder saw himself imported
   * twice, one row wearing the "Added" pill, and then watched that row vanish.
   *
   * The gap is the common case, not a rare one: `contacts:get-available` reads
   * the whole address book on a worker thread — ~3.7s at 1000+ contacts
   * (TASK-1956) — so the saved-contact fetch reliably lands first.
   *
   * So the two are fetched in parallel and committed in a SINGLE synchronous
   * continuation, which React 18 auto-batching renders once (createRoot,
   * `src/main.tsx`). `reloadExternalContacts` is GONE rather than kept beside
   * this: leaving a second, subtly different refresh exported is how the split
   * commit comes back. It had exactly one caller — this path — and BACKLOG-2511
   * was itself caused by that function sitting exported with zero callers.
   *
   * PUT NOTHING BETWEEN THE TWO SETTERS THAT YIELDS TO THE EVENT LOOP — a
   * timer, another round trip, anything the scheduler can flush across. React
   * then commits the saved contacts on their own and the defect is back.
   *
   * Worded that precisely because the obvious version of the rule is WRONG, and
   * was caught being wrong by running it: a bare `await Promise.resolve()`
   * between the two changes nothing, since React 18 defers its flush past the
   * microtask queue. So "no await here" cannot be verified by reading. The
   * property is pinned instead by a test that records every frame the list was
   * rendered with (`Contacts.importSingleCommit-2526.test.tsx`), which goes red
   * for a macrotask and stays green for a microtask — the real hazard, and only
   * the real hazard.
   *
   * ==========================================================================
   * ALL-OR-NOTHING COMMIT, AND A RETURN VALUE THAT DOES NOT FOLLOW IT
   * ==========================================================================
   * If either fetch fails, NEITHER list is committed. Committing the external
   * result alone removes the address-book row while the saved contact is still
   * absent from `contacts` — the person is then in neither list, which is worse
   * than the defect being fixed. Committing the saved result alone IS the
   * defect. The pre-import state is the only honest third option; it self-heals
   * on the next load, and a second Import press is folded by the crosswalk
   * guard in `contacts:import` (BACKLOG-2525), so the retry is safe.
   *
   * THE RETURN VALUE IS THE CARD, NOT THE LIST, AND IT PLAYS BY ITS OWN RULE
   * (it is the import path's; the answer path ignores it — nothing is created
   * to land on, the contact the record joined was already in the list):
   * the saved-contact rows whenever that fetch succeeded, committed or not, and
   * `[]` when it failed. The caller lands the detail card on
   * `refreshed.find(...) ?? created`, and `created` carries ONE email and ONE
   * phone whatever the record held (`Contact` has no `allEmails`/`allPhones` —
   * see the caller's own note). Withholding a row that was fetched
   * successfully, because a DIFFERENT fetch failed, would reproduce the
   * BACKLOG-2459 complaint on the failure path for no gain. The list is one
   * refresh behind; the card is right.
   */
  refreshBothLists: () => Promise<ExtendedContact[]>;
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

  /**
   * FETCH, COMMIT NOTHING (BACKLOG-2526).
   *
   * The two fetchers below exist so that a caller can hold both results and
   * decide when — and whether — they reach the screen. Every function that DOES
   * commit is built on them, so there is one place each list is read from and
   * one place each is written.
   *
   * `null` means the fetch failed, and is deliberately distinct from `[]`,
   * which means it succeeded and the list is empty. Collapsing the two would
   * make a failed address-book read indistinguishable from an address book with
   * nothing left to import — and committing THAT would clear every row.
   */
  const fetchSavedContacts = useCallback(async (): Promise<
    ExtendedContact[] | null
  > => {
    try {
      const result = await window.api.contacts.getAll(userId);
      if (result.success) return (result.contacts || []) as ExtendedContact[];
      // Don't set error on a silent read - keep existing state
    } catch (err) {
      logger.error("Silent refresh failed:", err);
    }
    return null;
  }, [userId]);

  const fetchExternalContacts = useCallback(async (): Promise<
    ExtendedContact[] | null
  > => {
    try {
      const result = await window.api.contacts.getAvailable(userId);
      if (result.success && result.contacts) {
        // Mark as external for visual distinction (SourcePill display)
        return result.contacts.map((c: ExtendedContact) => ({
          ...c,
          is_message_derived: true,
        }));
      }
    } catch (err) {
      logger.error("Failed to load external contacts:", err);
    }
    return null;
  }, [userId]);

  // Silent refresh - doesn't show loading state (use after importing contacts)
  const silentLoadContacts = useCallback(async (): Promise<ExtendedContact[]> => {
    const loaded = await fetchSavedContacts();
    if (!isMountedRef.current || loaded === null) return [];

    setContacts(loaded);
    // Returned as well as stored: see the interface doc above.
    return loaded;
  }, [fetchSavedContacts]);

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
        const external = await fetchExternalContacts();
        if (!isMountedRef.current) return;

        if (external !== null) {
          setExternalContacts(external);
          externalContactsLoadedRef.current = true;
        }
      } finally {
        if (!silent && isMountedRef.current) {
          setExternalContactsLoading(false);
        }
      }
    },
    [fetchExternalContacts],
  );

  // Load external contacts on mount
  useEffect(() => {
    loadExternalContacts();
  }, [loadExternalContacts]);

  /**
   * BACKLOG-2526 — refresh both lists, commit them as one render.
   * BACKLOG-2627 — and the second caller, answering a duplicate question.
   *
   * The full rationale is on the interface declaration above. The mechanics
   * that are easy to break are all here:
   *
   *   - Both fetches start together and are awaited together, so the address
   *     book (the slow one) does not serialise behind the saved contacts.
   *   - Both setters run in ONE synchronous continuation. React 18 batches
   *     them into a single commit, so no render can hold the imported person
   *     twice. Anything between them that yields to the event loop breaks that
   *     — see the interface doc for what does and does not count, and why the
   *     obvious version of this rule is wrong.
   *   - Neither commits unless BOTH fetches succeeded.
   *   - SILENT: `externalContactsLoading` is never raised. It feeds `isLoading`
   *     in `ContactSearchList`, where every row is gated on `!isLoading`
   *     (`ContactSearchList.tsx:847-849`) — raising it replaces the rows with a
   *     spinner and throws away the user's place (BACKLOG-2459/2511).
   *   - `loadExternalContacts`'s once-per-mount guard is bypassed rather than
   *     cleared, so there is no window where the guard is down.
   */
  const refreshBothLists = useCallback(async (): Promise<ExtendedContact[]> => {
    const [saved, external] = await Promise.all([
      fetchSavedContacts(),
      fetchExternalContacts(),
    ]);
    if (!isMountedRef.current) return [];

    if (saved !== null && external !== null) {
      // ----- ONE COMMIT. Nothing may go between these two lines. -----
      setContacts(saved);
      setExternalContacts(external);
      // -----------------------------------------------------------------
      externalContactsLoadedRef.current = true;
    } else {
      // Deliberately no partial commit: see the interface doc. The screen keeps
      // the state it had, which is stale but consistent, and the next load
      // repairs it.
      logger.error("Contact list refresh incomplete, leaving both lists as they were", {
        savedContactsLoaded: saved !== null,
        externalContactsLoaded: external !== null,
      });
    }

    // The CARD, not the list: the fetched rows whenever they were fetched.
    return saved ?? [];
  }, [fetchSavedContacts, fetchExternalContacts]);

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
