/**
 * ContactSearchList — Stable Order Regression Tests (BACKLOG-1745)
 *
 * Industry convention for contact pickers (Gmail, Outlook, Slack, Finder):
 * selection and import do NOT reorder existing rendered rows. Position is
 * stable. Newly-imported contacts may appear in place (if they were already
 * visible as external) or appended at the end if entirely new.
 *
 * These tests pin the user-visible behaviour against regressions in the
 * `combinedContacts` memo in ContactSearchList. The bug they protect against:
 *
 *   - User clicks an external contact's checkbox
 *   - Parent imports it and calls `onSilentRefreshContacts()`
 *   - Parent re-renders ContactSearchList with a NEW `contacts` array
 *     reference containing the freshly-imported contact
 *   - Pre-fix: the `combinedContacts` memo re-ran `sortByRecentCommunication`
 *     on the whole list, visibly shuffling existing rows
 *   - Post-fix: existing rows keep their slot; the new contact is appended
 *
 * @see BACKLOG-1745
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { ContactSearchList } from "../ContactSearchList";
import type { ExtendedContact } from "../../../types/components";

// Mock ContactRow so we can read the rendered order via testids.
jest.mock("../ContactRow", () => ({
  ContactRow: ({
    contact,
    isSelected,
    onSelect,
  }: {
    contact: { id: string; email?: string };
    isSelected: boolean;
    onSelect: () => void;
  }) => (
    <div
      data-testid={`contact-row-${contact.id}`}
      data-selected={isSelected}
      onClick={onSelect}
      role="option"
      aria-selected={isSelected}
    >
      {contact.email || contact.id}
    </div>
  ),
}));

/**
 * Build an imported contact. `last_communication_at` lets us control sort
 * order under the default "recent" sortOrder.
 */
function imported(
  id: string,
  lastCommHoursAgo: number,
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact {
  return {
    id,
    name: id,
    display_name: id,
    email: `${id}@example.com`,
    user_id: "user-1",
    source: "email",
    last_communication_at: new Date(
      Date.now() - lastCommHoursAgo * 3600 * 1000
    ).toISOString(),
    ...overrides,
  } as ExtendedContact;
}

/**
 * Build an external contact (`is_message_derived: true`).
 */
function external(
  id: string,
  lastCommHoursAgo: number,
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact {
  return {
    id,
    name: id,
    display_name: id,
    email: `${id}@external.com`,
    user_id: "user-1",
    source: "inferred",
    is_message_derived: true,
    last_communication_at: new Date(
      Date.now() - lastCommHoursAgo * 3600 * 1000
    ).toISOString(),
    ...overrides,
  } as ExtendedContact;
}

/** Read the rendered ID order from the DOM. */
function renderedIds(): string[] {
  return screen
    .getAllByTestId(/^contact-row-/)
    .map((el) => el.getAttribute("data-testid")!.replace("contact-row-", ""));
}

describe("ContactSearchList — stable order across silent refresh (BACKLOG-1745)", () => {
  it("preserves existing rendered order when an external contact is imported and silent-refreshed", async () => {
    // ARRANGE: 5 imported contacts + 3 external contacts, with deliberately
    // mixed last_communication_at so the recent-first sort produces a
    // non-trivial order across both groups.
    const initialImported = [
      imported("imp-a", 1), // most recent
      imported("imp-b", 10),
      imported("imp-c", 50),
      imported("imp-d", 200),
      imported("imp-e", 500), // least recent
    ];
    const initialExternal = [
      external("ext-x", 5),
      external("ext-y", 20),
      external("ext-z", 100),
    ];

    const { rerender } = render(
      <ContactSearchList
        contacts={initialImported}
        externalContacts={initialExternal}
        selectedIds={[]}
        onSelectionChange={jest.fn()}
        onImportContact={jest.fn()}
      />
    );

    // Capture baseline order.
    const before = renderedIds();
    expect(before).toHaveLength(8);

    // ACT 1: parent simulates the post-click selection update (no list change).
    rerender(
      <ContactSearchList
        contacts={initialImported}
        externalContacts={initialExternal}
        selectedIds={["ext-x"]}
        onSelectionChange={jest.fn()}
        onImportContact={jest.fn()}
      />
    );

    // ACT 2: parent simulates `onSilentRefreshContacts()` returning a NEW
    // array reference. The clicked external contact ("ext-x") is now imported
    // (it appears in `contacts` and is filtered out of `externalContacts`).
    // The imported-row gets a fresh `id` — this mirrors real behaviour where
    // `contactService.create()` returns a brand-new row id.
    const refreshedImported = [
      ...initialImported.map((c) => ({ ...c })), // new object refs, same data
      imported("imp-from-ext-x", 5, { email: "ext-x@external.com" }),
    ];
    const refreshedExternal = initialExternal
      .filter((c) => c.id !== "ext-x")
      .map((c) => ({ ...c }));

    rerender(
      <ContactSearchList
        contacts={refreshedImported}
        externalContacts={refreshedExternal}
        selectedIds={["imp-from-ext-x"]}
        onSelectionChange={jest.fn()}
        onImportContact={jest.fn()}
      />
    );

    // ASSERT: every ID that was visible before AND is still present must
    // remain in the same relative order. The freshly-imported row may appear
    // anywhere (we append at the end) — the contract is "existing rows do
    // not shuffle".
    const after = renderedIds();
    const stillPresentBefore = before.filter((id) => id !== "ext-x");
    const stillPresentAfter = after.filter((id) => id !== "imp-from-ext-x");

    expect(stillPresentAfter).toEqual(stillPresentBefore);

    // And the new contact is somewhere in the list.
    expect(after).toContain("imp-from-ext-x");
  });
});

describe("ContactSearchList — stable order when toggling an already-imported contact (BACKLOG-1745, belt-and-suspenders)", () => {
  it("does not reorder rows when the user toggles an already-imported contact's checkbox", () => {
    const list = [
      imported("imp-a", 1),
      imported("imp-b", 10),
      imported("imp-c", 50),
      imported("imp-d", 200),
      imported("imp-e", 500),
    ];

    const onSelectionChange = jest.fn();

    const { rerender } = render(
      <ContactSearchList
        contacts={list}
        externalContacts={[]}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />
    );

    const before = renderedIds();
    expect(before).toHaveLength(5);

    // Simulate a checkbox click on imp-c → parent updates selectedIds.
    rerender(
      <ContactSearchList
        contacts={list}
        externalContacts={[]}
        selectedIds={["imp-c"]}
        onSelectionChange={onSelectionChange}
      />
    );

    expect(renderedIds()).toEqual(before);

    // Toggle it back off.
    rerender(
      <ContactSearchList
        contacts={list}
        externalContacts={[]}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />
    );

    expect(renderedIds()).toEqual(before);
  });
});
