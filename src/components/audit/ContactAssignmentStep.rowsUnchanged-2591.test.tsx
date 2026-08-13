/**
 * BACKLOG-2591 — THE TRANSACTION PICKER RENDERS NAME-ONLY, UNCHANGED.
 *
 * ===========================================================================
 * WHY THIS TEST EXISTS AND WHY IT LIVES HERE
 * ===========================================================================
 * BACKLOG-2591 gives `ContactRow` an opt-in `showDetailLine`, so the LINK
 * picker can show `source · email · phone · company` — a linking decision means
 * telling two records of one person from two people who share a name, and a
 * name-only row cannot express that.
 *
 * BACKLOG-2356 removed exactly that line from every picker row on purpose, and
 * the founder's decision on 2591 was explicit: **ON for linking, OFF for the
 * transaction picker, 2356 stands everywhere else.**
 *
 * An opt-in prop is only a fence if the OFF case is asserted on the REAL
 * picker. Asserting that the prop defaults to `false` would test the default,
 * not the consequence — the transaction picker could still grow a second line
 * by someone passing the prop one level up, and every existing suite would stay
 * green. So this renders `ContactAssignmentStep` — the component both live
 * transaction flows actually mount — and asserts on its rows.
 *
 * ===========================================================================
 * WHY TEXT CONTENT, NOT A CHILD COUNT
 * ===========================================================================
 * An earlier draft asserted the row's child-element count against a transcribed
 * baseline. That number moves for reasons unrelated to this prop — BACKLOG-2525
 * added an import-button branch; any future conditional badge moves it again —
 * and when a baseline fails for an unrelated reason the next person updates the
 * constant without reading it. From then on it guards nothing.
 *
 * `row.textContent === displayName` encodes the actual rule — NAME ONLY — and
 * additionally catches a second line rendered WITHOUT the testid, which the
 * testid assertion alone cannot see. It does not move when structure does.
 */

import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

/**
 * Rows chosen so a detail line WOULD have content if the prop leaked: every one
 * carries an email, a phone and a company. A fixture with empty fields could not
 * distinguish "the line is off" from "the line is on but had nothing to say".
 *
 * RFC 2606 domains; `+1 <area> 555-01xx` — the reserved slot is the exchange.
 */
const CONTACTS: Contact[] = [
  {
    id: "contact-pat",
    user_id: "user-123",
    name: "Pat Riverton",
    display_name: "Pat Riverton",
    email: "pat@example.com",
    phone: "+1 206 555-0142",
    company: "Example Realty",
    source: "manual",
    is_message_derived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as Contact,
  {
    id: "contact-robin",
    user_id: "user-123",
    name: "Robin Marsh",
    display_name: "Robin Marsh",
    email: "robin@example.org",
    phone: "+1 206 555-0155",
    company: "Example Inspections",
    source: "email",
    is_message_derived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as Contact,
];

const EXTERNAL: Contact[] = [
  {
    id: "ext-jane",
    user_id: "user-123",
    name: "Jane Doe",
    display_name: "Jane Doe",
    email: "jane@example.net",
    phone: "+1 206 555-0177",
    company: "Example Escrow",
    source: "contacts_app",
    is_message_derived: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as Contact,
];

const defaultProps = {
  step: 2,
  contactAssignments: {},
  selectedContactIds: [] as string[],
  onSelectedContactIdsChange: jest.fn(),
  onAssignContact: jest.fn(),
  onRemoveContact: jest.fn(),
  userId: "user-123",
  transactionType: "purchase",
  propertyAddress: "123 Main St",
  contacts: CONTACTS,
  contactsLoading: false,
  contactsError: null,
  onRefreshContacts: jest.fn(),
  onRefreshBothLists: jest.fn(),
  externalContacts: EXTERNAL,
  externalContactsLoading: false,
};

describe("the transaction picker stays name-only (BACKLOG-2356 fence)", () => {
  /**
   * CONTROL: default `showDetailLine` to `true` in **`ContactSearchList`**.
   * OBSERVED: 2 failed / 2 — both tests below.
   *
   * THE CONTROL NAMES `ContactSearchList` DELIBERATELY, and finding that out
   * mattered. Flipping `ContactRow`'s own default changes NOTHING here
   * (measured: 2 passed, no red) because `ContactSearchList` always forwards an
   * explicit `showDetailLine={showDetailLine}`, masking the row's default
   * entirely. So the fence that actually guards the transaction picker is the
   * LIST's default, not the ROW's — and a control aimed at the row would have
   * reported a guarantee it never tested.
   */
  it("renders NO detail line on any row", () => {
    render(<ContactAssignmentStep {...defaultProps} />);

    const names = screen.getAllByTestId("contact-row-name");
    // The exact SET, sorted — so this cannot pass by rendering nothing, and
    // does not couple to the picker's sort order, which is not what is under
    // test here (it defaults to "recent" and falls back to name).
    expect(names.map((n) => n.textContent).sort()).toEqual([
      "Jane Doe",
      "Pat Riverton",
      "Robin Marsh",
    ]);

    expect(screen.queryAllByTestId("contact-row-detail")).toHaveLength(0);
  });

  /**
   * The stronger half: a row's whole text IS its name. Catches a second line
   * added without the testid, which the assertion above cannot see.
   *
   * CONTROL: default `showDetailLine` to `true` in `ContactSearchList`.
   * OBSERVED: 2 failed / 2 — this one on the text-equality assertion.
   */
  it("renders nothing in a row but the contact's name", () => {
    render(<ContactAssignmentStep {...defaultProps} />);

    for (const expected of ["Pat Riverton", "Robin Marsh", "Jane Doe"]) {
      const nameEl = screen.getByText(expected, { selector: '[data-testid="contact-row-name"]' });
      const textBlock = nameEl.parentElement as HTMLElement;
      expect(textBlock.textContent).toBe(expected);
      expect(within(textBlock).queryByTestId("contact-row-detail")).toBeNull();
    }
  });
});
