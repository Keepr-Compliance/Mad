/**
 * ContactsContext
 * Single source of truth for contacts loading across modals.
 *
 * Problem: EditTransactionModal and EditContactsModal both had their own
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
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ExtendedContact } from "../types/components";
import { contactService } from "../services";
import logger from '../utils/logger';

// ============================================
// TYPES
// ============================================

interface ContactsState {
  contacts: ExtendedContact[];
  loading: boolean;
  error: string | null;
}

interface ContactsContextValue extends ContactsState {
  refreshContacts: () => Promise<void>;
  /** Refresh without showing loading state - use after adding a contact */
  silentRefresh: () => Promise<void>;
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
 */
export function ContactsProvider({
  children,
  userId,
  propertyAddress,
}: ContactsProviderProps): React.ReactElement {
  const [state, setState] = useState<ContactsState>({
    contacts: [],
    loading: true,
    error: null,
  });

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);

  // Track current load params to detect changes
  const loadParamsRef = useRef({ userId, propertyAddress });

  /**
   * Load contacts from API
   * Uses getSortedByActivity when propertyAddress is provided for relevance,
   * otherwise uses getAll.
   */
  const loadContacts = useCallback(async (showLoading = true) => {
    if (!isMountedRef.current) return;

    if (showLoading) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
    }

    try {
      const result = propertyAddress
        ? await contactService.getSortedByActivity(userId, propertyAddress)
        : await contactService.getAll(userId);

      if (!isMountedRef.current) return;

      if (result.success) {
        setState({
          contacts: (result.data || []) as ExtendedContact[],
          loading: false,
          error: null,
        });
      } else {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error || "Failed to load contacts",
        }));
      }
    } catch (err) {
      if (!isMountedRef.current) return;

      logger.error("ContactsContext: Failed to load contacts:", err);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: "Unable to load contacts",
      }));
    }
  }, [userId, propertyAddress]);

  /** Refresh without showing loading state */
  const silentRefresh = useCallback(() => loadContacts(false), [loadContacts]);

  // Load contacts on mount
  useEffect(() => {
    isMountedRef.current = true;
    loadContacts();

    return () => {
      isMountedRef.current = false;
    };
  }, [loadContacts]);

  // Reload if userId or propertyAddress change
  useEffect(() => {
    const paramsChanged =
      loadParamsRef.current.userId !== userId ||
      loadParamsRef.current.propertyAddress !== propertyAddress;

    if (paramsChanged) {
      loadParamsRef.current = { userId, propertyAddress };
      loadContacts();
    }
  }, [userId, propertyAddress, loadContacts]);

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo<ContactsContextValue>(
    () => ({
      ...state,
      refreshContacts: () => loadContacts(true),
      silentRefresh,
    }),
    [state, loadContacts, silentRefresh]
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
