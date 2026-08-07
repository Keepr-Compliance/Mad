/**
 * Importing someone never puts them on screen twice, not even for an instant
 * (BACKLOG-2526).
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * Founder QA, 2026-08-05, after BACKLOG-2510/2511/2525 had all landed:
 *
 *   > "if i click import then go back to the list of contacts, for a brief sec
 *   > i see both contacts. one has the added green pill on it which is on the
 *   > external contact being added — not added in the past. then it resolves
 *   > and that line with the added disappears and only one stays."
 *
 * Both underlying defects were fixed. What he was watching was the TRANSITION
 * between them.
 *
 * BACKLOG-2511 made the import refresh both lists, awaited together:
 *
 *     await Promise.all([silentLoadContacts(), reloadExternalContacts()])
 *
 * `Promise.all` gates the code AFTER it. It does not gate the two state writes
 * INSIDE it. `silentLoadContacts` committed the moment `contacts:getAll`
 * returned; `loadExternalContacts` committed the moment `contacts:getAvailable`
 * returned. Separate continuations, separate renders — and between those two
 * renders the list held the new saved contact AND the address-book row it was
 * made from, because `assembleContacts` collapses on exact `id` only
 * (`contactPickerList.ts:268-285`) and those two ids differ by construction.
 *
 * The gap is the common case, not a rare one: `contacts:get-available` reads the
 * whole address book on a worker thread (~3.7s at 1000+ contacts, TASK-1956),
 * so the saved-contact fetch reliably lands first.
 *
 * ===========================================================================
 * WHY THE SECOND `getAvailable` IS HELD OPEN — AND WHY THAT IS THE TEST
 * ===========================================================================
 * The two implementations differ ONLY while the address-book refetch is in
 * flight. Both produce the same end state. So a test that awaits the import and
 * asserts the final list agrees with the fixed build and with the broken one —
 * and the BACKLOG-2511 file records that exact failure happening to it once
 * already, in its own docblock.
 *
 * So every assertion that matters here runs inside the held-open window. Let
 * both mocks resolve instantly and React coalesces the two commits by accident,
 * the defect is invisible, and this file proves nothing. That is control C5, and
 * its expected verdict was written down before it was run: the instant-mock
 * variant must go GREEN on unmodified code.
 *
 * ===========================================================================
 * THIS FILE'S FIRST ASSERTION IS NOT MINE
 * ===========================================================================
 * The SR plan review (`9042cb8f-ab0c-42b5-a1a8-d2efed829a7a`) did not take the
 * claim "the existing 2511 harness already opens this window and looks away" on
 * reasoning. It cut a throwaway worktree at `ab203538`, inserted ONE line into
 * that file's in-flight window, and got the red:
 *
 *     - Expected  - 0
 *     + Received  + 1
 *       Array [
 *         "8f14e45f-ceea-4e78-9e2d-3b1a7c0d5e62",
 *     +   "b2c4d6e8-1a3f-4c5b-8d7e-6f9a0b1c2d3e",
 *         "d4e6f8a0-3c5b-4e7d-af90-1b2c3d4e5f60",
 *       ]
 *
 * That middle id is `SAVED_CONTACT_ID`: three rows where two belong, the saved
 * contact and its own address-book row on screen together. `it("holds the
 * pre-import list…")` below is that probe, taken verbatim rather than
 * re-derived.
 *
 * ===========================================================================
 * FIXTURE PROVENANCE
 * ===========================================================================
 * The records, ids and the two-lists-answer-differently harness are copied
 * BYTE-IDENTICAL from `Contacts.importRefreshesExternalList-2511.test.tsx`,
 * which transcribed them from the `contacts:get-available` projection in
 * `electron/handlers/contactHandlers.ts` and pinned the suppression they depend
 * on by execution against a real SQLite crosswalk
 * (`contact-handlers.importLinking.test.ts`, describe "BACKLOG-2511"). They are
 * not re-typed here, so the red above stays directly comparable.
 *
 * Fields this file ADDS — the extra addresses that separate a fetched row from
 * the thin one `contacts:import` returns — use RFC 2606 `.test` domains and
 * `<area> 555-01xx` numbers.
 */

import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";

/**
 * ===========================================================================
 * EVERY FRAME THE LIST WAS ASKED TO RENDER, RECORDED AT ITS INPUT
 * ===========================================================================
 * The DOM assertions below catch a commit that lands EARLY — the saved contact
 * appearing while the address book is still in flight, which is the defect the
 * founder reported. They cannot catch a second commit that lands inside the
 * same flush, because `act()` coalesces everything in its scope and the DOM only
 * ever shows the final state. That was established by running the control:
 * putting an `await` — microtask AND macrotask — between the two setters left
 * every DOM assertion green.
 *
 * In the app there is no `act()`. A commit between those two setters is a frame
 * the user can see. So the property is pinned where batching cannot hide it: at
 * the props `ContactSearchList` is called with, recorded on every render. The
 * two lists are joined inside that component, so a render holding the saved
 * contact in `contacts` AND the address-book row it was made from in
 * `externalContacts` IS the person on screen twice — whether or not the DOM was
 * flushed in between.
 *
 * The real component still renders: this wraps it, it does not replace it.
 */
const mockListRenders: Array<{ contacts: string[]; external: string[] }> = [];

jest.mock("../shared/ContactSearchList", () => {
  const actual = jest.requireActual("../shared/ContactSearchList");
  const react = jest.requireActual("react");
  return {
    ...actual,
    ContactSearchList: (props: Record<string, unknown>) => {
      mockListRenders.push({
        contacts: ((props.contacts as { id: string }[]) ?? []).map((c) => c.id),
        external: ((props.externalContacts as { id: string }[]) ?? []).map((c) => c.id),
      });
      return react.createElement(actual.ContactSearchList, props);
    },
  };
});

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

const USER_ID = "user-2526";

const EXTERNAL_ROW_ID = "8f14e45f-ceea-4e78-9e2d-3b1a7c0d5e62";
const SAVED_CONTACT_ID = "b2c4d6e8-1a3f-4c5b-8d7e-6f9a0b1c2d3e";
const PERSISTING_ROW_ID = "d4e6f8a0-3c5b-4e7d-af90-1b2c3d4e5f60";

/** The address-book record being imported. Transcribed — see the docblock. */
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
  collapsedSources: [
    {
      sourceType: "macos",
      sourceRecordId: "AB-RECORD-4417",
      externalUuid: "3c9a1b7e-52d4-4f60-b8a1-9d7e2f0c4a55",
    },
  ],
} as unknown as Contact;

/**
 * A SECOND address-book record, imported by nobody.
 *
 * It is in the list before and after, so it is the row whose DOM node identity
 * proves the list was reconciled in place rather than rebuilt.
 */
const persistingRecord = {
  ...(externalAddressBookRecord as unknown as Record<string, unknown>),
  id: PERSISTING_ROW_ID,
  name: "Rea Vandal",
  email: "rea.vandal@example.test",
  allEmails: ["rea.vandal@example.test"],
  phone: "+15550142",
  allPhones: ["+15550142"],
  externalRecordId: "AB-RECORD-9902",
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

/**
 * What `contacts:import` hands back, and what `contacts:get-all` holds, are NOT
 * the same shape — and the difference is the point of the failure-path tests.
 *
 * `Contacts.tsx` says so in its own comment: the handler builds its return value
 * from the contact row, and `Contact` has no `allEmails`/`allPhones` at all, so
 * it carries ONE email and ONE phone however many the record had. The list query
 * carries all of them. So a card showing the second address can only have come
 * from the fetched row, and a card showing one address can only have come from
 * the handler's return value. That is what makes `refreshAfterImport`'s return
 * contract observable instead of a matter of opinion.
 */
const savedTamFullyLoaded = {
  ...(savedTam as unknown as Record<string, unknown>),
  allEmails: ["tam.wexford@example.test", "tam.wexford@wexford.example.test"],
  allPhones: ["+12025550187", "+12025550143"],
} as unknown as Contact;

/** Every row the list is currently rendering, as ids. IDENTITY, never a count. */
function renderedContactIds(): string[] {
  return screen
    .queryAllByTestId("contact-row")
    .map((row) => row.getAttribute("data-contact-id") ?? "")
    .sort();
}

const PRE_IMPORT_ROWS = [EXTERNAL_ROW_ID, PERSISTING_ROW_ID].sort();
const POST_IMPORT_ROWS = [SAVED_CONTACT_ID, PERSISTING_ROW_ID].sort();

/**
 * Import the record the way the founder did.
 *
 * Through the DETAIL CARD, not a row button. On Clients & Contacts `compact` is
 * true, and that suppresses the row-level Import control
 * (`ContactSearchList.tsx` -> `ContactRow.tsx`). A test driving a row button
 * would be driving a control this screen does not show.
 */
async function importViaDetailCard() {
  await userEvent.click(screen.getByText("Tam Wexford"));
  await userEvent.click(await screen.findByRole("button", { name: /^import$/i }));
  await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
}

/**
 * The harness: the saved list gains the contact, the address book stops offering
 * the record it was made from — and the address book's SECOND answer is held
 * open until the test releases it, which is the only window where a single
 * commit and two commits look different.
 */
function installHeldOpenBackend(options?: {
  savedAfterImport?: Contact[] | "fail";
  availableAfterImport?: Contact[] | "fail";
  importReturns?: Contact;
}) {
  const savedAfter = options?.savedAfterImport ?? [savedTam];
  const availableAfter = options?.availableAfterImport ?? [persistingRecord];

  let releaseRefetch!: () => void;
  const refetchInFlight = new Promise<void>((resolve) => {
    releaseRefetch = resolve;
  });

  let getAllCalls = 0;
  jest.mocked(window.api.contacts.getAll).mockImplementation(async () => {
    getAllCalls += 1;
    if (getAllCalls === 1) return { success: true, contacts: [] };
    if (savedAfter === "fail") return { success: false, error: "database is locked" };
    return { success: true, contacts: savedAfter };
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
    // Held open. The assertions that matter run while this is pending.
    await refetchInFlight;
    if (availableAfter === "fail") return { success: false, error: "address book unavailable" };
    return { success: true, contacts: availableAfter };
  });

  jest
    .mocked(window.api.contacts.import)
    .mockResolvedValue({ success: true, contacts: [options?.importReturns ?? savedTam] });
  jest
    .mocked(window.api.contacts.checkCanDelete)
    .mockResolvedValue({ success: true, transactions: [] });

  return {
    release: async () => {
      await act(async () => {
        releaseRefetch();
        await refetchInFlight;
      });
    },
  };
}

/**
 * The frames in which the same person was on screen twice — the saved contact
 * and the address-book record it was created from, held at once.
 */
function framesShowingBothRows(): Array<{ contacts: string[]; external: string[] }> {
  return mockListRenders.filter(
    (frame) =>
      frame.contacts.includes(SAVED_CONTACT_ID) && frame.external.includes(EXTERNAL_ROW_ID),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListRenders.length = 0;
  installMatchMedia(false);
});

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("BACKLOG-2526 — the import commits both lists as one render", () => {
  it("holds the pre-import list until BOTH refreshes have landed", async () => {
    const backend = installHeldOpenBackend();

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

    await importViaDetailCard();
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));

    // ---- THE ADDRESS-BOOK REFETCH IS IN FLIGHT. The only window that differs.
    //
    // `contacts:getAll` has already answered by now. Commit it on its own and
    // the saved contact appears BESIDE the address-book row it was made from —
    // the same person, twice, which is what the founder saw. This single line is
    // the SR probe; see the docblock for the red it produced on unmodified code.
    expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS);

    await backend.release();

    await waitFor(() => expect(renderedContactIds()).toEqual(POST_IMPORT_ROWS));

    // …and no frame in between held both. The DOM check above proves nothing
    // committed EARLY; this proves nothing committed BETWEEN the two setters
    // either, which `act()` would otherwise hide. Reported as the frames
    // themselves, so a failure says which lists were held together.
    expect(framesShowingBothRows()).toEqual([]);
  });

  it("never paints the Added pill on the row that is about to disappear", async () => {
    const backend = installHeldOpenBackend();

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

    await importViaDetailCard();
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));

    // The pill said "you just added this" while sitting on the address-book row
    // — the one row that was about to vanish. It is keyed on the EXTERNAL id, so
    // it could never have landed on the saved contact.
    expect(screen.queryByTestId("contact-row-added-indicator")).not.toBeInTheDocument();

    await backend.release();
    await waitFor(() => expect(renderedContactIds()).toEqual(POST_IMPORT_ROWS));

    // And it is not on the far side either: by then the main process no longer
    // offers that record, so the id it marks is not on screen at all.
    expect(screen.queryByTestId("contact-row-added-indicator")).not.toBeInTheDocument();
  });

  it("reconciles the list in place, so the user keeps their place", async () => {
    /**
     * BACKLOG-2459/2511 regression witness, re-run against the new code path.
     *
     * jsdom performs no layout, so `scrollTop` cannot be set to a non-zero value
     * on an element it considers unscrollable — a scroll assertion here would
     * pass on 0 === 0 whatever the implementation did. What distinguishes the
     * two outcomes is DOM NODE IDENTITY: React reconciling rows in place keeps
     * the same node, and any unmount/remount — a spinner included — produces a
     * new one. Rebuilding the list is what "loses your place" means here.
     */
    const backend = installHeldOpenBackend();

    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
    await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

    const rowBefore = document.querySelector(`[data-contact-id="${PERSISTING_ROW_ID}"]`);
    expect(rowBefore).not.toBeNull();

    await importViaDetailCard();
    await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));

    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(document.querySelector(`[data-contact-id="${PERSISTING_ROW_ID}"]`)).toBe(rowBefore);

    await backend.release();
    await waitFor(() => expect(renderedContactIds()).toEqual(POST_IMPORT_ROWS));

    // Not "a row is still there" — a rebuilt list also has a row there. The SAME
    // NODE, so the scroll container never lost its contents.
    expect(document.querySelector(`[data-contact-id="${PERSISTING_ROW_ID}"]`)).toBe(rowBefore);
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
  });

  describe("when one of the two refreshes fails", () => {
    /**
     * ALL-OR-NOTHING, and the reason is that the third option is worse than the
     * defect. Committing the address book alone removes the row while the saved
     * contact is still absent from `contacts` — the person is then in NEITHER
     * list, gone from the screen entirely. Committing the saved list alone IS
     * the defect. The pre-import state is stale but consistent, it self-heals on
     * the next load, and a second Import press is folded by the crosswalk guard
     * in `contacts:import` (BACKLOG-2525), so the retry is safe.
     */
    it("keeps the pre-import list when the address book fails", async () => {
      const backend = installHeldOpenBackend({ availableAfterImport: "fail" });

      render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
      await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

      await importViaDetailCard();
      await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
      await backend.release();

      // The saved contact was fetched successfully and is deliberately NOT
      // committed: with no fresh address book, showing it would show the person
      // twice, which is this item's whole subject.
      await waitFor(() => expect(window.api.contacts.import).toHaveBeenCalled());
      expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS);
    });

    it("keeps the pre-import list when the saved-contact read fails", async () => {
      const backend = installHeldOpenBackend({ savedAfterImport: "fail" });

      render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
      await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

      await importViaDetailCard();
      await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
      await backend.release();

      // The address book came back and no longer offers the record. Committing
      // that alone would drop the row while the saved contact is missing — the
      // person in neither list.
      expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS);
    });

    it("still lands the card on the fetched row when the address book fails", async () => {
      /**
       * The commit rule governs the LIST. The return value governs the CARD, and
       * it does not follow the commit rule: the saved rows are returned whenever
       * they were fetched, committed or not.
       *
       * Withholding a row that WAS fetched, because a different fetch failed,
       * would drop the card onto the handler's return value — one email, one
       * phone, however many the record had. That is the BACKLOG-2459 complaint
       * reproduced on the failure path, for no gain.
       */
      const backend = installHeldOpenBackend({
        savedAfterImport: [savedTamFullyLoaded],
        availableAfterImport: "fail",
        importReturns: savedTam, // the thin shape, as the real handler returns
      });

      render(<Contacts userId={USER_ID} onClose={jest.fn()} />);
      await waitFor(() => expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS));

      await importViaDetailCard();
      await waitFor(() => expect(window.api.contacts.getAvailable).toHaveBeenCalledTimes(2));
      await backend.release();

      // The second address exists ONLY on the fetched row. Its presence is the
      // assertion: the card is showing what the database holds, not the thinner
      // object the import handler returned.
      const emails = await screen.findByTestId("contact-preview-emails");
      await waitFor(() =>
        expect(within(emails).getByText("tam.wexford@wexford.example.test")).toBeInTheDocument(),
      );

      // …while the list is still where it was, because nothing was committed.
      expect(renderedContactIds()).toEqual(PRE_IMPORT_ROWS);
    });
  });
});
