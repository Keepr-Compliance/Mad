/**
 * ContactsContext
 * Single source of truth for contacts loading across modals.
 *
 * Problem: the transaction edit modals both had their own
 * useContactsLoader hooks, causing duplicate API calls when both rendered
 * or when contacts tab was accessed.
 *
 * Solution: This context loads contacts ONCE and shares them across all
 * children. Components use useContacts() hook to access shared state.
 *
 * Usage:
 * ```tsx
 * // In parent component (modal):
 * <ContactsProvider userId={userId} propertyAddress={propertyAddress}>
 *   <EditContactAssignments ... />
 * </ContactsProvider>
 *
 * // In child component:
 * const { contacts, loading, error, refreshContacts } = useContacts();
 * ```
 */
import React, { createContext, useContext, useMemo } from "react";
import type { ExtendedContact } from "../types/components";
import { useContactDirectory } from "../hooks/contacts/useContactDirectory";

// ============================================
// TYPES
// ============================================

interface ContactsState {
  contacts: ExtendedContact[];
  loading: boolean;
  error: string | null;
}

export interface ContactsContextValue extends ContactsState {
  refreshContacts: () => Promise<void>;
  /**
   * BACKLOG-2631 — THE ADDRESS-BOOK HALF, WHICH THIS PROVIDER DID NOT USED TO
   * CARRY AND `Screen2Overlay` KEPT A PRIVATE COPY OF.
   *
   * `EditContactsModal`'s Add Contacts overlay held its own
   * `externalContacts` / `externalLoading` / `externalLoaded` state and its own
   * `contacts:get-available` call behind a once-per-mount guard. That guard is
   * the reason answering a duplicate question in the overlay left the record on
   * screen. Both halves live here now, so the overlay has one source for the
   * data AND one refresh for it.
   *
   * FETCHED LAZILY: this provider wraps Screen 1 too, and the address book is a
   * whole-corpus read. `Screen2Overlay` calls `triggerLazyLoad` when it mounts,
   * so opening EditContactsModal without opening Add Contacts still costs no
   * `contacts:get-available` — exactly as before.
   */
  externalContacts: ExtendedContact[];
  externalContactsLoading: boolean;
  /**
   * Perform the address-book half's first load. Called by `Screen2Overlay` on
   * mount; a no-op once it has succeeded.
   */
  triggerLazyLoad: () => void;
  /**
   * Refresh BOTH halves and commit them as ONE render — the shared
   * `useContactDirectory.refreshBothLists`, the same function Clients & Contacts
   * and the new-transaction wizard call.
   *
   * This replaced `silentRefresh`, which re-read the saved half only. Every
   * action that reaches it (import, answering "same person") writes a
   * `contact_source_links` row, which is what `contacts:get-available`
   * suppresses on — so the half it skipped was the half that had moved.
   */
  refreshBothLists: () => Promise<void>;
}

interface ContactsProviderProps {
  children: React.ReactNode;
  userId: string;
  propertyAddress: string;
}

// ============================================
// CONTEXT
// ============================================

const ContactsContext = createContext<ContactsContextValue | undefined>(
  undefined
);

// ============================================
// PROVIDER
// ============================================

/**
 * ContactsProvider
 * Loads contacts once for a given userId/propertyAddress combination.
 * All children share the same loaded contacts.
 *
 * BACKLOG-2631 — THE LOADING IS NOT WRITTEN HERE ANY MORE.
 *
 * This provider held one of the three copies of the picker's data-and-refresh
 * layer: a saved-half read through `contactService`, a `silentRefresh` that
 * re-read that half only, and — down in `Screen2Overlay` — a private
 * address-book fetch behind a once-per-mount guard. It now composes
 * `useContactDirectory`, the same hook Clients & Contacts and the audit wizard
 * compose, so all three surfaces refresh through one implementation.
 *
 * `useContactDirectory` reads `window.api.contacts.*` directly rather than
 * through `contactService`. Not a behaviour change: `contactService.getAll` /
 * `getSortedByActivity` are pass-throughs that rewrap `{success, contacts}` as
 * `{success, data}` and add nothing else (`src/services/contactService.ts`).
 */
export function ContactsProvider({
  children,
  userId,
  propertyAddress,
}: ContactsProviderProps): React.ReactElement {
  const {
    contacts,
    contactsLoading,
    contactsError,
    externalContacts,
    externalContactsLoading,
    loadContacts,
    refreshBothLists,
    triggerLazyLoad,
  } = useContactDirectory({
    userId,
    propertyAddress,
    // The saved half eagerly — Screen 1 renders the deal's parties from it.
    // The address book NOT: it is a whole-corpus read and only the Add Contacts
    // overlay needs it, so `Screen2Overlay` asks for it when it mounts. Opening
    // this modal and never opening the picker still costs no
    // `contacts:get-available`, exactly as before.
    autoLoadExternal: false,
  });

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<ContactsContextValue>(
    () => ({
      contacts,
      loading: contactsLoading,
      error: contactsError,
      refreshContacts: loadContacts,
      externalContacts,
      externalContactsLoading,
      triggerLazyLoad,
      // Flattened to void: no consumer of this context reads the rows back — the
      // overlay renders them from `contacts`/`externalContacts` — so the promise
      // is awaited for sequencing only.
      refreshBothLists: async () => {
        await refreshBothLists();
      },
    }),
    [
      contacts,
      contactsLoading,
      contactsError,
      loadContacts,
      externalContacts,
      externalContactsLoading,
      triggerLazyLoad,
      refreshBothLists,
    ]
  );

  return (
    <ContactsContext.Provider value={contextValue}>
      {children}
    </ContactsContext.Provider>
  );
}

// ============================================
// HOOK
// ============================================

/**
 * useContacts hook
 * Access shared contacts state from ContactsProvider.
 * Throws if used outside of ContactsProvider.
 */
export function useContacts(): ContactsContextValue {
  const context = useContext(ContactsContext);
  if (context === undefined) {
    throw new Error("useContacts must be used within a ContactsProvider");
  }
  return context;
}

export default ContactsContext;
