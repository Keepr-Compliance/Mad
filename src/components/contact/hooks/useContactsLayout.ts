import { useState, useEffect, useCallback, useMemo } from "react";

/**
 * Breakpoint (px) below which the Contacts screen collapses to a single-column
 * push-navigation layout (list OR detail). At/above it, the screen renders a
 * two-pane master-detail (list | detail). Matches Tailwind's `md` breakpoint.
 */
export const CONTACTS_NARROW_BREAKPOINT = 768;

const NARROW_QUERY = `(max-width: ${CONTACTS_NARROW_BREAKPOINT - 1}px)`;

export interface UseContactsLayoutReturn {
  /** Currently selected contact id, or null when nothing is selected. */
  selectedContactId: string | null;
  /** True when the viewport is below the narrow breakpoint (single-column). */
  isNarrow: boolean;
  /**
   * Whether the detail pane/card should be shown.
   * - Wide: always true (two-pane layout; the pane shows an empty state when
   *   nothing is selected).
   * - Narrow: only when a contact is selected (push-navigation to the card).
   */
  showDetailPane: boolean;
  /** Select a contact (opens the detail pane/card). */
  selectContact: (contactId: string) => void;
  /** Clear the selection (narrow: returns to the list via the Back button). */
  clearSelection: () => void;
}

/**
 * Detects whether the viewport currently matches the narrow query.
 *
 * DEFENSIVE: `window.matchMedia` is not implemented by jsdom and is not mocked
 * in this project's jest setup, so it can be `undefined` under test. When it is
 * unavailable we default to the wide (two-pane) layout so component tests keep
 * rendering the list, and callers that need narrow behaviour mock matchMedia.
 */
function getIsNarrow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(NARROW_QUERY).matches;
}

/**
 * useContactsLayout
 *
 * Owns the responsive master-detail state for the Contacts screen so that
 * `Contacts.tsx` stays thin and compositional (no layout logic in the entry
 * component). Tracks the selected contact, the current viewport class
 * (narrow vs wide via `matchMedia`), and derives whether the detail
 * pane/card should be visible.
 *
 * - Wide (>= 768px): two-pane grid `list | detail`; `showDetailPane` is always
 *   true (the pane renders an empty state when nothing is selected).
 * - Narrow (< 768px): single column; the list shows until a contact is
 *   selected, then the full-screen detail card shows with a Back button
 *   (`clearSelection`). Pure state toggle — no router change.
 */
export function useContactsLayout(): UseContactsLayoutReturn {
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null,
  );
  const [isNarrow, setIsNarrow] = useState<boolean>(getIsNarrow);

  // Subscribe to viewport changes so the layout switches live on resize.
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mql = window.matchMedia(NARROW_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsNarrow(event.matches);
    };

    // Sync immediately in case the value changed between render and effect.
    setIsNarrow(mql.matches);

    // `addEventListener` is the modern API; fall back to the deprecated
    // `addListener` for older WebKit (Electron ships modern Chromium, but this
    // keeps the hook safe if run in an older runtime).
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handleChange);
      return () => mql.removeEventListener("change", handleChange);
    }
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    mql.addListener(handleChange);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return () => mql.removeListener(handleChange);
  }, []);

  const selectContact = useCallback((contactId: string) => {
    setSelectedContactId(contactId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedContactId(null);
  }, []);

  // Wide: detail pane is always mounted (empty-state when nothing selected).
  // Narrow: detail card only when a contact is selected.
  const showDetailPane = !isNarrow || selectedContactId !== null;

  return useMemo(
    () => ({
      selectedContactId,
      isNarrow,
      showDetailPane,
      selectContact,
      clearSelection,
    }),
    [selectedContactId, isNarrow, showDetailPane, selectContact, clearSelection],
  );
}
