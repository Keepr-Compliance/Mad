/**
 * TICKING "ALL SOURCES" IS A DURABLE CHANGE, AND THE HEADER MUST FOLLOW IT
 * BACKLOG-2671 — founder-confirmed 11 Aug 2026
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * The select-all row means EVERY ENABLED OPTION — `trueSelectAll` semantics —
 * not "restore defaults". The founder confirmed that on 11 Aug: ticking it turns
 * the Inferred sources (From Email, From Texts) ON, and those are OFF in the
 * default selection.
 *
 * That makes ONE CLICK a durable change to what the contacts list shows. The
 * Contacts screen runs the filter in `persistent` mode, so the selection is
 * written to `localStorage` under `contactModal.filterModel.v1`
 * (`ContactSearchList.saveContactFilters`) and survives a reload. A user who
 * ticks All and quits comes back to a list that includes text-derived
 * pseudo-contacts, with nothing on screen announcing that he changed anything.
 *
 * Intended behaviour is exactly the kind that needs a test, because the next
 * reader has no way to tell it apart from an accident.
 *
 * ===========================================================================
 * THE SECOND ASSERTION IS THE POINT OF THE WHOLE TICKET
 * ===========================================================================
 * Every case below also asserts THE HEADER'S NUMBER EQUALS THE NUMBER OF ROWS
 * RENDERED. That pairing is what BACKLOG-2662 broke — its header counted one
 * population and its parenthetical another, which is how `1173 contacts (1171
 * from Contacts App)` reached the founder — and BACKLOG-2671 moved the
 * per-source numbers into the dropdown precisely so the two can never disagree
 * again. A filter change that moved the list without moving the header, or vice
 * versa, would be that defect returning through a different door.
 *
 * Read across the two files: `ContactSearchList.selectAll-2671.test.tsx` proves
 * the SELECTION survives a remount; this one proves the HEADER AND THE LIST
 * agree on both sides of that remount. The list component has no header, so it
 * cannot make the second claim.
 */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";
import { INFERRED_SOURCE_LEAF_IDS } from "../../utils/contactFilterModel";

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
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

const mockUserId = "user-123";
const FILTER_STORAGE_KEY = "contactModal.filterModel.v1";

function installMatchMedia(): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: false,
    media: "",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: () => true,
  });
}

/** One row as `contacts:get-all` emits it from the local `contacts` table. */
function savedRow(id: string, name: string, source: string): Contact {
  return {
    id,
    name,
    display_name: name,
    email: `${id}@example.com`,
    phone: null,
    source,
    is_message_derived: 0,
    is_imported: 1,
  } as unknown as Contact;
}

/**
 * A message-derived pseudo-contact, as `messageDerivedAsContacts` synthesises it
 * inside `contacts:get-all` — `source: "messages"`, `is_message_derived: 1`, no
 * row of its own in the `contacts` table. This is the population the Inferred
 * leaves gate, and therefore the row that appears when All is ticked.
 */
function messageDerivedRow(id: string, name: string): Contact {
  return {
    id,
    name,
    display_name: name,
    email: null,
    phone: null,
    source: "messages",
    is_message_derived: 1,
  } as unknown as Contact;
}

const SAVED: Contact[] = [
  savedRow("saved-1", "Alice Imported", "contacts_app"),
  savedRow("saved-2", "Bob Imported", "outlook"),
  messageDerivedRow("derived-1", "Someone Who Texted"),
];

/** The header's number, parsed. */
const headerCount = (): number =>
  Number(/^(\d+)/.exec(screen.getByTestId("contacts-header-count").textContent ?? "")?.[1]);

/** How many rows the list is actually rendering. */
const renderedRowCount = (): number => screen.queryAllByTestId("contact-row").length;

const storedSources = (): string[] =>
  JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? '{"sources":[]}').sources;

async function renderScreen(): Promise<void> {
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: SAVED,
  } as never);
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({
    success: true,
    contacts: [],
  } as never);

  render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

  await waitFor(() => expect(renderedRowCount()).toBeGreaterThan(0));
}

describe("BACKLOG-2671 — ticking All sources is durable, and the header follows the list", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    installMatchMedia();
    jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
      success: true,
      transactions: [],
    } as never);
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("hides the text-derived contact by default, and the header agrees", async () => {
    await renderScreen();

    // The default selection leaves the Inferred group off, so the synthesised
    // row is not on screen. This is the BEFORE state the click changes.
    expect(screen.queryByText("Someone Who Texted")).not.toBeInTheDocument();
    expect(renderedRowCount()).toBe(2);
    await waitFor(() => expect(headerCount()).toBe(2));
  });

  it("shows it after one click on All sources, and the header moves with it", async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(screen.getByTestId("source-filter-select-all-checkbox"));

    expect(screen.getByText("Someone Who Texted")).toBeInTheDocument();
    expect(renderedRowCount()).toBe(3);
    await waitFor(() => expect(headerCount()).toBe(3));

    // The founder-confirmed meaning, in the persisted payload rather than in a
    // comment: All includes the leaves the default leaves off.
    for (const leafId of INFERRED_SOURCE_LEAF_IDS) {
      expect(storedSources()).toContain(leafId);
    }
  });

  /**
   * THE RELOAD. `localStorage` is untouched between the unmount and the second
   * render, which is what a quit-and-reopen looks like to this component.
   */
  it("survives a reload — and the header still equals the list afterwards", async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(screen.getByTestId("source-filter-select-all-checkbox"));
    await waitFor(() => expect(headerCount()).toBe(3));

    cleanup();
    await renderScreen();

    // The one click still governs what he sees, with nothing on screen saying so.
    expect(screen.getByText("Someone Who Texted")).toBeInTheDocument();
    expect(renderedRowCount()).toBe(3);
    await waitFor(() => expect(headerCount()).toBe(3));
    // And the header is not merely a number that happens to match — it tracks
    // the rendered rows, which is the invariant BACKLOG-2662 broke.
    expect(headerCount()).toBe(renderedRowCount());
  });

  /**
   * "ALL" IS NOT "RESTORE DEFAULTS", AND THERE IS NO CONTROL THAT IS.
   *
   * Stated as an executable fact rather than a comment, because the absence
   * reads as an oversight and the obvious "fix" — making this row restore the
   * default selection — is explicitly NOT what the founder chose. Clicking All a
   * second time clears to NONE; it does not return to the default. Getting the
   * Inferred sources back off means unticking two leaves by hand.
   */
  it("clicking All again clears to none — it does not restore the default selection", async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(screen.getByTestId("source-filter-select-all-checkbox")); // -> all
    expect(renderedRowCount()).toBe(3);

    await user.click(screen.getByTestId("source-filter-select-all-checkbox")); // -> none
    expect(renderedRowCount()).toBe(0);
    expect(storedSources()).toEqual([]);

    // Not the default (which would have shown the two non-derived rows), and the
    // header follows the list into the empty state rather than holding a stale
    // number.
    await waitFor(() => expect(headerCount()).toBe(0));
    // The user is not stranded — BACKLOG-2141's escape hatch is the way back.
    expect(screen.getByTestId("show-all-filters")).toBeInTheDocument();
  });
});
