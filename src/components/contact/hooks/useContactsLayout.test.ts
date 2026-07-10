import { renderHook, act } from "@testing-library/react";
import {
  useContactsLayout,
  CONTACTS_NARROW_BREAKPOINT,
} from "./useContactsLayout";

/**
 * Tests for useContactsLayout (BACKLOG-1898 T5).
 *
 * matchMedia is NOT implemented by jsdom and NOT mocked in the shared jest
 * setup, so these tests install a controllable mock per-case. The hook itself
 * must default to the wide (two-pane) layout when matchMedia is absent.
 */

type Listener = (event: { matches: boolean }) => void;

/**
 * Installs a controllable matchMedia mock. Returns a `setNarrow` fn that flips
 * the match state and notifies subscribed listeners (simulating a resize).
 */
function installMatchMedia(initialNarrow: boolean) {
  const listeners = new Set<Listener>();
  let matches = initialNarrow;

  const mql = {
    get matches() {
      return matches;
    },
    media: `(max-width: ${CONTACTS_NARROW_BREAKPOINT - 1}px)`,
    addEventListener: (_event: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_event: string, cb: Listener) => listeners.delete(cb),
    // legacy fallbacks (unused when addEventListener exists)
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    onchange: null,
    dispatchEvent: () => true,
  };

  (window as unknown as { matchMedia: unknown }).matchMedia = jest
    .fn()
    .mockReturnValue(mql);

  return {
    setNarrow(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb({ matches: next }));
    },
  };
}

describe("useContactsLayout", () => {
  afterEach(() => {
    // Remove the mock so cross-test leakage can't hide a regression.
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    jest.clearAllMocks();
  });

  describe("matchMedia unavailable (jsdom default)", () => {
    it("defaults to the wide layout (isNarrow=false, detail pane shown)", () => {
      // Ensure matchMedia is absent for this case.
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
      const { result } = renderHook(() => useContactsLayout());

      expect(result.current.isNarrow).toBe(false);
      // Wide: detail pane is always shown (empty-state when nothing selected).
      expect(result.current.showDetailPane).toBe(true);
      expect(result.current.selectedContactId).toBeNull();
    });
  });

  describe("wide viewport", () => {
    it("shows both panes and tracks selection", () => {
      installMatchMedia(false);
      const { result } = renderHook(() => useContactsLayout());

      expect(result.current.isNarrow).toBe(false);
      expect(result.current.showDetailPane).toBe(true);

      act(() => result.current.selectContact("contact-42"));
      expect(result.current.selectedContactId).toBe("contact-42");
      // Still shows the detail pane (was already true on wide).
      expect(result.current.showDetailPane).toBe(true);
    });
  });

  describe("narrow viewport", () => {
    it("shows list only until a contact is selected, then the detail card, and Back returns to the list", () => {
      installMatchMedia(true);
      const { result } = renderHook(() => useContactsLayout());

      // Narrow + nothing selected => list only (no detail pane).
      expect(result.current.isNarrow).toBe(true);
      expect(result.current.showDetailPane).toBe(false);
      expect(result.current.selectedContactId).toBeNull();

      // Select => detail card shows.
      act(() => result.current.selectContact("contact-7"));
      expect(result.current.selectedContactId).toBe("contact-7");
      expect(result.current.showDetailPane).toBe(true);

      // Back => returns to the list.
      act(() => result.current.clearSelection());
      expect(result.current.selectedContactId).toBeNull();
      expect(result.current.showDetailPane).toBe(false);
    });
  });

  describe("responsive switching", () => {
    it("switches layout live when the viewport crosses the breakpoint", () => {
      const controller = installMatchMedia(false);
      const { result } = renderHook(() => useContactsLayout());

      expect(result.current.isNarrow).toBe(false);

      // Resize to narrow.
      act(() => controller.setNarrow(true));
      expect(result.current.isNarrow).toBe(true);

      // Resize back to wide.
      act(() => controller.setNarrow(false));
      expect(result.current.isNarrow).toBe(false);
    });
  });
});
