/**
 * A finished import does not take the screen back from you (BACKLOG-2527).
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Founder QA, 2026-08-05:
 *
 *   > "if i click back before it's done importing and i see the two rows, once
 *   > the import is done it forces me back to the contact details screen"
 *
 * He pressed Import, went back to the list while it was still running, and the
 * app took the screen back from him when it finished. This is not a brief
 * wrong-looking render like its sibling BACKLOG-2526 — it is the app OVERRIDING
 * A NAVIGATION THE USER PERFORMED, seconds after he performed it, on behalf of
 * an operation he had already left behind. It is unbounded in the bad
 * direction: the slower the import, the longer the window in which he can be
 * somewhere else when it lands.
 *
 * `handlePreviewImport` navigated on completion — `setPreviewContact(imported)`,
 * `selectContact(...)`, `loadContactTransactions(...)` — with no check that the
 * user was still where he was when he started.
 *
 * ===========================================================================
 * THE RULE, AND WHY THE 2459 NAVIGATION IS NOT SIMPLY DELETED
 * ===========================================================================
 * AN ASYNC COMPLETION MAY UPDATE WHAT THE USER IS LOOKING AT. IT MAY NOT DECIDE
 * WHAT THE USER IS LOOKING AT.
 *
 * Staying on the card is BACKLOG-2459's behaviour and the founder tested and
 * passed it: importing from the card leaves you on the card, now showing the
 * saved contact with its sources lit up. That is correct WHEN HE IS STILL
 * THERE. So the navigation is made conditional, not removed — and this file
 * asserts both halves, because a fix that just deleted it would pass a test for
 * the first half alone.
 *
 * ===========================================================================
 * WHY EVERY TEST HERE NAVIGATES *MID-FLIGHT*
 * ===========================================================================
 * The item body says it outright: a test that awaits the import before
 * navigating cannot catch this. By then the completion has already run and
 * there is nothing left to override. So `window.api.contacts.import` is a
 * deferred promise this file releases by hand — the pattern
 * `Contacts.importButtonState-2525.test.tsx` established — and the navigation
 * happens while it is pending.
 *
 * That weak shape is not merely avoided, it is RUN, as control C8: written to
 * await first, it stays green against the broken build. A test that would have
 * passed before the fix is not a test of the fix.
 *
 * ===========================================================================
 * FIXTURE PROVENANCE
 * ===========================================================================
 * Address-book rows follow the `contacts:get-available` projection transcribed
 * and pinned by `Contacts.importRefreshesExternalList-2511.test.tsx` and
 * `contact-handlers.importLinking.test.ts`. Addresses use RFC 2606 `.test`
 * domains and `<area> 555-01xx` numbers.
 */

import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";

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

/**
 * NARROW on purpose. The founder's "click back" is the full-screen detail
 * card's Back button, which only exists below 1200px (`Contacts.tsx` — wide
 * renders the card as a pane beside the list). Narrow is also the harsher
 * case: the detail view REPLACES the list, so being yanked back into it takes
 * the whole screen.
 */
function installMatchMedia(narrow: boolean) {
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue({
    matches: narrow,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => true,
  });
}

const USER_ID = "user-2527";

const IMPORTED_ROW_ID = "5c1d90ab-7e42-4f38-9b06-2a4e7c81d3f5";
const SAVED_CONTACT_ID = "e70b4c62-9d15-4a83-bf27-6c0d18e4a921";
const OTHER_ROW_ID = "1a83f47c-6b29-4d50-8e13-9f2c5b0a7d64";

const importTarget = {
  id: IMPORTED_ROW_ID,
  name: "Marlo Ashcombe",
  display_name: "Marlo Ashcombe",
  phone: "+12025550143",
  email: "marlo.ashcombe@example.test",
  company: "Ashcombe Group",
  source: "contacts_app",
  allPhones: ["+12025550143"],
  allEmails: ["marlo.ashcombe@example.test"],
  isFromDatabase: false,
  externalRecordId: "AB-RECORD-7731",
  externalSourceType: "macos",
  externalUuid: "b48f2a19-3d6c-4e07-91ab-5d2f8c1e0a73",
  collapsedSources: [
    {
      sourceType: "macos",
      sourceRecordId: "AB-RECORD-7731",
      externalUuid: "b48f2a19-3d6c-4e07-91ab-5d2f8c1e0a73",
    },
  ],
} as unknown as Contact;

/** A second address-book person, so "somewhere else" can be a real place. */
const otherPerson = {
  ...(importTarget as unknown as Record<string, unknown>),
  id: OTHER_ROW_ID,
  name: "Bex Trelawny",
  display_name: "Bex Trelawny",
  phone: "+12025550176",
  email: "bex.trelawny@example.test",
  allPhones: ["+12025550176"],
  allEmails: ["bex.trelawny@example.test"],
  externalRecordId: "AB-RECORD-7742",
  externalUuid: "c59a3b28-4e7d-4f18-a2bc-6e3a9d2f1b84",
} as unknown as Contact;

const savedMarlo = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Marlo Ashcombe",
  display_name: "Marlo Ashcombe",
  email: "marlo.ashcombe@example.test",
  phone: "+12025550143",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-08-01T09:12:00Z",
  updated_at: "2026-08-01T09:12:00Z",
} as unknown as Contact;

function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

const PRE_IMPORT_ROWS = [IMPORTED_ROW_ID, OTHER_ROW_ID].sort();
const POST_IMPORT_ROWS = [SAVED_CONTACT_ID, OTHER_ROW_ID].sort();

/**
 * The import is held open so the user can navigate WHILE it runs — the only
 * window in which this defect exists. Returns the release.
 */
function installBackend() {
  let releaseImport!: () => void;
  const importInFlight = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });

  let getAllCalls = 0;
  jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
    getAllCalls += 1;
    return { success: true, contacts: getAllCalls === 1 ? [] : [savedMarlo] };
  });

  let getAvailableCalls = 0;
  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
    getAvailableCalls += 1;
    return {
      success: true,
      contacts: getAvailableCalls === 1 ? [importTarget, otherPerson] : [otherPerson],
    };
  });

  jest.mocked(window.api.contacts.import).mockImplementation(async () => {
    await importInFlight;
    return { success: true, contacts: [savedMarlo] };
  });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });

  return {
    release: async () => {
      await act(async () => {
        releaseImport();
        await importInFlight;
      });
    },
  };
}

/** Open the card and press Import — WITHOUT waiting for it to finish. */
async function startImportFromCard(name: string) {
  await userEvent.click(screen.getByText(name));
  await userEvent.click(await screen.findByRole("button", { name: /^import$/i }));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
}

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(true);
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2527 — a finished import does not decide where you are", () => {
  it("leaves you on the list when you pressed Back while it was running", async () => {
    const backend = installBackend();

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

    await startImportFromCard("Marlo Ashcombe");
    expect(screen.getByTestId("contacts-detail-view")).toBeInTheDocument();

    // He goes back. The import is still running.
    await userEvent.click(screen.getByTestId("contacts-detail-back"));
    expect(screen.queryByTestId("contacts-detail-view")).not.toBeInTheDocument();

    await backend.release();
    await waitFor(() => expect(window.api.contacts.getAll).toHaveBeenCalledTimes(2));

    // The screen is still his. This is the assertion the item was filed for, and
    // it is FIRST so that a regression names the defect instead of reporting the
    // list as mysteriously empty — on the broken build the card is back, and
    // narrow renders the card INSTEAD of the list, so every row disappears as a
    // side effect of the yank.
    expect(screen.queryByTestId("contacts-detail-view")).not.toBeInTheDocument();

    // And the list still updated underneath him — that is an UPDATE, and updates
    // are allowed. Only the navigation was withheld.
    await waitFor(() => expect(renderedContactIds()).toEqual(POST_IMPORT_ROWS));
  });

  it("leaves you on the OTHER contact when you opened one mid-import", async () => {
    /**
     * Not in the item's acceptance wording, and the same defect wearing
     * different clothes. A guard that only asked "is the card closed?" would
     * still yank him off the person he chose and onto the one he imported.
     */
    const backend = installBackend();

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

    await startImportFromCard("Marlo Ashcombe");

    // Back to the list, then straight into somebody else.
    await userEvent.click(screen.getByTestId("contacts-detail-back"));
    await userEvent.click(screen.getByText("Bex Trelawny"));
    expect(
      await within(screen.getByTestId("contacts-detail-view")).findByTestId(
        "contact-preview-name",
      ),
    ).toHaveTextContent("Bex Trelawny");

    await backend.release();
    await waitFor(() => expect(window.api.contacts.getAll).toHaveBeenCalledTimes(2));

    // Still Bex. The import landed on the list, not on his attention.
    expect(
      within(screen.getByTestId("contacts-detail-view")).getByTestId("contact-preview-name"),
    ).toHaveTextContent("Bex Trelawny");
  });

  it("still updates the card in place when you stayed on it (BACKLOG-2459)", async () => {
    /**
     * The other half, and the reason the navigation is conditional rather than
     * deleted. Founder, BACKLOG-2459: *"i clicked import and the screen
     * re-rendered to the list of contacts, it exited the contact detail
     * screen"*. Landing him on the list after an ordinary import is the bug
     * this behaviour exists to prevent, and a 2527 fix that overreached would
     * reintroduce it.
     */
    const backend = installBackend();

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

    await startImportFromCard("Marlo Ashcombe");
    await backend.release();

    // No list assertion here, and that is not an omission: narrow REPLACES the
    // list with the detail view, so while he is on the card there are no rows on
    // screen to assert. The list's own post-import state is the first test's
    // subject. Waiting on the refresh is what makes this assertion land after
    // the completion rather than before it.
    await waitFor(() => expect(window.api.contacts.getAll).toHaveBeenCalledTimes(2));

    // Still on the card, and it is now the SAVED contact — which is what lights
    // up the sources and comms sections the import was asked to settle.
    const detail = screen.getByTestId("contacts-detail-view");
    expect(within(detail).getByTestId("contact-preview-name")).toHaveTextContent(
      "Marlo Ashcombe",
    );
    expect(screen.queryByRole("button", { name: /^import$/i })).not.toBeInTheDocument();
  });
});
