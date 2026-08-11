/**
 * THE DROPDOWN'S COUNTS ARE THE NUMBERS THE FILTER PRODUCES — BACKLOG-2671
 *
 * ===========================================================================
 * THE FOUNDER'S SECOND REQUIREMENT, VERBATIM
 * ===========================================================================
 *   > The counts in the dropdown are the same numbers the filter produces. If
 *   > selecting Outlook shows a list whose length is not 5, the dropdown is
 *   > lying — assert the count against the filtered result set by exact ID set,
 *   > not by re-running the same query twice.
 *
 * So every assertion below has THREE legs, and they come from three different
 * places on purpose:
 *
 *   1. `dropdownCount` — read off the RENDERED dropdown row. What the user sees.
 *   2. `renderedIds`   — the ids of the rows the list RENDERS once that option
 *                        is the only one ticked. What the user gets.
 *   3. `expectedIds`   — derived by EXECUTING `matchesSourceFilter` against the
 *                        fixture, independently of both.
 *
 * Leg 1 against leg 2 is the founder's test: the promise against the delivery,
 * both measured out of the DOM. Leg 3 is what stops a matching pair of wrong
 * answers passing — equal counts prove nothing if both sides picked the wrong
 * rows, which is why the comparison is on the ID SET and not on `.length`.
 *
 * ===========================================================================
 * WHAT DRIVES WHAT — SO NOBODY READS THIS AS A PROBE OVER A FIXTURE
 * ===========================================================================
 * The real `ContactSearchList` runs: the real `assembleFilterSearch`, the real
 * frozen-order projection, the real `GroupedMultiSelect`, and the real count
 * computation. The clicks go through the actual checkboxes.
 *
 * `ContactRow` IS mocked, and only to give each row an id-bearing test id — the
 * real one renders `data-testid="contact-row"` for every row, which cannot
 * express an ID SET. The mock changes what a row LOOKS like, never WHICH rows
 * are rendered; that decision is made upstream in the component under test and
 * is untouched.
 *
 * The `contacts` / `externalContacts` props are the same two halves
 * `Contacts.tsx` passes from `useContactList`. External rows carry
 * `is_message_derived: true`, because `useContactDirectory.fetchExternalContacts`
 * stamps that onto EVERY `contacts:get-available` row — a fixture without the
 * overlay describes a payload the renderer never receives.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactSearchList } from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";
import {
  ALL_SOURCE_LEAF_IDS,
  SOURCE_LEAF,
  matchesSourceFilter,
} from "../../utils/contactFilterModel";
import {
  ALL_CONTACT_SOURCE_VALUES,
  MESSAGE_DERIVED_ONLY_SOURCES,
} from "../../../electron/utils/contactSourceVocabulary";

// Rows carry their contact id so an ID SET can be read out of the DOM. Nothing
// about WHICH rows render is affected — see the file docblock.
jest.mock("./ContactRow", () => ({
  BADGE_LABELS: { autolinked: "Autolinked", user_linked: "You linked these" },
  ContactRow: ({ contact }: { contact: { id: string } }) => (
    <div data-testid={`row-${contact.id}`} data-contact-id={contact.id} />
  ),
}));

// ---------------------------------------------------------------------------
// Fixture — one contact per source value the app can emit, derived by execution
// ---------------------------------------------------------------------------

/**
 * The message-derived half arrives through `contacts:get-all`
 * (`[...importedRows, ...messageDerivedAsContacts(userId)]`), so it sits in
 * `contacts`. Everything with an address book behind it arrives through
 * `contacts:get-available` and sits in `externalContacts`.
 *
 * The split is by source value rather than by hand, so a source added to the
 * vocabulary lands on the correct half without this file being edited.
 */
const isDerivedSource = (source: string): boolean =>
  MESSAGE_DERIVED_ONLY_SOURCES.includes(source);

const rowForSource = (source: string): ExtendedContact =>
  ({
    id: `c-${source}`,
    name: `Person ${source}`,
    display_name: `Person ${source}`,
    email: `${source}@example.com`,
    user_id: "user-1",
    source,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    // The Inferred leaves gate on this flag, so the derived sources MUST carry
    // it or those two leaves count 0 and their assertions pass vacuously.
    // External rows carry it too, because the real read path stamps it on all
    // of them — harmless for the address-book leaves, which read `source_types`
    // / `source` and never the flag.
    is_message_derived: true,
  }) as ExtendedContact;

const derivedHalf = (): ExtendedContact[] =>
  ALL_CONTACT_SOURCE_VALUES.filter(isDerivedSource).map(rowForSource);

/**
 * Linked to BOTH the Mac address book and Outlook. `source_types` is transcribed
 * from `attachLiveSources` (`electron/services/db/contactSourceSets.ts`), which
 * maps crosswalk rows through `toPersistedContactSource` and returns them
 * SORTED. This row is why the counts cannot be a label-keyed partition: ticking
 * either leaf shows it, so both leaves must count it.
 */
const inTwoAddressBooks = (): ExtendedContact =>
  ({
    id: "c-two-books",
    name: "Dual Sourced",
    display_name: "Dual Sourced",
    email: "dual@example.com",
    user_id: "user-1",
    source: "contacts_app",
    source_types: ["contacts_app", "outlook"],
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    is_message_derived: true,
  }) as ExtendedContact;

const addressBookHalf = (): ExtendedContact[] => [
  ...ALL_CONTACT_SOURCE_VALUES.filter((s) => !isDerivedSource(s)).map(rowForSource),
  inTwoAddressBooks(),
];

const everyRow = (): ExtendedContact[] => [...derivedHalf(), ...addressBookHalf()];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const renderList = () =>
  render(
    <ContactSearchList
      contacts={derivedHalf()}
      externalContacts={addressBookHalf()}
      selectedIds={[]}
      onSelectionChange={jest.fn()}
      // Ephemeral seeds a TRUE select-all (`trueSelectAll`), so the panel opens
      // with every source ticked — the state the counts are read from, and the
      // one the select-all row starts CHECKED in.
      filterMode="ephemeral"
    />,
  );

/** The ids of the rows the list is currently rendering. A SET, not a count. */
const renderedIds = (): string[] =>
  screen
    .queryAllByTestId(/^row-/)
    .map((el) => el.getAttribute("data-contact-id") as string)
    .sort();

/** The number shown beside one option in the open source panel. */
const dropdownCount = (optionId: string): number =>
  Number(screen.getByTestId(`source-filter-count-${optionId}`).textContent);

/** The ids `matchesSourceFilter` admits for this selection — leg 3, independent. */
const idsMatching = (leafId: string): string[] =>
  everyRow()
    .filter((row) => matchesSourceFilter(row, new Set([leafId])))
    .map((row) => row.id)
    .sort();

describe("BACKLOG-2671 — every source row's count is the list that row produces", () => {
  beforeEach(() => localStorage.clear());

  /**
   * THE SWEEP. Every leaf, derived from `ALL_SOURCE_LEAF_IDS` — the config the
   * panel renders — so a leaf added tomorrow is tested without this file being
   * touched. Sampling three of eight is what let the header ship a wrong number
   * for the fourth.
   */
  it.each(ALL_SOURCE_LEAF_IDS)(
    "%s: the count beside it equals the exact ID set selecting it produces",
    async (leafId) => {
      const user = userEvent.setup();
      renderList();

      await user.click(screen.getByTestId("source-filter-trigger"));
      const promised = dropdownCount(leafId);

      // Clear to none via the select-all row (it starts checked here), then tick
      // exactly this leaf. Driving the real controls, not setting state.
      await user.click(screen.getByTestId("source-filter-select-all-checkbox"));
      await user.click(screen.getByTestId(`source-filter-checkbox-${leafId}`));

      const delivered = renderedIds();
      const expected = idsMatching(leafId);

      // Leg 3 first: the RIGHT rows. A wrong-but-equal-length answer dies here.
      expect(delivered).toEqual(expected);
      // Leg 1 vs leg 2: the promise against the delivery.
      expect(promised).toBe(delivered.length);
      // And non-vacuous — `0 === 0` would satisfy both lines above.
      expect(delivered.length).toBeGreaterThan(0);
    },
  );

  it("Outlook counts the contact that is in TWO address books, and shows it", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByTestId("source-filter-trigger"));
    const promised = dropdownCount(SOURCE_LEAF.EMAIL_OUTLOOK);

    await user.click(screen.getByTestId("source-filter-select-all-checkbox"));
    await user.click(screen.getByTestId(`source-filter-checkbox-${SOURCE_LEAF.EMAIL_OUTLOOK}`));

    // The dual-source row's `source` scalar says `contacts_app`. It is here
    // because `liveSourcesOf` prefers its `source_types`. A count keyed on the
    // display label would have omitted it and read one lower than this list.
    expect(renderedIds()).toEqual(["c-outlook", "c-two-books"]);
    expect(promised).toBe(2);
  });

  it("the All sources row equals the rows shown with everything ticked", async () => {
    const user = userEvent.setup();
    renderList();

    // Ephemeral opens on a true select-all, so this IS the everything-ticked list.
    const withEverythingTicked = renderedIds();

    await user.click(screen.getByTestId("source-filter-trigger"));
    const promised = Number(
      screen.getByTestId("source-filter-select-all-count").textContent,
    );

    expect(promised).toBe(withEverythingTicked.length);
    expect(promised).toBe(everyRow().length);
  });

  /**
   * THE POPULATION TEST. The counts must move with the search box, because the
   * list does. BACKLOG-2662's header shipped exactly this defect in reverse: its
   * total was the rendered rows while its parts were the raw unfiltered payload,
   * so typing one letter produced `3 contacts (1171 from Contacts App)`.
   */
  it("counts narrow with the search box — they describe the list, not the payload", async () => {
    const user = userEvent.setup();
    renderList();

    // TYPED into the real search box, not passed as a prop. `searchQuery` is
    // only honoured as a controlled value when `onSearchQueryChange` is supplied
    // too (`isSearchControlled`), so a props-only version of this test would
    // have searched for nothing and asserted against an unfiltered list — which
    // is exactly how it first failed here.
    // `outlook@` appears in one row's email and nowhere else.
    await user.type(screen.getByTestId("contact-search-input"), "outlook@");

    await user.click(screen.getByTestId("source-filter-trigger"));
    const promised = dropdownCount(SOURCE_LEAF.EMAIL_OUTLOOK);

    await user.click(screen.getByTestId("source-filter-select-all-checkbox"));
    await user.click(screen.getByTestId(`source-filter-checkbox-${SOURCE_LEAF.EMAIL_OUTLOOK}`));

    // Two rows carry the Outlook leaf overall; the search leaves one.
    expect(idsMatching(SOURCE_LEAF.EMAIL_OUTLOOK)).toEqual(["c-outlook", "c-two-books"]);
    expect(renderedIds()).toEqual(["c-outlook"]);
    expect(promised).toBe(1);
  });

  /**
   * The counterpart: counts are of what EXISTS, not of what is CHOSEN. A number
   * that collapsed to 0 when its own box was unticked would erase the evidence
   * for ticking it again.
   */
  it("counts do NOT change when the source selection changes", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByTestId("source-filter-trigger"));
    const withEverythingTicked = ALL_SOURCE_LEAF_IDS.map(dropdownCount);

    await user.click(screen.getByTestId("source-filter-select-all-checkbox"));
    expect(renderedIds()).toEqual([]); // nothing selected -> nothing shown

    expect(ALL_SOURCE_LEAF_IDS.map(dropdownCount)).toEqual(withEverythingTicked);
  });

  it("clearing every source leaves the Show all escape hatch reachable", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(screen.getByTestId("source-filter-select-all-checkbox"));

    expect(renderedIds()).toEqual([]);
    // The user is not stranded: BACKLOG-2141's escape hatch still renders.
    expect(screen.getByTestId("show-all-filters")).toBeInTheDocument();
  });

  it("puts a count on every source option the panel renders, and none on Role", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByTestId("source-filter-trigger"));
    for (const leafId of ALL_SOURCE_LEAF_IDS) {
      expect(screen.getByTestId(`source-filter-count-${leafId}`)).toBeInTheDocument();
    }

    await user.click(screen.getByTestId("role-filter-trigger"));
    const rolePanel = screen.getByTestId("role-filter-panel");
    // Counts were asked for on Source. A number beside every role would be a
    // second answer to a question nobody asked.
    expect(within(rolePanel).queryByTestId(/^role-filter-count-/)).toBeNull();
    expect(screen.queryByTestId("role-filter-select-all-count")).toBeNull();
  });
});
