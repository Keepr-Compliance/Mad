/**
 * BACKLOG-2491 — a contact reachable ONLY through the main-process search must
 * survive Confirm.
 *
 * ## The failure this pins
 *
 * The user searches for someone who is not among the ~200 rows the `contacts`
 * prop carries, clicks them, and the picker agrees: a chip appears in the Added
 * pane and the header reads "1 selected". Confirm fires `onSelect([])`. Nobody is
 * attached to the transaction, and nothing says so. This is the screen where a
 * party is attached to a deal under audit.
 *
 * `handleConfirm` resolved `selectedIds` against the `contacts` PROP alone, so a
 * row that exists only in `searchResults` filtered straight out.
 *
 * ## Why this file exists instead of a block in ContactSelectModal.test.tsx
 *
 * `jest.config.js:145` puts `ContactSelectModal.test.tsx` in
 * `testPathIgnorePatterns` for CI ("Hangs in CI during loading") — that is
 * BACKLOG-2489, which is not this change. A regression test added to that file
 * would pass locally and never run in CI, which for a silent-data-loss defect is
 * the worst of both. This basename does not match that ignore pattern, so it runs
 * in CI.
 *
 * ## The fixtures are transcribed, not invented
 *
 * `DB_ONLY_*` rows use the EXACT 14-column projection of the imported half of
 * `searchContactsForSelection` (electron/services/db/contactDbService.ts:2113-2130):
 *
 *     c.id, c.user_id, c.display_name, c.display_name as name,
 *     ce_primary.email as email, cp_primary.phone_e164 as phone, c.company,
 *     c.title, c.source, c.is_imported, 0 as is_message_derived,
 *     MAX(e.sent_at) as last_communication_at,
 *     COUNT(DISTINCT comm.id) as communication_count, 0 as address_mention_count
 *
 * Note what is ABSENT: `allEmails` / `allPhones`. The prop's producer
 * (`getImportedContactsByUserId`, contactDbService.ts:520-559) projects `c.*` and
 * both arrays. The two sources do NOT carry the same shape, which is why the
 * overlap case below asserts WHICH of the two rows comes back.
 *
 * `contactHandlers.ts:2823-2837` returns these rows to the renderer untransformed,
 * so what the SQL projects is literally what `searchResults` holds.
 *
 * ## Assertions are exact identity, never counts
 *
 * A count assertion passes when the right NUMBER of the WRONG rows comes back,
 * which is precisely this bug's shape. Every case asserts the id SET of the
 * `onSelect` payload, and the overlap case asserts object REFERENCE — the
 * sharpest identity available, and the only assertion that can tell the prop row
 * from the search row for one and the same contact id.
 *
 * ## Why no canary row is needed here
 *
 * Sibling tests in ContactSelectModal.test.tsx carry a `db-canary` because a bare
 * `waitFor` can be satisfied by the FIRST render, before the debounced search has
 * landed. These cases cannot: each one CLICKS `add-contact-<db-only-id>`, a test
 * id that does not exist until the search result is applied. The click is the
 * forcing function.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactSelectModal from "../ContactSelectModal";
import type { ExtendedContact } from "../../types/components";

const contactsApi = () =>
  (window as unknown as { api: { contacts: Record<string, unknown> } }).api
    .contacts;

/**
 * The prop's shape: `getImportedContactsByUserId` (contactDbService.ts:520-559)
 * projects `c.*` plus `name`, `email`, `phone` and the `allEmails` / `allPhones`
 * arrays. `created_at` / `updated_at` are on the base model but are never read by
 * the picker, so they are omitted rather than invented — the convention this
 * component's existing suite already uses.
 */
const PROP_PRIYA = {
  id: "prop-priya",
  user_id: "user-1",
  display_name: "Priya Raman",
  name: "Priya Raman",
  email: "priya@example.com",
  phone: "+12125550101",
  allEmails: ["priya@example.com", "p.raman@example.test"],
  allPhones: ["+12125550101", "+12125550102"],
  company: "Raman Realty",
  source: "contacts_app",
  is_imported: 1,
  is_message_derived: 0,
} as unknown as ExtendedContact;

const PROP_TOMAS = {
  id: "prop-tomas",
  user_id: "user-1",
  display_name: "Tomas Vega",
  name: "Tomas Vega",
  email: "tomas@example.com",
  phone: "+12125550103",
  allEmails: ["tomas@example.com"],
  allPhones: ["+12125550103"],
  company: "Vega Title",
  source: "contacts_app",
  is_imported: 1,
  is_message_derived: 0,
} as unknown as ExtendedContact;

const PROP_CONTACTS = [PROP_PRIYA, PROP_TOMAS];

/**
 * The search's shape — the imported half's 14 columns, in projection order.
 * This contact is beyond the ~200 rows the prop carries: the entire reason the
 * main-process search exists, and the row the founder cannot otherwise reach.
 */
const DB_ONLY_NADIA = {
  id: "db-only-nadia",
  user_id: "user-1",
  display_name: "Nadia Okonkwo",
  name: "Nadia Okonkwo",
  email: "nadia@example.com",
  phone: "+13035550142",
  company: "Okonkwo Escrow",
  title: "Escrow Officer",
  source: "contacts_app",
  is_imported: 1,
  is_message_derived: 0,
  last_communication_at: "2026-05-11T14:02:00Z",
  communication_count: 6,
  address_mention_count: 0,
} as unknown as ExtendedContact;

const DB_ONLY_WENDELL = {
  id: "db-only-wendell",
  user_id: "user-1",
  display_name: "Wendell Marsh",
  name: "Wendell Marsh",
  email: "wendell@example.com",
  phone: "+13035550177",
  company: "Marsh Inspections",
  title: null,
  source: "outlook",
  is_imported: 1,
  is_message_derived: 0,
  last_communication_at: null,
  communication_count: 0,
  address_mention_count: 0,
} as unknown as ExtendedContact;

/**
 * The SAME contact as PROP_PRIYA, as the search half projects her: her real
 * `contacts.id` (contactDbService.ts:2115 selects `c.id`), her PRIMARY email and
 * PRIMARY phone only, and no `allEmails` / `allPhones`. Both halves of the union
 * therefore claim id `prop-priya`, and the payload has to say which row wins.
 */
const SEARCH_PRIYA_PRIMARY_ONLY = {
  id: "prop-priya",
  user_id: "user-1",
  display_name: "Priya Raman",
  name: "Priya Raman",
  email: "priya@example.com",
  phone: "+12125550101",
  company: "Raman Realty",
  title: null,
  source: "contacts_app",
  is_imported: 1,
  is_message_derived: 0,
  last_communication_at: "2026-04-02T09:15:00Z",
  communication_count: 3,
  address_mention_count: 0,
} as unknown as ExtendedContact;

describe("ContactSelectModal — confirming a search-only contact (BACKLOG-2491)", () => {
  const mockOnSelect = jest.fn();
  const mockOnClose = jest.fn();

  let previousSearchContacts: unknown;

  beforeEach(() => {
    jest.clearAllMocks();
    previousSearchContacts = contactsApi().searchContacts;
  });

  afterEach(() => {
    contactsApi().searchContacts = previousSearchContacts;
    // The "Include message contacts" toggle persists to localStorage and is read
    // at mount, so leaving it set would silently change a later test's render.
    localStorage.removeItem("contactModal.showMessageContacts");
  });

  const mockSearch = (contacts: ExtendedContact[]) => {
    const searchContacts = jest
      .fn()
      .mockResolvedValue({ success: true, contacts });
    contactsApi().searchContacts = searchContacts;
    return searchContacts;
  };

  const typeQuery = (value: string) => {
    fireEvent.change(screen.getByPlaceholderText(/search contacts/i), {
      target: { value },
    });
  };

  /** ids the Added pane is currently rendering, in render order. */
  const addedIds = (): string[] =>
    screen
      .queryAllByTestId(/^added-contact-/)
      .map((el) =>
        (el.getAttribute("data-testid") as string).replace(
          "added-contact-",
          "",
        ),
      );

  /** The exact rows handed to `onSelect`, from its single call. */
  const payload = (): ExtendedContact[] => {
    expect(mockOnSelect).toHaveBeenCalledTimes(1);
    return mockOnSelect.mock.calls[0][0] as ExtendedContact[];
  };

  const payloadIds = (): string[] => payload().map((c) => c.id);

  const renderPicker = (props: Record<string, unknown> = {}) =>
    render(
      <ContactSelectModal
        contacts={PROP_CONTACTS}
        onSelect={mockOnSelect}
        onClose={mockOnClose}
        userId="user-1"
        {...props}
      />,
    );

  const confirm = () =>
    fireEvent.click(screen.getByTestId("confirm-add-button"));

  // -------------------------------------------------------------------------
  // The founder's exact sequence: search for someone not on screen, click them,
  // press Add. Single-select, because that is what most transaction roles use.
  // -------------------------------------------------------------------------
  it("hands back the search-only contact it showed as selected (single-select)", async () => {
    const searchContacts = mockSearch([DB_ONLY_NADIA]);
    renderPicker();

    typeQuery("Nadia");
    await waitFor(() => {
      expect(searchContacts).toHaveBeenCalledWith("user-1", "Nadia");
    });

    // Only reachable once the search result has been applied — this click is
    // what forces the assertions below to observe the post-search state.
    const row = await screen.findByTestId("add-contact-db-only-nadia");
    fireEvent.click(row);

    // The picker agrees she is selected.
    expect(addedIds()).toEqual(["db-only-nadia"]);
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    confirm();

    // ...and so must the payload. Exact set: not a count, not "contains Nadia".
    expect(payloadIds()).toEqual(["db-only-nadia"]);
    // Sharpest identity available: it is the search row itself, not a lookalike.
    expect(payload()[0]).toBe(DB_ONLY_NADIA);
  });

  // -------------------------------------------------------------------------
  // A prop contact and a search-only contact selected together. The prop half
  // works today; the point is that it KEEPS working while the other half starts.
  // -------------------------------------------------------------------------
  it("hands back both a prop contact and a search-only contact, in selection order", async () => {
    const searchContacts = mockSearch([DB_ONLY_NADIA, DB_ONLY_WENDELL]);
    renderPicker({ multiple: true });

    // A prop row, selected before any search runs.
    fireEvent.click(screen.getByTestId("add-contact-prop-tomas"));
    expect(addedIds()).toEqual(["prop-tomas"]);

    typeQuery("Marsh");
    await waitFor(() => {
      expect(searchContacts).toHaveBeenCalledWith("user-1", "Marsh");
    });

    const row = await screen.findByTestId("add-contact-db-only-wendell");
    fireEvent.click(row);

    expect(addedIds()).toEqual(["prop-tomas", "db-only-wendell"]);

    confirm();

    // Selection order, exactly these two, and NOT the other search hit
    // (db-only-nadia) that was on screen but never clicked.
    expect(payloadIds()).toEqual(["prop-tomas", "db-only-wendell"]);
    expect(payload()[0]).toBe(PROP_TOMAS);
    expect(payload()[1]).toBe(DB_ONLY_WENDELL);
  });

  // -------------------------------------------------------------------------
  // Trap 2, pinned. The same contact arrives on BOTH paths under the same id but
  // in two DIFFERENT shapes. The prop row carries allEmails / allPhones; the
  // search row carries the primary scalars only. Resolving from the search row
  // would silently thin an existing payload — a regression the id set alone
  // cannot see, because both rows have id "prop-priya".
  // -------------------------------------------------------------------------
  it("resolves a contact held on BOTH paths from the richer prop row", async () => {
    const searchContacts = mockSearch([
      SEARCH_PRIYA_PRIMARY_ONLY,
      DB_ONLY_NADIA,
    ]);
    renderPicker({ multiple: true });

    typeQuery("Priya");
    await waitFor(() => {
      expect(searchContacts).toHaveBeenCalledWith("user-1", "Priya");
    });

    // Wait for the search to land before clicking: db-only-nadia exists in no
    // prop row, so its presence proves `searchResults` has been applied and the
    // union — not the pre-search local list — is what is on screen.
    await screen.findByTestId("add-contact-db-only-nadia");

    // Priya appears ONCE despite arriving twice (assembleContacts de-overlaps on
    // id). Asserting that here keeps this case honest about what it clicks.
    expect(screen.queryAllByTestId("add-contact-prop-priya")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("add-contact-prop-priya"));

    confirm();

    expect(payloadIds()).toEqual(["prop-priya"]);
    // The PROP object, by reference — not the primary-only search projection.
    expect(payload()[0]).toBe(PROP_PRIYA);
    expect(payload()[0].allEmails).toEqual([
      "priya@example.com",
      "p.raman@example.test",
    ]);
    expect(payload()[0].allPhones).toEqual(["+12125550101", "+12125550102"]);
  });

  // -------------------------------------------------------------------------
  // The same silent drop, one step later, and the reason the fix cannot just
  // read `searchResults` live.
  //
  // `searchResults` is TRANSIENT: the next query replaces it wholesale, and a
  // query under 2 characters resets it to null. Attaching two parties to a deal
  // means searching twice, so by the time Confirm is pressed the array that
  // surfaced the FIRST person is already gone. A selection resolved against it
  // evaporates with it.
  //
  // ## Why this waits on a second search and not on an emptied box
  //
  // The first version of this case cleared the box and waited for the prop rows
  // to return. That wait proved nothing: with an empty query `filteredContacts`
  // takes its `!query` branch and re-renders the prop rows SYNCHRONOUSLY, ~300ms
  // before the debounce actually resets `searchResults`. The assertion ran while
  // the old results were still live, so it passed against the broken component —
  // a green check carrying no information. `add-contact-db-only-wendell` cannot
  // exist until the SECOND search result has replaced the first, which makes the
  // wait a real forcing signal. The second result set deliberately does NOT
  // contain Nadia.
  // -------------------------------------------------------------------------
  it("keeps an earlier search-only selection when a later search replaces the results", async () => {
    const searchContacts = jest
      .fn()
      .mockResolvedValueOnce({ success: true, contacts: [DB_ONLY_NADIA] })
      .mockResolvedValueOnce({ success: true, contacts: [DB_ONLY_WENDELL] });
    contactsApi().searchContacts = searchContacts;

    renderPicker({ multiple: true });

    typeQuery("Nadia");
    await waitFor(() => {
      expect(searchContacts).toHaveBeenCalledWith("user-1", "Nadia");
    });
    fireEvent.click(await screen.findByTestId("add-contact-db-only-nadia"));
    expect(addedIds()).toEqual(["db-only-nadia"]);

    // Second party, second search. Nadia is absent from this result set.
    typeQuery("Marsh");
    await waitFor(() => {
      expect(searchContacts).toHaveBeenCalledWith("user-1", "Marsh");
    });
    // Only renderable once `searchResults` has been REPLACED.
    fireEvent.click(await screen.findByTestId("add-contact-db-only-wendell"));

    // Nadia is still selected, so her chip must still be there — the header
    // count and the Added pane must not disagree about who is coming along.
    expect(addedIds()).toEqual(["db-only-nadia", "db-only-wendell"]);
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    confirm();

    expect(payloadIds()).toEqual(["db-only-nadia", "db-only-wendell"]);
    expect(payload()[0]).toBe(DB_ONLY_NADIA);
    expect(payload()[1]).toBe(DB_ONLY_WENDELL);
  });

  // -------------------------------------------------------------------------
  // The header count and the Confirm button read the RESOLVED rows, not the raw
  // id list. Without that, the two can disagree and the disagreement is always in
  // the dangerous direction: the screen claims a person Confirm will not deliver.
  //
  // The reachable way in is the `contacts` prop changing under a live selection.
  // Both call sites pass `onRefreshContacts`, and the picker re-renders with a
  // fresh prop array after an import — a contact selected before the refresh and
  // absent after it leaves an id in `selectedIds` that resolves to nothing.
  //
  // Counting ids there would leave "1 selected" in the header and Confirm live,
  // firing `onSelect([])`: BACKLOG-2491's exact symptom by a second route.
  // -------------------------------------------------------------------------
  it("stops claiming a selected contact once the list no longer holds them", async () => {
    mockSearch([]);
    const { rerender } = renderPicker({ multiple: true });

    fireEvent.click(screen.getByTestId("add-contact-prop-priya"));
    expect(addedIds()).toEqual(["prop-priya"]);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-add-button")).toBeEnabled();

    // The refresh that no longer carries her.
    rerender(
      <ContactSelectModal
        contacts={[PROP_TOMAS]}
        onSelect={mockOnSelect}
        onClose={mockOnClose}
        userId="user-1"
        multiple
      />,
    );

    expect(addedIds()).toEqual([]);
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    // The only honest state: nothing is being carried, so there is nothing to add.
    expect(screen.getByTestId("confirm-add-button")).toBeDisabled();

    confirm();
    expect(mockOnSelect).not.toHaveBeenCalled();
  });
});
