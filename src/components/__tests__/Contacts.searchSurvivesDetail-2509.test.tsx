/**
 * BACKLOG-2509 — the contacts list keeps your search when you open a contact
 * and come back.
 *
 * ===========================================================================
 * THE MECHANISM THIS PINS — read before changing any assertion below
 * ===========================================================================
 * `searchQuery` used to be plain `useState` INSIDE `ContactSearchList`. Below
 * 1200px `Contacts.tsx` renders the detail card INSTEAD of the list (one
 * ternary, not a hidden sibling), so opening a contact UNMOUNTED the list and
 * destroyed the query. At/above 1200px both panes are siblings in one grid, the
 * list stays mounted, and the query already survived.
 *
 * That asymmetry is why this looked intermittent, and it is why the narrow case
 * is the control here and the wide case is only a pin — see each test.
 *
 * The fix lifts the query to `Contacts.tsx`, beside the BACKLOG-2459 anchor,
 * which is held there for exactly the same reason ("state inside an unmounted
 * component is not a memory").
 *
 * ===========================================================================
 * FOUNDER DECISION D4 (2026-08-06) — SESSION-ONLY
 * ===========================================================================
 * "Search is a moment, filters are a setup." The query is NEVER persisted:
 * it survives the detail pane and a viewport change, and it dies with the
 * Contacts screen. `pinsNoPersistence` and `clearsOnRemount` are that decision
 * written as tests — if a future change persists the query, they go red, and
 * the fix is to delete the persistence, not the test.
 *
 * matchMedia is not implemented by jsdom and not mocked globally, so each case
 * installs its own mock. Harness transcribed from
 * `Contacts.masterDetail.test.tsx`, which drives the same two layouts.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import { ContactSearchList } from "../shared/ContactSearchList";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({
    isDatabaseInitialized: true,
  }),
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

type Listener = (event: { matches: boolean }) => void;

/**
 * A controllable matchMedia mock.
 *
 * Returns a `setNarrow` so one test can cross the 1200px breakpoint mid-run —
 * which is the only way to observe the list genuinely unmounting and remounting
 * without tearing down the whole screen.
 */
function installMatchMedia(narrow: boolean): (next: boolean) => void {
  const listeners = new Set<Listener>();
  const mql = {
    matches: narrow,
    media: "",
    addEventListener: (_e: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_e: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    onchange: null,
    dispatchEvent: () => true,
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = jest
    .fn()
    .mockReturnValue(mql);
  return (next: boolean) => {
    mql.matches = next;
    act(() => {
      listeners.forEach((cb) => cb({ matches: next }));
    });
  };
}

const mockUserId = "user-123";

/** The ONE key the filter model persists under (ContactSearchList.tsx). */
const FILTER_MODEL_STORAGE_KEY = "contactModal.filterModel.v1";

// Three distinct people. "mad" matches exactly two of them by name, so the
// filtered set is a real subset — a preserved query is distinguishable from a
// cleared one by WHICH rows are on screen, not merely how many.
const madisonReed = {
  id: "contact-1",
  name: "Madison Reed",
  email: "madison@example.com",
  phone: "555-0101",
  source: "manual",
} as Contact;

const madelineCho = {
  id: "contact-2",
  name: "Madeline Cho",
  email: "madeline@example.com",
  phone: "555-0102",
  source: "manual",
} as Contact;

const tomBaker = {
  id: "contact-3",
  name: "Tom Baker",
  email: "tom@example.com",
  phone: "555-0103",
  source: "manual",
} as Contact;

const allContacts = [madisonReed, madelineCho, tomBaker];

/**
 * The names currently rendered as rows.
 *
 * An exact identity SET, never a count: a count of 2 cannot tell "the search
 * survived" from "two unrelated rows happen to be showing". Sorted so the
 * assertion does not accidentally pin the sort order, which is a different
 * feature with its own tests.
 */
function renderedRowNames(): string[] {
  return screen
    .queryAllByTestId("contact-row-name")
    .map((el) => el.textContent?.trim() ?? "")
    .sort();
}

const ALL_NAMES = ["Madeline Cho", "Madison Reed", "Tom Baker"];
const MAD_NAMES = ["Madeline Cho", "Madison Reed"];

function searchBox(): HTMLInputElement {
  return screen.getByTestId("contact-search-input") as HTMLInputElement;
}

async function waitForList(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText("Tom Baker")).toBeInTheDocument();
  });
}

describe("BACKLOG-2509 — search survives the detail pane", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({
      success: true,
      contacts: allContacts,
    });
    jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
      success: true,
      transactions: [],
    });
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  /**
   * THE CONTROL. Narrow is where the list is destroyed, so this is the test
   * that goes red when the lift is reverted (move the `useState` back into
   * `ContactSearchList` and run: this case, and only this case, fails).
   */
  it("narrow: keeps the query and the filtered rows across open/close [CONTROL]", async () => {
    installMatchMedia(true);
    render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();

    await userEvent.type(searchBox(), "mad");
    await waitFor(() => expect(renderedRowNames()).toEqual(MAD_NAMES));

    // Open a contact — below 1200px this replaces the list entirely.
    await userEvent.click(screen.getByText("Madison Reed"));
    await waitFor(() => {
      expect(screen.getByTestId("contacts-detail-view")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("contact-search-input")).not.toBeInTheDocument();

    // Back to the list.
    await userEvent.click(screen.getByTestId("contacts-detail-back"));
    await waitFor(() => {
      expect(screen.getByTestId("contact-search-input")).toBeInTheDocument();
    });

    expect(searchBox().value).toBe("mad");
    expect(renderedRowNames()).toEqual(MAD_NAMES);
  });

  /**
   * A PIN, NOT A CONTROL — stated plainly because an unstated control is an
   * unrun control.
   *
   * This case passes BEFORE the fix as well as after: on wide the list and the
   * detail pane are siblings, so the list was never unmounted and the query was
   * never lost. Reverting the lift does NOT redden it.
   *
   * Its job is twofold: it proved the narrow-vs-wide diagnosis by execution
   * before a line was edited (narrow red / wide green at the base commit), and
   * it now catches a future change that starts unmounting the list on wide.
   */
  it("wide: query and rows survive open/close [PIN — green before and after the fix]", async () => {
    installMatchMedia(false);
    render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();

    await userEvent.type(searchBox(), "mad");
    await waitFor(() => expect(renderedRowNames()).toEqual(MAD_NAMES));

    await userEvent.click(screen.getByText("Madison Reed"));
    await waitFor(() => {
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
    });

    expect(searchBox().value).toBe("mad");
    expect(renderedRowNames()).toEqual(MAD_NAMES);
  });

  /**
   * The list genuinely unmounts and remounts when the viewport crosses the
   * breakpoint with a contact open. Same property as the control, reached by a
   * different route — and the route BACKLOG-2591's picker swap will take.
   */
  it("narrow -> wide with a contact open: the query survives the remount [CONTROL]", async () => {
    const setNarrow = installMatchMedia(true);
    render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();

    await userEvent.type(searchBox(), "mad");
    await userEvent.click(screen.getByText("Madison Reed"));
    await waitFor(() => {
      expect(screen.getByTestId("contacts-detail-view")).toBeInTheDocument();
    });

    setNarrow(false);

    await waitFor(() => {
      expect(screen.getByTestId("contact-search-input")).toBeInTheDocument();
    });
    expect(searchBox().value).toBe("mad");
    expect(renderedRowNames()).toEqual(MAD_NAMES);
  });

  /**
   * D4: session-only. The filter model still persists; the query never does.
   * Reinstating persistence (any `localStorage.setItem` for the query) reddens
   * this and nothing else.
   */
  it("never persists the query, while filters keep persisting [CONTROL for D4]", async () => {
    installMatchMedia(false);
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();

    await userEvent.type(searchBox(), "mad");
    await waitFor(() => expect(renderedRowNames()).toEqual(MAD_NAMES));

    const keysWritten = new Set(setItem.mock.calls.map((c) => String(c[0])));
    keysWritten.delete(FILTER_MODEL_STORAGE_KEY);
    expect([...keysWritten]).toEqual([]);

    // And nothing anywhere in storage carries the text the user typed.
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? "");
    expect(stored.some((v) => v.includes("mad"))).toBe(false);

    setItem.mockRestore();
  });

  /**
   * The other half of session-only: closing the Contacts screen ends the
   * session. This is the boundary of the deliberate scope decision — the query
   * lives in `Contacts.tsx`, so it dies with `Contacts.tsx`.
   */
  it("clears when the Contacts screen is closed and reopened [CONTROL for D4]", async () => {
    installMatchMedia(false);
    const first = render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();
    await userEvent.type(searchBox(), "mad");
    await waitFor(() => expect(renderedRowNames()).toEqual(MAD_NAMES));

    first.unmount();

    render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();
    expect(searchBox().value).toBe("");
    expect(renderedRowNames()).toEqual(ALL_NAMES);
  });

  /**
   * `ContactSearchList` clears the box on Escape (`handleKeyDown`). That is the
   * ONLY other writer of the query, and it has to move to the lifted setter
   * too — otherwise Escape clears the child's dead copy and the box keeps its
   * text. Easy to miss.
   *
   * NOTE, recorded because the plan got it wrong: the plan called this the
   * "Enter-to-select clear". It is not — Enter selects the focused row and
   * leaves the query alone. Running the control at the base commit is what
   * caught it (the test failed for the wrong reason before a line was edited).
   */
  it("Escape still clears the box [CONTROL]", async () => {
    installMatchMedia(false);
    render(<Contacts userId={mockUserId} onClose={jest.fn()} />);
    await waitForList();

    await userEvent.type(searchBox(), "mad");
    await waitFor(() => expect(renderedRowNames()).toEqual(MAD_NAMES));

    await userEvent.type(searchBox(), "{Escape}");

    await waitFor(() => expect(searchBox().value).toBe(""));
    expect(renderedRowNames()).toEqual(ALL_NAMES);
  });

  /**
   * The controlled pair is OPTIONAL. The three picker call sites
   * (`ContactAssignmentStep`, and the transaction flows) pass
   * neither prop and must keep their own ephemeral search. Making the props
   * mandatory, or deleting the internal fallback, reddens this.
   */
  it("uncontrolled callers keep working with neither prop [CONTROL]", async () => {
    render(
      <ContactSearchList
        contacts={allContacts}
        selectedIds={[]}
        onSelectionChange={jest.fn()}
      />,
    );
    await waitFor(() => expect(renderedRowNames()).toEqual(ALL_NAMES));

    await userEvent.type(searchBox(), "mad");
    await waitFor(() => expect(renderedRowNames()).toEqual(MAD_NAMES));
    expect(searchBox().value).toBe("mad");
  });
});
