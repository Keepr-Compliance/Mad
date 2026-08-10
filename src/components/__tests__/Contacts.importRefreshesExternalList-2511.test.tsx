/**
 * Importing someone does not leave them on screen twice (BACKLOG-2511).
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Founder QA, 2026-08-05. He imported a contact from Clients & Contacts and the
 * person then appeared TWICE, adjacent, one row badged "Added". He checked both:
 *
 *   > "the first shows … Imported · Added Aug 5, 2026 … Edit Contact … Remove"
 *   > "the 2nd row (which has the added green check on it) has … Not Imported … Import"
 *   > "i looks i have tad only once on my contacts app"
 *
 * Row one is the saved contact. Row two is the address-book record, still
 * offering to import a person who has just been imported. His address book
 * contains them once — nothing was duplicated in his data.
 *
 * This screen renders TWO lists joined in the renderer: `contacts:get-all` and
 * `contacts:get-available`. Importing refreshed only the first, so the stale
 * address-book row survived in component state. `assembleContacts` collapses on
 * exact `id` only (`contactPickerList.ts:268-285`) and the two rows hold
 * different ids — the fresh contact UUID and the shadow-table UUID — so nothing
 * merged them, and sharing a `stableIdentityKey` made them sort adjacent.
 *
 * ===========================================================================
 * WHY THE ASSERTIONS BELOW ARE ID SETS AND NEVER COUNTS
 * ===========================================================================
 * This defect's exact shape is the right NUMBER of the wrong rows. Before the
 * import there is one row; after a broken import there are two; after a fixed
 * import there is one again. A test asserting "one row" would agree with the
 * fixed build and with a build that dropped the saved contact and kept the
 * address-book record — the strictly worse outcome, since that row's Import
 * button is live. So every assertion reads `data-contact-id`
 * (`ContactRow.tsx:189-190`) and compares the SET.
 *
 * ===========================================================================
 * THE FIXTURE'S SECOND `getAvailable` IS TRANSCRIBED, NOT WISHED FOR
 * ===========================================================================
 * The mock returns the record on the first call and nothing on the second. That
 * is an assertion about the main process, and it is the one this whole fix rests
 * on — if `contacts:get-available` still offered the record, refreshing would
 * change nothing and this file would be describing a state the app cannot reach.
 *
 * It is pinned by execution against the real handler and a real SQLite crosswalk
 * in `electron/__tests__/contact-handlers.importLinking.test.ts`, describe
 * "BACKLOG-2511 — an imported record is gone from the NEXT picker call": the
 * record is offered before `contacts:import` and not after, the funnel line
 * counts it as `already-imported 1`, and deleting the crosswalk row brings it
 * back. That became true only when BACKLOG-2510 (PR #2223) routed this flow
 * through `contacts:import`; while it wrote the synthetic `origin:<contactId>`
 * row instead, suppression could not match a real address-book id at all.
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
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

const USER_ID = "user-2511";

const EXTERNAL_ROW_ID = "8f14e45f-ceea-4e78-9e2d-3b1a7c0d5e62";
const SAVED_CONTACT_ID = "b2c4d6e8-1a3f-4c5b-8d7e-6f9a0b1c2d3e";

/**
 * ONE address-book record, exactly as `contacts:get-available` emits it.
 *
 * Transcribed from the projection at `electron/handlers/contactHandlers.ts`
 * (same shape the BACKLOG-2510 suite pins), identity fields included. `id` is
 * the shadow row's own UUID, which is why it can never equal the saved
 * contact's id and why the two rows could not collapse.
 */
const externalAddressBookRecord = {
  id: EXTERNAL_ROW_ID,
  name: "Tam Wexford",
  phone: "+15550187",
  email: "tam.wexford@example.test",
  company: "Wexford Realty",
  source: "contacts_app",
  allPhones: ["+15550187"],
  allEmails: ["tam.wexford@example.test"],
  isFromDatabase: false,
  last_communication_at: "2026-07-30T11:04:00Z",
  externalRecordId: "AB-RECORD-4417",
  externalSourceType: "macos",
  externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
} as unknown as Contact;

/** The same person once saved — a DIFFERENT id, which is the crux. */
const savedTam = {
  id: SAVED_CONTACT_ID,
  user_id: USER_ID,
  name: "Tam Wexford",
  display_name: "Tam Wexford",
  email: "tam.wexford@example.test",
  phone: "+15550187",
  source: "contacts_app",
  is_imported: 1,
  created_at: "2026-07-30T11:04:00Z",
  updated_at: "2026-07-30T11:04:00Z",
} as unknown as Contact;

/** Every row the list is currently rendering, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

/**
 * The names the LIST is showing.
 *
 * Scoped to `contact-row-name` rather than a bare text query because the detail
 * card stays open on the contact after an import (BACKLOG-2459), so the person's
 * name is legitimately on screen twice — once in the list, once on the card.
 * A bare `getByText` cannot tell that apart from the duplicate row this file
 * exists to catch, and would throw on the honest case.
 */
function renderedRowNames(): string[] {
  return screen
    .queryAllByTestId("contact-row-name")
    .map((el) => el.textContent ?? "")
    .sort();
}

/**
 * Wire the two lists to answer differently before and after the import, which
 * is what the main process does: the saved list gains the contact, the address
 * book stops offering the record it was made from.
 */
function installBackend(options?: { availableAfterImport?: Contact[] }) {
  const afterImport = options?.availableAfterImport ?? [];

  let getAllCalls = 0;
  jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
    getAllCalls += 1;
    return { success: true, contacts: getAllCalls === 1 ? [] : [savedTam] };
  });

  let getAvailableCalls = 0;
  jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
    getAvailableCalls += 1;
    return {
      success: true,
      contacts: getAvailableCalls === 1 ? [externalAddressBookRecord] : afterImport,
    };
  });

  jest
    .mocked(window.api.contacts.import)
    .mockResolvedValue({ success: true, contacts: [savedTam] });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });
}

/**
 * Import the record the way the founder did.
 *
 * Through the DETAIL CARD, not a row button. On Clients & Contacts `compact` is
 * true, and that suppresses the row-level Import control
 * (`ContactSearchList.tsx:874-876` -> `ContactRow.tsx:362`). The live button is
 * the card's (`Contacts.tsx` -> `ContactPreview.tsx:614-616`). A test driving a
 * row button would be driving a control this screen does not show.
 */
async function importViaDetailCard() {
  await userEvent.click(screen.getByText("Tam Wexford"));
  await userEvent.click(await screen.findByRole("button", { name: /^import$/i }));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
}

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(false);
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2511 — the imported person is on screen exactly once", () => {
  it("replaces the address-book row with the saved contact, by id", async () => {
    installBackend();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    // BEFORE: one row, and it is the address-book record.
    await waitFor(() => expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID]));

    await importViaDetailCard();

    // AFTER: one row, and it is the SAVED CONTACT. Both halves matter. Without
    // the id, "one row" would also accept the address-book record surviving and
    // the saved contact never arriving.
    await waitFor(() => expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID]));

    // And the stale row is not merely out of view — it is gone from the list.
    expect(renderedContactIds()).not.toContain(EXTERNAL_ROW_ID);
  });

  it("asks the address book again, which is the only reason the row goes", async () => {
    installBackend();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID]));

    await importViaDetailCard();
    await waitFor(() => expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID]));

    // Once on mount, once after the import. `useContactList` guards the fetch
    // with `externalContactsLoadedRef` for the lifetime of the mount
    // (`useContactList.ts:155`), so a second call only happens if the import
    // path deliberately went through `reloadExternalContacts`, which clears it.
    expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2);
    expect(window.api.contacts.getAll).toHaveBeenCalledTimes(2);
  });

  it("leaves no Import button on screen for a person already imported", async () => {
    installBackend();
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID]));

    await importViaDetailCard();
    await waitFor(() => expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID]));

    // THE P0. The stale row's Import button was live, and pressing it calls the
    // same import again — which creates a genuine second contact, pinned by
    // execution in `contact-handlers.importLinking.test.ts` ("creates a SECOND
    // contact if the same record is imported twice"). There is no manual merge
    // in the app yet (BACKLOG-2426/2471 unbuilt), so that duplicate cannot be
    // undone. The row being gone is what makes it unreachable.
    expect(screen.queryAllByTestId("contact-row-import-button")).toHaveLength(0);
    expect(window.api.contacts.import).toHaveBeenCalledTimes(1);
  });

  it("keeps the OTHER address-book records, dropping only the one imported", async () => {
    /**
     * The refresh must not be mistaken for a clear. `reloadExternalContacts`
     * resets the once-per-mount guard and refetches; if it left the list empty,
     * or if the fix had instead dropped rows from renderer state, every other
     * person in the address book would vanish from the screen too — and this
     * assertion would be the only thing to notice.
     */
    const otherRecord = {
      ...(externalAddressBookRecord as unknown as Record<string, unknown>),
      id: "c1d3e5f7-2b4a-4d6c-9e8f-0a1b2c3d4e5f",
      name: "Rea Vandal",
      email: "rea.vandal@example.test",
      allEmails: ["rea.vandal@example.test"],
      phone: "+15550142",
      allPhones: ["+15550142"],
      externalRecordId: "AB-RECORD-9902",
    } as unknown as Contact;

    installBackend({ availableAfterImport: [otherRecord] });
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID]));

    await importViaDetailCard();

    await waitFor(() =>
      expect(renderedContactIds()).toEqual(
        [SAVED_CONTACT_ID, "c1d3e5f7-2b4a-4d6c-9e8f-0a1b2c3d4e5f"].sort(),
      ),
    );
    expect(screen.getByText("Rea Vandal")).toBeInTheDocument();
  });

  it("refreshes WITHOUT rebuilding the list, so the user keeps their place", async () => {
    /**
     * =====================================================================
     * FOUNDER CONSTRAINT: THE REFRESH MUST NOT COST HIM HIS PLACE.
     * =====================================================================
     * > "just make sure this doesn't interfere with keeping the location on
     * >  the page the user was on, i'm suspecting the engineer will try to
     * >  propose re-rendering the whole list"
     *
     * His suspicion was correct and this test is the reason the fix is not the
     * obvious one. On the wide two-pane layout — where he imports from the
     * detail pane with the list still beside it — NOTHING stores his position.
     * The anchor machinery (BACKLOG-2459, `ContactSearchList.tsx:519-534` and
     * `:544-564`) only runs when the detail view REPLACES the list, which is the
     * narrow layout. Wide, his place survives for one reason: the scroll
     * container at `ContactSearchList.tsx:744` stays mounted and keeps its
     * `scrollTop`.
     *
     * That is destroyed by a spinner, not just by a remount. Every row is gated
     * on `!isLoading` (`ContactSearchList.tsx:847-849`), and
     * `externalContactsLoading` is part of `isLoading`, so raising it swaps the
     * whole list for a spinner — the content collapses, the offset has nothing
     * to point at, and the list returns at the top. `reloadExternalContacts`
     * therefore refetches SILENTLY (`useContactList.ts`).
     *
     * WHY THIS ASSERTS A DOM NODE AND NOT A SCROLL OFFSET. jsdom performs no
     * layout, so `scrollTop` cannot be set to a non-zero value on an element it
     * considers unscrollable — a scroll assertion here would pass on 0 === 0
     * forever and pin nothing. Element identity is the property that actually
     * distinguishes the two outcomes: React reconciling rows in place keeps the
     * SAME DOM node, and any unmount/remount of the list — spinner included —
     * produces a new one. Rebuilding the list is exactly what "loses your place"
     * means here, so this is the mechanism, not a proxy for it.
     *
     * =====================================================================
     * WHY THE SECOND FETCH IS HELD OPEN, AND WHY THAT IS NOT DECORATION
     * =====================================================================
     * The first version of this test let both mocks resolve immediately and
     * asserted only the end state. IT PASSED WITH THE FIX AND PASSED AGAIN WITH
     * THE FIX REVERTED — a check whose inputs cannot separate pass from fail.
     *
     * The reason is React 18 batching. With an instant mock, the `true` and
     * `false` of the loading flag land close enough together to be coalesced
     * into a single render, so the spinner state is never committed and no row
     * is ever unmounted. The harness was hiding the defect, not the assertion
     * missing it.
     *
     * A real `contacts:get-available` is an IPC round trip that reads the whole
     * address book — slow enough to have been moved to a worker thread
     * (TASK-1956, ~3.7s at 1000+ contacts). The spinner absolutely does commit
     * in the app. So the fixture is held open deliberately, and the assertions
     * that matter run WHILE THE REFETCH IS IN FLIGHT, which is the only window
     * in which the two implementations differ.
     */
    const persistingRecord = {
      ...(externalAddressBookRecord as unknown as Record<string, unknown>),
      id: "d4e6f8a0-3c5b-4e7d-af90-1b2c3d4e5f60",
      name: "Rea Vandal",
      email: "rea.vandal@example.test",
      allEmails: ["rea.vandal@example.test"],
      phone: "+15550142",
      allPhones: ["+15550142"],
      externalRecordId: "AB-RECORD-9902",
    } as unknown as Contact;

    let getAllCalls = 0;
    jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
      getAllCalls += 1;
      return { success: true, contacts: getAllCalls === 1 ? [] : [savedTam] };
    });

    // The post-import address-book fetch, held open until this test releases it.
    let releaseRefetch!: () => void;
    const refetchInFlight = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });

    let getAvailableCalls = 0;
    jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
      getAvailableCalls += 1;
      if (getAvailableCalls === 1) {
        return {
          success: true,
          contacts: [externalAddressBookRecord, persistingRecord],
        };
      }
      await refetchInFlight;
      return { success: true, contacts: [persistingRecord] };
    });

    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [savedTam] });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() =>
      expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID, persistingRecord.id].sort()),
    );

    // The row that is NOT involved in the import. It is in the list before and
    // after, so if the list survives the refresh this exact element does too.
    const rowBefore = document.querySelector(
      `[data-contact-id="${persistingRecord.id}"]`,
    );
    expect(rowBefore).not.toBeNull();

    await importViaDetailCard();
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));

    // ---- THE REFETCH IS NOW IN FLIGHT. This is the window that matters. ----
    //
    // A non-silent refetch has raised `externalContactsLoading` by this point
    // and the list is a spinner: no rows at all, and certainly not the same
    // ones. A silent refetch leaves every row exactly where it was, showing the
    // pre-refresh data until the new data arrives.
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(document.querySelector(`[data-contact-id="${persistingRecord.id}"]`)).toBe(
      rowBefore,
    );

    await act(async () => {
      releaseRefetch();
      await refetchInFlight;
    });

    await waitFor(() =>
      expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID, persistingRecord.id].sort()),
    );

    // And it survived the whole way through. Not "the row is still there" — a
    // rebuilt list also has a row there. The SAME NODE, so the list was never
    // torn down and the scroll container it lives in never lost its contents.
    expect(document.querySelector(`[data-contact-id="${persistingRecord.id}"]`)).toBe(
      rowBefore,
    );
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
  });

  it("still shows the imported person once when a DIFFERENTLY NAMED record shares the identity", async () => {
    /**
     * THE NAME-DIFFERS CASE, and why it is worth its own test.
     *
     * The address book and the saved contact need not agree on the name — a
     * record filed as "Tam Wexford" can be saved as "Tam Wexford (Wexford
     * Realty)", or the user edits it. The two rows then no longer share a
     * `stableIdentityKey`, so they do not sort adjacent and the duplication is
     * HARDER to spot, not easier: the same person sits in two places in a long
     * list rather than side by side.
     *
     * Suppression does not care, because it matches on
     * `(source_type, external_record_id)` and not on the name — that is exactly
     * the property BACKLOG-2401 introduced it for, so a rename in the address
     * book cannot resurrect an imported record. This pins that the renderer
     * benefits from it: one row, the saved one, under whatever name it now has.
     */
    const renamedSaved = {
      ...(savedTam as unknown as Record<string, unknown>),
      name: "Tam Wexford (Wexford Realty)",
      display_name: "Tam Wexford (Wexford Realty)",
    } as unknown as Contact;

    let getAllCalls = 0;
    jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
      getAllCalls += 1;
      return { success: true, contacts: getAllCalls === 1 ? [] : [renamedSaved] };
    });
    let getAvailableCalls = 0;
    jest.mocked(window.api.contacts.getAvailable).mockImplementation(async () => {
      getAvailableCalls += 1;
      return {
        success: true,
        contacts: getAvailableCalls === 1 ? [externalAddressBookRecord] : [],
      };
    });
    jest
      .mocked(window.api.contacts.import)
      .mockResolvedValue({ success: true, contacts: [renamedSaved] });
    jest
      .mocked(window.api.contacts.checkCanDelete)
      .mockResolvedValue({ success: true, transactions: [] });

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual([EXTERNAL_ROW_ID]));

    await importViaDetailCard();

    await waitFor(() => expect(renderedContactIds()).toEqual([SAVED_CONTACT_ID]));

    // The list shows the person ONCE, under the saved name. The address-book
    // spelling is gone from the list entirely — which is the thing that would
    // otherwise be sitting somewhere else in it, unnoticed.
    expect(renderedRowNames()).toEqual(["Tam Wexford (Wexford Realty)"]);
  });
});
