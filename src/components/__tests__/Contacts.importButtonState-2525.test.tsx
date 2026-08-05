/**
 * The Import button says something is happening, and three presses are one
 * import (BACKLOG-2525).
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Founder QA, 2026-08-05, on the build at `5037fcfc`:
 *
 *   > "on contact that have lots of emails and data the import button seems
 *   >  like it's not working — you can click it a few times and nothing
 *   >  happens. i was able to click it three times and i went back to the list
 *   >  and i see rosey 3 times"
 *
 * Three real `contacts` rows. Two things were wrong and only one of them is a
 * renderer problem:
 *
 *   A. `contacts:import` had no re-entry guard, so each press wrote another
 *      contact. THAT IS THE FAILURE, and it is fixed in the main process —
 *      pinned in `electron/__tests__/contact-handlers.importLinking.test.ts`,
 *      describe "BACKLOG-2525", where three concurrent invocations leave the
 *      `contacts` id set unchanged and removing the guard yields exactly the
 *      founder's three rows.
 *   B. Nothing on screen changed while the import ran, so pressing again was
 *      the only reasonable reading of the situation. That is this file.
 *
 * B lowers the odds; only A removes the failure. This file does not pretend
 * otherwise — it asserts what the USER SEES, plus the one behavioural promise
 * the renderer can keep on its own: a repeat press does not become a second IPC
 * round trip.
 *
 * ===========================================================================
 * THE IMPORT IS HELD OPEN, AND THAT IS NOT DECORATION
 * ===========================================================================
 * The state being tested exists only WHILE the call is in flight. With a mock
 * that resolves immediately, React coalesces the `true` and the `false` of the
 * flag into one commit, the disabled state is never rendered, and the test
 * passes against a build with no button state at all — which is precisely how
 * the first BACKLOG-2511 position test went green against broken code an hour
 * before this one was written.
 *
 * So `window.api.contacts.import` is a deferred promise this file releases by
 * hand, and every assertion that matters runs before the release. A real import
 * of the founder's record is slow for real reasons: it writes the contact, four
 * emails, three phones and the crosswalk rows, then runs a linking pass
 * (`contactHandlers.ts`, `runContactLinkingNow`) before it resolves.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const USER_ID = "user-2525";

const EXTERNAL_ROW_ID = "5a7c9e11-3d42-4b86-91ff-2e7d0c4a8b53";
const SAVED_CONTACT_ID = "9e1f3a55-7c28-4d0b-b4a6-8f2e5c1d7a90";

/**
 * THE SLOW RECORD — many emails and phones, which is the case the founder hit.
 *
 * Shape transcribed from the `contacts:get-available` projection, the same
 * fields the BACKLOG-2510 and BACKLOG-2511 suites pin. `id` is the shadow row's
 * own UUID; the saved contact gets a different one, which is why the two could
 * never collapse on id.
 */
const externalAddressBookRecord = {
  id: EXTERNAL_ROW_ID,
  name: "Rosey Calderbank",
  phone: "+15550118",
  email: "rosey.calderbank@example.test",
  company: "Calderbank Group",
  source: "contacts_app",
  allPhones: ["+15550118", "+15550119", "+15550120"],
  allEmails: [
    "rosey.calderbank@example.test",
    "rosey@example.com",
    "r.calderbank@example.test",
    "rosey.c@example.com",
  ],
  isFromDatabase: false,
  last_communication_at: "2026-08-01T09:12:00Z",
  externalRecordId: "AB-RECORD-7731",
  externalSourceType: "macos",
  externalUuid: "f0b2d5a8-6c19-4e73-8a05-1d9c3b7e2f44",
  collapsedSources: [
    {
      sourceType: "macos",
      sourceRecordId: "AB-RECORD-7731",
      externalUuid: "f0b2d5a8-6c19-4e73-8a05-1d9c3b7e2f44",
    },
  ],
} as unknown as Contact;

/** A second person, present throughout, so "the list survived" is checkable. */
const otherAddressBookRecord = {
  ...(externalAddressBookRecord as unknown as Record<string, unknown>),
  id: "1c8b4d60-9a37-42fe-8b51-6d0e7f2a3c94",
  name: "Oleg Vantry",
  phone: "+15550164",
  email: "oleg.vantry@example.test",
  allPhones: ["+15550164"],
  allEmails: ["oleg.vantry@example.test"],
  externalRecordId: "AB-RECORD-9902",
} as unknown as Contact;

/** The same person once saved — a DIFFERENT id. */
const savedRosey = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Rosey Calderbank",
  display_name: "Rosey Calderbank",
  email: "rosey.calderbank@example.test",
  phone: "+15550118",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-08-01T09:12:00Z",
  updated_at: "2026-08-01T09:12:00Z",
} as unknown as Contact;

/** Every row the list is rendering, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

function importButton(): HTMLElement {
  return screen.getByTestId("contact-preview-import");
}

/**
 * Wire the backend with the IMPORT held open.
 *
 * Returns the release function. Nothing resolves the import until it is called,
 * so every assertion in between runs in the window where a button with no state
 * and a button with state actually differ.
 */
function installBackendWithHeldImport() {
  let getAllCalls = 0;
  jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
    getAllCalls += 1;
    return { success: true, contacts: getAllCalls === 1 ? [] : [savedRosey] };
  });

  let getAvailableCalls = 0;
  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
    getAvailableCalls += 1;
    return {
      success: true,
      contacts:
        getAvailableCalls === 1
          ? [externalAddressBookRecord, otherAddressBookRecord]
          : [otherAddressBookRecord],
    };
  });

  let releaseImport!: () => void;
  const importInFlight = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  jest.mocked(window.api.contacts.import).mockImplementation(async () => {
    await importInFlight;
    return { success: true, contacts: [savedRosey] };
  });

  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });

  return { releaseImport, importInFlight };
}

/**
 * Open the card the founder pressed Import on.
 *
 * The DETAIL CARD, not a row button: on Clients & Contacts `compact` is true and
 * the row-level control is suppressed (`ContactSearchList.tsx:874-876` ->
 * `ContactRow.tsx:362`). The live button is `ContactPreview.tsx`.
 */
async function openRoseyCard() {
  await userEvent.click(screen.getByText("Rosey Calderbank"));
  await screen.findByTestId("contact-preview-import");
}

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(false);
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2525 — the button shows the import is running", () => {
  it("disables the button and says 'Importing…' while the call is in flight", async () => {
    const { releaseImport, importInFlight } = installBackendWithHeldImport();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [EXTERNAL_ROW_ID, otherAddressBookRecord.id].sort(),
      ),
    );
    await openRoseyCard();

    // Before: pressable, and it says so.
    expect(importButton()).toBeEnabled();
    expect(importButton()).toHaveTextContent("Import");

    await act(async () => {
      fireEvent.click(importButton());
    });

    // ---- THE IMPORT IS IN FLIGHT. This is the window that matters. ----
    expect(importButton()).toBeDisabled();
    expect(importButton()).toHaveTextContent("Importing");
    expect(importButton()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      releaseImport();
      await importInFlight;
    });

    await waitFor(() => expect(renderedContactIds()).toEqual(
      [SAVED_CONTACT_ID, otherAddressBookRecord.id].sort(),
    ));
  });

  it("turns THREE presses into ONE import call", async () => {
    /**
     * =====================================================================
     * THE FOUNDER'S THREE CLICKS, FIRED WITH NO `await` BETWEEN THEM
     * =====================================================================
     * A sequential version — click, await, click — tests nothing about
     * re-entry: the first call has already resolved and the row is gone. These
     * three are dispatched back to back against an import that has not
     * returned, which is the state he was actually in.
     *
     * ---------------------------------------------------------------------
     * WHICH MECHANISM THIS ACTUALLY PINS — MEASURED, NOT ASSUMED
     * ---------------------------------------------------------------------
     * Two things could hold this at one call, and it was worth finding out
     * which one does rather than assuming they overlap. Both controls were run
     * (2026-08-05, this worktree):
     *
     *   - Remove `disabled` from the button, keep the in-flight map:
     *     STILL ONE CALL. The three disabled/aria-busy assertions in this file
     *     go red; this one does not.
     *   - Keep `disabled`, remove the in-flight map:
     *     THREE CALLS. `Expected number of calls: 1 / Received number of
     *     calls: 3`.
     *
     * So the map is what this assertion measures, and `disabled` does NOT cover
     * for it. The reason is the `act` block below: React holds the updates from
     * all three clicks in one batch, so the re-render that would disable the
     * button has not committed when clicks two and three are dispatched. That
     * is the same-batch race the founder hit — a UI that had not caught up —
     * and it is why the presses are fired here with no `await` between them.
     *
     * `disabled` is still worth having: it is what he SEES, and it stops the
     * presses that arrive after a commit. But it is not what makes a repeat
     * press harmless.
     *
     * And neither of them is the fix. The main-process guard is
     * (`contact-handlers.importLinking.test.ts`, describe "BACKLOG-2525").
     */
    const { releaseImport, importInFlight } = installBackendWithHeldImport();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [EXTERNAL_ROW_ID, otherAddressBookRecord.id].sort(),
      ),
    );
    await openRoseyCard();

    const button = importButton();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(window.api.contacts.import).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseImport();
      await importInFlight;
    });

    // Still one after everything settles — the presses were folded, not queued
    // behind the first and replayed.
    expect(window.api.contacts.import).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(renderedContactIds()).toEqual(
      [SAVED_CONTACT_ID, otherAddressBookRecord.id].sort(),
    ));
  });

  it("shows the person exactly once after the three presses, by id", async () => {
    /**
     * The end state the founder checked when he "went back to the list". The
     * id set, not a count: one row of the wrong kind — the address-book record
     * surviving with its live Import button — would satisfy a count and be the
     * strictly worse outcome.
     */
    const { releaseImport, importInFlight } = installBackendWithHeldImport();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [EXTERNAL_ROW_ID, otherAddressBookRecord.id].sort(),
      ),
    );
    await openRoseyCard();

    const button = importButton();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await act(async () => {
      releaseImport();
      await importInFlight;
    });

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, otherAddressBookRecord.id].sort(),
      ),
    );
    expect(renderedContactIds()).not.toContain(EXTERNAL_ROW_ID);
  });

  it("does NOT put the list into a loading state while importing", async () => {
    /**
     * =====================================================================
     * THE THING THIS CHANGE MUST NOT BREAK
     * =====================================================================
     * BACKLOG-2511 made the post-import refresh SILENT on purpose. Every row is
     * gated on `!isLoading` (`ContactSearchList.tsx:847-849`), so raising the
     * flag swaps the whole list for a spinner; the scroll container's contents
     * collapse and the user's place goes with them — the place BACKLOG-2459
     * exists to keep, which the founder has already tested and passed.
     *
     * The obvious way to "show something is happening" is a list-level loading
     * flag. This test is here to make that mistake fail. Progress is shown on
     * the BUTTON; the list is not touched.
     *
     * Asserts element IDENTITY, not presence: a rebuilt list also has a row
     * there. jsdom performs no layout, so `scrollTop` cannot distinguish the
     * two outcomes — it is 0 either way — while the DOM node is replaced by any
     * unmount and preserved by in-place reconciliation, which is exactly what
     * "kept my place" means here.
     */
    const { releaseImport, importInFlight } = installBackendWithHeldImport();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [EXTERNAL_ROW_ID, otherAddressBookRecord.id].sort(),
      ),
    );

    // The row NOT involved in the import. It is present before and after, so if
    // the list is never torn down this exact element survives.
    const otherRowBefore = document.querySelector(
      `[data-contact-id="${otherAddressBookRecord.id}"]`,
    );
    expect(otherRowBefore).not.toBeNull();

    await openRoseyCard();
    await act(async () => {
      fireEvent.click(importButton());
    });

    // ---- IN FLIGHT: the button is busy, the list is not. ----
    expect(importButton()).toBeDisabled();
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(
      document.querySelector(`[data-contact-id="${otherAddressBookRecord.id}"]`),
    ).toBe(otherRowBefore);

    await act(async () => {
      releaseImport();
      await importInFlight;
    });
    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, otherAddressBookRecord.id].sort(),
      ),
    );

    // And it survived the refresh too, which is the BACKLOG-2511 promise.
    expect(
      document.querySelector(`[data-contact-id="${otherAddressBookRecord.id}"]`),
    ).toBe(otherRowBefore);
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
  });

  it("leaves the button pressable again if the import fails", async () => {
    /**
     * A failed import must not wedge the control. The in-flight entry is
     * cleared in a `finally` on the shared promise rather than after the
     * `await`, so a rejection releases it just as a success does — otherwise a
     * transient failure would leave the row permanently unimportable with no
     * way back except a reload.
     */
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({
      success: true,
      contacts: [],
    });
    jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({
      success: true,
      contacts: [externalAddressBookRecord],
    });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });

    let releaseImport!: () => void;
    const importInFlight = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    jest.mocked(window.api.contacts.import).mockImplementation(async () => {
      await importInFlight;
      return { success: false, error: "database is locked" };
    });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID]));
    await openRoseyCard();

    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(importButton()).toBeDisabled();

    await act(async () => {
      releaseImport();
      await importInFlight;
    });

    await waitFor(() => expect(importButton()).toBeEnabled());
    expect(importButton()).toHaveTextContent("Import");

    // And pressing again really does try again.
    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(window.api.contacts.import).toHaveBeenCalledTimes(2);
  });
});
