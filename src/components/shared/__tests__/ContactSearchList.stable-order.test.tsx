/**
 * ContactSearchList — Stable Visible Order (SVO) Invariant
 *
 * @see BACKLOG-1745 — Bug: New Transaction contact picker reorders on click
 *
 * Stable Visible Order Invariant (SR architect's design):
 * For any contact identity K rendered at visible position N in the picker at
 * time t, K must remain at position N at time t+1 UNLESS the transition was
 * caused by an explicit user list-change event (search text, category filter,
 * sort-order toggle, mount/unmount). Background data refreshes (silent refetch
 * after import, sync arrival, polling) MUST NOT change positions. New
 * identities appear at the tail. Removed identities vanish in place.
 *
 * These tests assert at the rendered-DOM level (not via mocked data shapes)
 * so they detect the actual user-visible behavior of the component.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { ContactSearchList } from "../ContactSearchList";
import type { ExtendedContact } from "../../../types/components";

// Mock ContactRow with a minimal renderer that preserves role="option"
// and exposes the contact name and id in the DOM so we can assert visual
// order. We intentionally do NOT mock the sort/order logic — we want the
// real ContactSearchList memo behavior under test.
jest.mock("../ContactRow", () => ({
  ContactRow: ({
    contact,
    isSelected,
  }: {
    contact: ExtendedContact;
    isSelected?: boolean;
    [key: string]: unknown;
  }) => (
    <div
      role="option"
      aria-selected={isSelected ? "true" : "false"}
      data-testid={`row-${contact.id}`}
      data-contact-id={contact.id}
    >
      <span data-testid="row-name">{contact.display_name || contact.name}</span>
    </div>
  ),
}));

// --- Factories -----------------------------------------------------------

let idSeq = 0;
const uid = (prefix: string) => `${prefix}-${++idSeq}`;

const makeImported = (
  name: string,
  lastComm: string | null,
  overrides: Partial<ExtendedContact> = {},
): ExtendedContact => ({
  id: uid("imp"),
  name,
  display_name: name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  phone: null,
  company: null,
  user_id: "user-1",
  source: "email",
  last_communication_at: lastComm,
  is_message_derived: false,
  ...overrides,
});

const makeExternal = (
  name: string,
  lastComm: string | null,
  overrides: Partial<ExtendedContact> = {},
): ExtendedContact => ({
  id: uid("ext"),
  name,
  display_name: name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@external.com`,
  phone: null,
  company: null,
  user_id: "user-1",
  source: "inferred",
  last_communication_at: lastComm,
  is_message_derived: true,
  ...overrides,
});

// Get visible name order from the rendered DOM
const visibleOrder = (): string[] =>
  screen.getAllByRole("option").map((el) => el.textContent || "");

// --- Tests ---------------------------------------------------------------

describe("ContactSearchList — Stable Visible Order Invariant (BACKLOG-1745)", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  /**
   * Scenario 1: Silent data refresh must not reorder existing rows.
   *
   * Initial render: 10 contacts in a known order (mix of imported + external).
   * Re-render: same identities, but ONE row's underlying data changes
   * (specifically: last_communication_at gets a newer value, which would
   * normally cause it to bubble to the top under the recency sort).
   *
   * Expected: DOM order is unchanged. The changed row stays in its original
   * position. This is the "silent refresh" case — no user-initiated list
   * change happened, so visible positions must be sticky.
   */
  it("does not reorder when contact data changes silently (no sort-key change)", () => {
    // Build 10 contacts with known timestamps, descending — so initial sort
    // is alphabetical-ish: A, B, C, ... J by recency.
    const base = [
      makeImported("A Alpha", "2026-06-01T10:00:00Z"),
      makeImported("B Bravo", "2026-05-31T10:00:00Z"),
      makeExternal("C Charlie", "2026-05-30T10:00:00Z"),
      makeImported("D Delta", "2026-05-29T10:00:00Z"),
      makeExternal("E Echo", "2026-05-28T10:00:00Z"),
      makeImported("F Foxtrot", "2026-05-27T10:00:00Z"),
      makeExternal("G Golf", "2026-05-26T10:00:00Z"),
      makeImported("H Hotel", "2026-05-25T10:00:00Z"),
      makeExternal("I India", "2026-05-24T10:00:00Z"),
      makeImported("J Juliet", "2026-05-23T10:00:00Z"),
    ];

    const imported = base.filter((c) => !c.is_message_derived);
    const external = base.filter((c) => c.is_message_derived);

    const { rerender } = render(
      <ContactSearchList
        contacts={imported}
        externalContacts={external}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );

    const initialOrder = visibleOrder();
    expect(initialOrder).toEqual([
      "A Alpha",
      "B Bravo",
      "C Charlie",
      "D Delta",
      "E Echo",
      "F Foxtrot",
      "G Golf",
      "H Hotel",
      "I India",
      "J Juliet",
    ]);

    // Silent refresh: simulate the data layer updating G Golf's timestamp to
    // the newest (which under pure recency sort would jump it to position 0).
    // Same id, same identity — just newer timestamp.
    const refreshedImported = imported.map((c) => ({ ...c }));
    const refreshedExternal = external.map((c) =>
      c.name === "G Golf" ? { ...c, last_communication_at: "2026-06-02T10:00:00Z" } : { ...c },
    );

    rerender(
      <ContactSearchList
        contacts={refreshedImported}
        externalContacts={refreshedExternal}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );

    // SVO: visible order unchanged. G Golf stays at index 6, NOT at index 0.
    expect(visibleOrder()).toEqual(initialOrder);
  });

  /**
   * Scenario 2: Identity substitution (external → imported).
   *
   * This is the BACKLOG-1745 user-reported bug: clicking an external contact
   * triggers a silent refresh where the external entry is replaced with a
   * newly-imported entry (different UUID, same email/phone). The renderer
   * must recognize them as the same identity and keep the new row in the
   * old row's position.
   *
   * Initial: [A, ext_B, C, ext_D]
   * Click ext_B → it becomes imported with new UUID (B_imported).
   * Refresh sends: contacts = [A, B_imported, C], externalContacts = [ext_D]
   * Expected visible order: [A, B_imported, C, ext_D] — B stays at index 1.
   */
  it("substitutes a newly-imported contact in place of its external counterpart (same email)", () => {
    const A = makeImported("A Alpha", "2026-06-01T10:00:00Z");
    const extB = makeExternal("B Bravo", "2026-05-30T10:00:00Z", {
      email: "bravo@shared.com",
    });
    const C = makeImported("C Charlie", "2026-05-20T10:00:00Z");
    const extD = makeExternal("D Delta", "2026-05-10T10:00:00Z");

    const { rerender } = render(
      <ContactSearchList
        contacts={[A, C]}
        externalContacts={[extB, extD]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );

    const initialOrder = visibleOrder();
    expect(initialOrder).toEqual(["A Alpha", "B Bravo", "C Charlie", "D Delta"]);

    // Simulate import: ext_B becomes a brand-new imported row with a new UUID,
    // same email. external list drops ext_B.
    const bImported: ExtendedContact = {
      ...extB,
      id: "imp-newly-imported-bravo",
      is_message_derived: false,
      source: "contacts_app",
      // The data layer may even hand back a different last_communication_at,
      // e.g. the moment of import. The renderer must NOT use that to reorder.
      last_communication_at: "2026-06-08T10:00:00Z",
    };

    rerender(
      <ContactSearchList
        contacts={[A, C, bImported]}
        externalContacts={[extD]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );

    // Visible order: B's new identity occupies B's old slot. D stays at tail.
    expect(visibleOrder()).toEqual(["A Alpha", "B Bravo", "C Charlie", "D Delta"]);
  });

  /**
   * Scenario 3: User-initiated sort-order change triggers a fresh sort.
   *
   * Stable-order ref must NOT block deliberate user-controlled list changes.
   * Toggling sortOrder is an explicit user list-change event — order should
   * recompute from scratch.
   */
  it("recomputes order when sortOrder changes (recent → alphabetical)", () => {
    // Initial recency order: most recent first.
    // Names chosen so alphabetical order differs from recency order.
    const Zed = makeImported("Zed Zulu", "2026-06-01T10:00:00Z"); // newest
    const Mike = makeImported("Mike Mike", "2026-05-15T10:00:00Z");
    const Alpha = makeImported("Alpha Alpha", "2026-04-01T10:00:00Z"); // oldest

    const { rerender } = render(
      <ContactSearchList
        contacts={[Zed, Mike, Alpha]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
        sortOrder="recent"
      />,
    );

    expect(visibleOrder()).toEqual(["Zed Zulu", "Mike Mike", "Alpha Alpha"]);

    rerender(
      <ContactSearchList
        contacts={[Zed, Mike, Alpha]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
        sortOrder="alphabetical"
      />,
    );

    // Fresh sort runs because sortOrder (a sort-key input) changed.
    expect(visibleOrder()).toEqual(["Alpha Alpha", "Mike Mike", "Zed Zulu"]);
  });
});

/**
 * Selection does not reorder — BACKLOG-1761 (residual of BACKLOG-1745).
 *
 * The original SVO tests all used selectedIds=[] and never asserted stability
 * across a SELECTION change. QA (PR #1780, fresh DB, New Transaction) found
 * that clicking a contact still moved it out of its alphabetical slot.
 *
 * Two distinct cases:
 *  1. Clicking an ALREADY-IMPORTED contact only toggles selectedIds. Order must
 *     not change and the checkbox state must follow the click.
 *  2. Clicking an EXTERNAL contact imports it (new UUID) then silently refreshes.
 *     The newly-imported row must reclaim the external row's slot even when the
 *     dedup/import happened via a NON-PRIMARY email/phone — mirroring
 *     isContactImported, which already dedups on the full allEmails/allPhones
 *     set. If substitution only matches the primary identity, the row escapes
 *     its slot (appended at the tail) — the BACKLOG-1761 bump.
 */
describe("ContactSearchList — Selection does not reorder (BACKLOG-1761)", () => {
  beforeEach(() => {
    idSeq = 0;
  });

  // Names of currently-selected rows, in DOM order.
  const selectedNames = (): string[] =>
    screen
      .getAllByRole("option")
      .filter((el) => el.getAttribute("aria-selected") === "true")
      .map((el) => el.textContent || "");

  it("keeps a mid-list imported contact in place when selected and unselected", () => {
    const cs = [
      makeImported("A Alpha", null),
      makeImported("B Bravo", null),
      makeImported("C Charlie", null),
      makeImported("D Delta", null),
      makeImported("E Echo", null),
    ];
    const expected = ["A Alpha", "B Bravo", "C Charlie", "D Delta", "E Echo"];

    const { rerender } = render(
      <ContactSearchList
        contacts={cs}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );
    expect(visibleOrder()).toEqual(expected);
    expect(selectedNames()).toEqual([]);

    // Select the mid-list contact (C).
    rerender(
      <ContactSearchList
        contacts={cs}
        selectedIds={[cs[2].id]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );
    // Order unchanged; only C is checked.
    expect(visibleOrder()).toEqual(expected);
    expect(selectedNames()).toEqual(["C Charlie"]);

    // Unselect it again.
    rerender(
      <ContactSearchList
        contacts={cs}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );
    expect(visibleOrder()).toEqual(expected);
    expect(selectedNames()).toEqual([]);
  });

  it("keeps order stable across multiple sequential selections", () => {
    const cs = [
      makeImported("A Alpha", null),
      makeImported("B Bravo", null),
      makeImported("C Charlie", null),
      makeImported("D Delta", null),
    ];
    const expected = ["A Alpha", "B Bravo", "C Charlie", "D Delta"];

    const { rerender } = render(
      <ContactSearchList
        contacts={cs}
        selectedIds={[]}
        onSelectionChange={() => {}}
        showCategoryFilter={false}
      />,
    );
    expect(visibleOrder()).toEqual(expected);

    // Select D, then B, then A — order must never change.
    for (const sel of [[cs[3].id], [cs[3].id, cs[1].id], [cs[3].id, cs[1].id, cs[0].id]]) {
      rerender(
        <ContactSearchList
          contacts={cs}
          selectedIds={sel}
          onSelectionChange={() => {}}
          showCategoryFilter={false}
        />,
      );
      expect(visibleOrder()).toEqual(expected);
    }
    expect(selectedNames()).toEqual(["A Alpha", "B Bravo", "D Delta"]);
  });

  it("keeps an external contact in place when it imports via a NON-primary email", () => {
    // Fresh-DB shape: nothing imported yet, macOS/address-book contacts external.
    // "Carol" has two emails; her PRIMARY on the external side is carol.work,
    // but after import the DB hands back carol.home as primary (order flip).
    const A = makeExternal("A Alpha", null);
    const carolExt = makeExternal("Carol", null, {
      email: "carol.work@x.com",
      allEmails: ["carol.work@x.com", "carol.home@x.com"],
    });
    const B = makeExternal("B Bravo", null);

    const { rerender } = render(
      <ContactSearchList
        contacts={[]}
        externalContacts={[A, carolExt, B]}
        selectedIds={[]}
        onSelectionChange={() => {}}
        onImportContact={async (c) => c}
        showCategoryFilter={false}
      />,
    );
    // Capture the initial visible order; Carol sits mid-list at index 1.
    const initialOrder = visibleOrder();
    expect(initialOrder).toContain("Carol");
    expect(initialOrder.indexOf("Carol")).toBe(1);

    // Click Carol → import. New UUID, is_message_derived=false, PRIMARY email
    // flipped to carol.home; allEmails still contain both. Selected.
    const carolImported: ExtendedContact = {
      ...carolExt,
      id: "imp-carol-new",
      is_message_derived: false,
      source: "contacts_app",
      email: "carol.home@x.com",
      allEmails: ["carol.home@x.com", "carol.work@x.com"],
      last_communication_at: "2026-06-08T10:00:00Z",
    };

    rerender(
      <ContactSearchList
        contacts={[carolImported]}
        externalContacts={[A, B]}
        selectedIds={[carolImported.id]}
        onSelectionChange={() => {}}
        onImportContact={async (c) => c}
        showCategoryFilter={false}
      />,
    );

    // Carol must stay at her original slot (index 1), now checked — not bumped away.
    expect(visibleOrder()).toEqual(initialOrder);
    expect(selectedNames()).toEqual(["Carol"]);
  });
});
