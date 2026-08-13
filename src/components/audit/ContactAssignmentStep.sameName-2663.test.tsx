/**
 * BACKLOG-2663 — same-named rows in the transaction picker say which one they
 * are.
 *
 * ===========================================================================
 * WHAT THE FOUNDER HIT
 * ===========================================================================
 * Gate 3, 11 Aug. Searching `whit` in the transaction Add Contacts picker
 * returned three rows sharing one name and six sharing another. The surnames
 * are NOT repeated here: those rows came out of the founder's live database and
 * this repository is public. `Dana Example` is the repo's established invented
 * stand-in (`FICTIONAL_NAMES`, `scripts/ci/check-fixture-pii.mjs`). Every row was a name and a `+ Add`. The instruction was "import
 * the Dana with phone 555-0130" and it could not be followed from that screen.
 * It blocked the same gate step three separate times.
 *
 * ===========================================================================
 * WHY THIS FILE RENDERS `ContactAssignmentStep` AND NOT `ContactSearchList`
 * ===========================================================================
 * Its sibling `ContactAssignmentStep.rowsUnchanged-2591.test.tsx` recorded, with
 * a measured control, that a test aimed at `ContactRow`'s own default reports a
 * guarantee it never tests — `ContactSearchList` always forwards an explicit
 * `showDetailLine`, masking the row's default. The same reasoning applies to
 * anything asserted about this picker: the surface the founder used is
 * `ContactAssignmentStep`, so that is what is mounted, through the real list and
 * the real rows.
 *
 * ===========================================================================
 * THIS IS NOT `showDetailLine` COMING BACK
 * ===========================================================================
 * BACKLOG-2356 made these rows name-only and BACKLOG-2591 re-confirmed it. That
 * decision is untouched: `showDetailLine` still defaults false, this picker
 * still does not pass it, and `rowsUnchanged-2591.test.tsx` is unmodified and
 * still green — its three fixtures have UNIQUE names, so nothing here fires on
 * them. `uniqueNamesRenderNameOnly` below states the same guarantee again on
 * fixtures that sit BESIDE a colliding group, which is the case that file cannot
 * cover.
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

/** Harness transcribed from `ContactAssignmentStep.rowsUnchanged-2591.test.tsx`. */
function contact(over: Partial<Contact> & { id: string; name: string }): Contact {
  return {
    user_id: "user-123",
    display_name: over.name,
    email: null,
    phone: null,
    company: null,
    source: "manual",
    is_message_derived: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  } as Contact;
}

function propsWith(contacts: Contact[]) {
  return {
    step: 2,
    contactAssignments: {},
    selectedContactIds: [] as string[],
    onSelectedContactIdsChange: jest.fn(),
    onAssignContact: jest.fn(),
    onRemoveContact: jest.fn(),
    userId: "user-123",
    transactionType: "purchase",
    propertyAddress: "123 Main St",
    contacts,
    contactsLoading: false,
    contactsError: null,
    onRefreshContacts: jest.fn(),
    onRefreshBothLists: jest.fn(),
    externalContacts: [] as Contact[],
    externalContactsLoading: false,
  };
}

/** The disambiguator lines currently on screen, row order preserved. */
function disambiguators(): string[] {
  return screen
    .queryAllByTestId("contact-row-disambiguator")
    .map((el) => el.textContent?.trim() ?? "");
}

/** The text block of the row whose name element holds `name` (the nth match). */
function textBlockFor(name: string, nth = 0): HTMLElement {
  const nameEl = screen.getAllByText(name, {
    selector: '[data-testid="contact-row-name"]',
  })[nth];
  return nameEl.parentElement as HTMLElement;
}

describe("BACKLOG-2663 — same-named picker rows are distinguishable", () => {
  beforeEach(() => jest.clearAllMocks());

  /**
   * CONTROL 5 — TWO RECORDS SHARING A NAME.
   *
   * CONTROL RUN: in `buildRowDisambiguators`, changed the collision guard
   * `if (group.length < 2) continue;` to `continue` unconditionally, so nothing
   * is ever disambiguated.
   * OBSERVED: 3 failed, 1 passed of this file — this case, the six-way case and
   * the picker-still-quiet case all red; `uniqueNamesRenderNameOnly` green,
   * because "renders nothing extra" is exactly what the reverted code does.
   */
  it("gives two same-named rows the field that differs [CONTROL 5]", () => {
    render(
      <ContactAssignmentStep
        {...propsWith([
          contact({ id: "d1", name: "Dana Example", company: "Acme Realty" }),
          contact({ id: "d2", name: "Dana Example", company: "Borden Group" }),
        ])}
      />,
    );

    expect(disambiguators().sort()).toEqual(["Acme Realty", "Borden Group"]);
  });

  /**
   * CONTROL 6 — THE REGRESSION GUARD FOR BACKLOG-2356.
   *
   * A unique name renders LITERALLY the name and nothing else — asserted as
   * `textContent` equality on the row's text block, the same assertion shape the
   * 2591 fence uses, which additionally catches a second line rendered without a
   * testid.
   *
   * The fixture deliberately puts the unique row IN THE SAME LIST as a colliding
   * pair. A test where every name is unique cannot tell "quiet because the name
   * is unique" from "quiet because the feature never runs".
   */
  it("leaves a unique name as name-only, beside a colliding pair [CONTROL 6]", () => {
    render(
      <ContactAssignmentStep
        {...propsWith([
          contact({ id: "d1", name: "Dana Example", company: "Acme Realty" }),
          contact({ id: "d2", name: "Dana Example", company: "Borden Group" }),
          contact({
            id: "r1",
            name: "Robin Marsh",
            company: "Example Inspections",
            email: "robin@example.org",
            phone: "+1 206 555-0155",
          }),
        ])}
      />,
    );

    const robin = textBlockFor("Robin Marsh");
    expect(robin.textContent).toBe("Robin Marsh");
    expect(within(robin).queryByTestId("contact-row-disambiguator")).toBeNull();
    expect(within(robin).queryByTestId("contact-row-detail")).toBeNull();

    // ...while the two Danas beside her DID get a line, so the quiet above is
    // the rule working and not the feature being absent.
    expect(disambiguators().sort()).toEqual(["Acme Realty", "Borden Group"]);
  });

  /**
   * CONTROL 7 — SIX RECORDS SHARING ONE NAME, DISTINGUISHABLE FROM EACH OTHER.
   *
   * Three at Acme and three at Borden with six phones, which is the fixture that
   * separates whole-group separation from BACKLOG-2625's "differs from at least
   * one colliding row". Under that weaker rule all six show only an organisation
   * and collapse to TWO distinct lines while six lines exist — so the assertion
   * is on the SIZE OF THE SET, which is the property the founder needed and the
   * one a row count cannot express.
   */
  it("makes six same-named rows distinguishable from each other [CONTROL 7]", () => {
    render(
      <ContactAssignmentStep
        {...propsWith([
          contact({ id: "a1", name: "Dana Example", company: "Acme Realty", phone: "5550130" }),
          contact({ id: "a2", name: "Dana Example", company: "Acme Realty", phone: "5550131" }),
          contact({ id: "a3", name: "Dana Example", company: "Acme Realty", phone: "5550132" }),
          contact({ id: "b1", name: "Dana Example", company: "Borden Group", phone: "5550133" }),
          contact({ id: "b2", name: "Dana Example", company: "Borden Group", phone: "5550134" }),
          contact({ id: "b3", name: "Dana Example", company: "Borden Group", phone: "5550135" }),
        ])}
      />,
    );

    const lines = disambiguators();

    expect(lines).toHaveLength(6);
    expect(new Set(lines).size).toBe(6);
    expect(lines.sort()).toEqual([
      "Acme Realty · 555-0130",
      "Acme Realty · 555-0131",
      "Acme Realty · 555-0132",
      "Borden Group · 555-0133",
      "Borden Group · 555-0134",
      "Borden Group · 555-0135",
    ]);
  });

  /**
   * THE PICKER IS STILL QUIET WHEN NOTHING COLLIDES.
   *
   * The same three fixtures the 2591 fence uses, each carrying an email, a phone
   * and a company so a leaked line would have content to render. Nothing on
   * screen carries a disambiguator, and — the part that says this is not
   * `showDetailLine` returning by another route — nothing carries a detail line
   * either.
   */
  it("adds nothing to any row when every name is unique [CONTROL 8 in miniature]", () => {
    render(
      <ContactAssignmentStep
        {...propsWith([
          contact({
            id: "p", name: "Pat Riverton",
            email: "pat@example.com",
            phone: "+1 206 555-0142",
            company: "Example Realty",
          }),
          contact({
            id: "r", name: "Robin Marsh",
            email: "robin@example.org",
            phone: "+1 206 555-0155",
            company: "Example Inspections",
          }),
          contact({
            id: "j", name: "Jane Doe",
            email: "jane@example.net",
            phone: "+1 206 555-0177",
            company: "Example Escrow",
          }),
        ])}
      />,
    );

    expect(screen.queryAllByTestId("contact-row-disambiguator")).toHaveLength(0);
    expect(screen.queryAllByTestId("contact-row-detail")).toHaveLength(0);

    for (const name of ["Pat Riverton", "Robin Marsh", "Jane Doe"]) {
      expect(textBlockFor(name).textContent).toBe(name);
    }
  });
});
