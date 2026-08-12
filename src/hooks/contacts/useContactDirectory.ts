/**
 * useContactDirectory — ONE refresh path for the contact picker's TWO halves.
 *
 * ===========================================================================
 * WHY THIS HOOK EXISTS (BACKLOG-2631)
 * ===========================================================================
 * The picker's LIST has always been shared: `ContactSearchList` / `ContactRow`
 * render Clients & Contacts, the new-transaction wizard and the existing-
 * transaction "Add Contacts" overlay. Its DATA-AND-REFRESH layer was three
 * separate copies:
 *
 *   - `useContactList` (Clients & Contacts) — both halves, refreshed together.
 *     The one that worked.
 *   - `useAuditContactAssignment` (new-transaction wizard) — reloaded the SAVED
 *     half only; the address-book half sat behind a once-per-mount guard.
 *   - `EditContactsModal`'s `Screen2Overlay` — the same again, its own copy,
 *     its own guard.
 *
 * The reported consequence: answer a duplicate question inside the transaction
 * wizard ("yes, same person") and the record you just merged away STAYS on
 * screen as a selectable row for the life of the modal. `contacts:confirm-link`
 * writes a `contact_source_links` row and `contacts:get-available` suppresses on
 * exactly that table (`contactHandlers.ts`, pinned by
 * `contact-handlers.stopHidingRecords-2608.test.ts`), so the record SHOULD
 * vanish on the next read. There was no next read — the wizard never asked the
 * address book again. Close and reopen and it is gone.
 *
 * The one-line fix — call the address-book fetch again from the wizard's
 * `onResolved` — leaves the third copy alive and the next divergence unwritten.
 * The person layer (BACKLOG-2611) brings merge and unmerge, operations whose
 * result must appear on every surface immediately; against three refresh
 * implementations that means writing the refresh three times and finding the
 * third one late, which is exactly how BACKLOG-2631 was found.
 *
 * The founder's framing, which is the rule this hook encodes: HE REQUIRED A
 * MERGE TO BE ONE DATABASE TRANSACTION SO IT CANNOT HALF-HAPPEN. THIS IS THE
 * SAME RULE ON THE SCREEN — ONE REFRESH PATH, SO A MERGE CANNOT BE VISIBLE ON
 * ONE SURFACE AND NOT ANOTHER.
 *
 * ===========================================================================
 * WHAT IS SHARED AND WHAT IS DELIBERATELY NOT
 * ===========================================================================
 * SHARED: which channels each half is read from, when they may be read, how a
 * refresh commits, and what happens when half of it fails.
 *
 * NOT SHARED, and left with their containers on purpose:
 *   - selection / add state (`selectedContactIds`, `importedTwins`) — genuinely
 *     the wizard's own business;
 *   - removal, undo and the blocking-transactions modal — Clients & Contacts'
 *     own (`useContactList`, which composes this hook).
 *
 * ===========================================================================
 * THE ONE REMAINING REF, AND WHY IT IS NOT THE GUARD THAT WAS DELETED
 * ===========================================================================
 * BOTH wizard mount guards are gone. `externalLoadedRef` here is NOT them: it
 * de-duplicates the INITIAL load only (the mount effect, `triggerLazyLoad`, and
 * StrictMode's deliberate double-invoke of effects). `refreshBothLists`
 * BYPASSES it rather than clearing it, so there is no window in which the
 * initial-load de-dup is down — the same shape `useContactList` shipped and
 * this hook inherited. A grep for "loaded ref" that stops at the declaration
 * will misread this; the difference is that nothing here can refuse an explicit
 * refresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtendedContact } from "../../types/components";
import logger from "../../utils/logger";

export interface UseContactDirectoryOptions {
  userId: string;
  /**
   * When non-empty, the saved half is read through
   * `contacts:get-sorted-by-activity` for this address; otherwise through
   * `contacts:get-all`. This is the ONLY difference between the three
   * containers' saved-half reads, so it is the only thing they configure.
   *
   * Both transaction surfaces pass the deal's address. Clients & Contacts has
   * no deal and omits it.
   */
  propertyAddress?: string;
  /**
   * Read the SAVED half on mount. Default `true`.
   *
   * `false` defers it to `triggerLazyLoad()` — the audit wizard, which does not
   * read contacts until the user reaches step 2.
   */
  autoLoadSaved?: boolean;
  /**
   * Read the ADDRESS-BOOK half on mount. Default `true`.
   *
   * THE TWO HALVES ARE SEPARATE FLAGS BECAUSE ONE CONTAINER GENUINELY WANTS
   * DIFFERENT ANSWERS FOR THEM. `ContactsProvider` wraps EditContactsModal's
   * Screen 1, which needs the saved contacts immediately, and the Add Contacts
   * overlay, which is the only thing that needs the address book —
   * `contacts:get-available` is a whole-corpus read, and loading it with the
   * provider would put one on every open of the modal, including the many that
   * never open the picker.
   *
   * Unifying the refresh is not entitled to add fetches. The call counts are
   * asserted in `ContactAssignmentStep.oneRefreshPath-2631.test.tsx`.
   */
  autoLoadExternal?: boolean;
}

export interface UseContactDirectoryResult {
  /** The SAVED half — contacts in the database. */
  contacts: ExtendedContact[];
  contactsLoading: boolean;
  contactsError: string | null;
  /**
   * Escape hatch for a container that must edit the saved half WITHOUT a round
   * trip. Exactly one caller: `useContactList`'s optimistic remove, which drops
   * the row it just deleted rather than paying a full reload for a result it
   * already knows. Not a second load path — nothing here fetches through it.
   */
  setContacts: React.Dispatch<React.SetStateAction<ExtendedContact[]>>;
  /** The ADDRESS-BOOK half — source records not yet claimed by a saved contact. */
  externalContacts: ExtendedContact[];
  externalContactsLoading: boolean;
  /** Reload the saved half WITH a spinner. First load, and explicit retries. */
  loadContacts: () => Promise<void>;
  /**
   * Reload the SAVED HALF ONLY, silently, and return what it loaded.
   *
   * Correct only where the action cannot have changed the address-book half —
   * `contacts:get-available` suppresses on `contact_source_links`, so an action
   * that writes no row in that table leaves it alone. Clients & Contacts'
   * compare-confirm is the live example and carries the reasoning at its call
   * site.
   *
   * The return value exists because `setContacts` does not make the new rows
   * visible to the caller that awaited it (BACKLOG-2459). `[]` on failure,
   * matching the silent contract: a failed refresh keeps the existing state.
   */
  silentLoadContacts: () => Promise<ExtendedContact[]>;
  /**
   * REFRESH BOTH HALVES, COMMIT THEM AS ONE RENDER (BACKLOG-2526/2627/2631).
   *
   * The default refresh for every action that changes what the picker offers.
   * The mechanics that are easy to break, all of which have already been broken
   * once:
   *
   *   - Both fetches START TOGETHER and are awaited together, so the address
   *     book (the slow one) does not serialise behind the saved contacts.
   *   - Both setters run in ONE synchronous continuation. React 18 batches them
   *     into a single commit, so no render can hold a person twice — once as the
   *     saved contact and once as the address-book record it was made from
   *     (BACKLOG-2526: the founder watched himself appear twice and then watched
   *     a row vanish). PUT NOTHING BETWEEN THE TWO SETTERS THAT YIELDS TO THE
   *     EVENT LOOP. A bare `await Promise.resolve()` does NOT count — React 18
   *     defers its flush past the microtask queue — which is why this rule
   *     cannot be verified by reading and is pinned instead by
   *     `Contacts.importSingleCommit-2526.test.tsx`, which records every frame
   *     the list rendered with.
   *   - NEITHER commits unless BOTH fetches succeeded. Committing the external
   *     result alone removes the address-book row while the saved contact is
   *     still absent — the person then in neither list, which is worse than the
   *     defect. Committing the saved result alone IS the defect.
   *   - SILENT: `externalContactsLoading` is never raised. It feeds `isLoading`
   *     in `ContactSearchList`, where every row is gated on `!isLoading` — so
   *     raising it does not show a spinner NEXT TO the list, it REPLACES the
   *     list with one and throws away the user's place (BACKLOG-2459/2511). An
   *     answer session is several answers in a row; one spinner per answer would
   *     be unusable.
   *
   * Returns the saved-contact rows whenever THAT fetch succeeded, committed or
   * not — the import path lands its detail card on them and would rather have a
   * row that was fetched than withhold it because a different fetch failed. The
   * list is one refresh behind; the card is right.
   */
  refreshBothLists: () => Promise<ExtendedContact[]>;
  /**
   * Perform the initial load of both halves if it has not happened yet. Safe to
   * call repeatedly — it is how `autoLoad: false` containers open the picker.
   */
  triggerLazyLoad: () => void;
}

/**
 * Shared owner of the contact picker's two halves and their refresh.
 * See the file docblock for why all three containers compose it.
 */
export function useContactDirectory({
  userId,
  propertyAddress,
  autoLoadSaved = true,
  autoLoadExternal = true,
}: UseContactDirectoryOptions): UseContactDirectoryResult {
  const [contacts, setContacts] = useState<ExtendedContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState<boolean>(autoLoadSaved);
  const [contactsError, setContactsError] = useState<string | null>(null);

  const [externalContacts, setExternalContacts] = useState<ExtendedContact[]>([]);
  const [externalContactsLoading, setExternalContactsLoading] = useState(false);

  /**
   * Initial-load de-dup ONLY. See the file docblock: `refreshBothLists`
   * bypasses these rather than clearing them.
   *
   * TWO refs per half, not one, and the pair is the point:
   *   - `*LoadedRef` is set on SUCCESS, so a failed first read is retried the
   *     next time the picker is opened instead of leaving the half permanently
   *     empty;
   *   - `*InFlightRef` is claimed BEFORE the await, because StrictMode invokes
   *     effects twice in the same tick and a success-only flag is still false
   *     when the second invocation reads it — which fetches the whole address
   *     book twice on every mount.
   */
  const contactsLoadedRef = useRef(false);
  const contactsInFlightRef = useRef(false);
  const externalLoadedRef = useRef(false);
  const externalInFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /**
   * FETCH, COMMIT NOTHING (BACKLOG-2526).
   *
   * The two fetchers below exist so a caller can hold both results and decide
   * when — and whether — they reach the screen. Every function that DOES commit
   * is built on them, so there is one place each half is read from and one place
   * each is written.
   *
   * `null` means the fetch FAILED and is deliberately distinct from `[]`, which
   * means it succeeded and the list is empty. Collapsing the two would make a
   * failed address-book read indistinguishable from an address book with nothing
   * left to import — and committing THAT clears every row.
   */
  const fetchSavedContacts = useCallback(async (): Promise<
    ExtendedContact[] | null
  > => {
    try {
      const result = propertyAddress
        ? await window.api.contacts.getSortedByActivity(userId, propertyAddress)
        : await window.api.contacts.getAll(userId);
      if (result.success) return (result.contacts || []) as ExtendedContact[];
      // Don't set error on a silent read - keep existing state
    } catch (err) {
      logger.error("Silent refresh failed:", err);
    }
    return null;
  }, [userId, propertyAddress]);

  const fetchExternalContacts = useCallback(async (): Promise<
    ExtendedContact[] | null
  > => {
    try {
      const result = await window.api.contacts.getAvailable(userId);
      if (result.success && result.contacts) {
        // Mark as external for visual distinction (SourcePill display)
        return (result.contacts as ExtendedContact[]).map((c) => ({
          ...c,
          is_message_derived: true,
        }));
      }
    } catch (err) {
      logger.error("Failed to load external contacts:", err);
    }
    return null;
  }, [userId]);

  const loadContacts = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current) return;

    contactsInFlightRef.current = true;
    setContactsLoading(true);
    setContactsError(null);
    try {
      const result = propertyAddress
        ? await window.api.contacts.getSortedByActivity(userId, propertyAddress)
        : await window.api.contacts.getAll(userId);

      if (!isMountedRef.current) return;

      if (result.success) {
        setContacts((result.contacts || []) as ExtendedContact[]);
        contactsLoadedRef.current = true;
      } else {
        setContactsError(result.error || "Failed to load contacts");
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      logger.error("Failed to load contacts:", err);
      // The thrown message, not a generic one. Both surviving containers
      // surfaced it before this hook existed — Clients & Contacts through
      // `err.message`, the transaction-details provider through
      // `contactService`'s `getErrorMessage` — and it is what tells "database is
      // locked" from "no such column" on a screen the user is looking at.
      setContactsError(
        err instanceof Error && err.message
          ? err.message
          : "Unable to load contacts",
      );
    } finally {
      contactsInFlightRef.current = false;
      if (isMountedRef.current) setContactsLoading(false);
    }
  }, [userId, propertyAddress]);

  const silentLoadContacts = useCallback(async (): Promise<ExtendedContact[]> => {
    const loaded = await fetchSavedContacts();
    if (!isMountedRef.current || loaded === null) return [];

    setContacts(loaded);
    contactsLoadedRef.current = true;
    // Returned as well as stored: see the interface doc above.
    return loaded;
  }, [fetchSavedContacts]);

  /**
   * The INITIAL address-book load, with its spinner.
   *
   * The mount-time load keeps its spinner: there are no rows to preserve yet,
   * and a first load with no feedback is the BACKLOG-1780 complaint. Every
   * subsequent read goes through `refreshBothLists`, which is silent.
   */
  const loadExternalContacts = useCallback(async (): Promise<void> => {
    if (externalLoadedRef.current || externalInFlightRef.current) return;
    if (!isMountedRef.current) return;

    externalInFlightRef.current = true;
    setExternalContactsLoading(true);
    try {
      const external = await fetchExternalContacts();
      if (!isMountedRef.current) return;

      if (external !== null) {
        setExternalContacts(external);
        externalLoadedRef.current = true;
      }
      // A null result leaves `externalLoadedRef` false on purpose, so the next
      // open retries rather than leaving this half permanently empty.
    } finally {
      externalInFlightRef.current = false;
      if (isMountedRef.current) setExternalContactsLoading(false);
    }
  }, [fetchExternalContacts]);

  const triggerLazyLoad = useCallback(() => {
    if (!contactsLoadedRef.current && !contactsInFlightRef.current) {
      void loadContacts();
    }
    void loadExternalContacts();
  }, [loadContacts, loadExternalContacts]);

  /**
   * Initial loads. A container that opts out calls `triggerLazyLoad` instead, so
   * nothing is read until the user opens the picker.
   *
   * `loadContacts` is NOT gated on the loaded ref here: its identity changes
   * when `userId` or `propertyAddress` do, and a saved half read for the WRONG
   * DEAL must be replaced. The address-book half is not keyed on the address, so
   * its own guard is the whole story.
   */
  useEffect(() => {
    if (!autoLoadSaved) return;
    void loadContacts();
  }, [autoLoadSaved, loadContacts]);

  useEffect(() => {
    if (!autoLoadExternal) return;
    void loadExternalContacts();
  }, [autoLoadExternal, loadExternalContacts]);

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
      // ---------------------------------------------------------------
      contactsLoadedRef.current = true;
      externalLoadedRef.current = true;
    } else {
      // Deliberately no partial commit: see the interface doc. The screen keeps
      // the state it had, which is stale but consistent, and the next load
      // repairs it.
      logger.error(
        "Contact list refresh incomplete, leaving both lists as they were",
        {
          savedContactsLoaded: saved !== null,
          externalContactsLoaded: external !== null,
        },
      );
    }

    // The CARD, not the list: the fetched rows whenever they were fetched.
    return saved ?? [];
  }, [fetchSavedContacts, fetchExternalContacts]);

  return {
    contacts,
    contactsLoading,
    contactsError,
    setContacts,
    externalContacts,
    externalContactsLoading,
    loadContacts,
    silentLoadContacts,
    refreshBothLists,
    triggerLazyLoad,
  };
}

export default useContactDirectory;
