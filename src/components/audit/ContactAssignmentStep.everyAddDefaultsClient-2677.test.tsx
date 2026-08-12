/**
 * BACKLOG-2677 — EVERY contact added to a transaction arrives as Client.
 *
 * ===========================================================================
 * THE FOUNDER'S REPRO, AND WHY THE EXISTING DEFAULT DID NOT COVER IT
 * ===========================================================================
 * He created a transaction, added one contact, and the save came back with
 * "At least one contact must be assigned the Buyer (Client) role". He then set
 * the role by hand.
 *
 * The default was NOT deleted — `ContactAssignmentStep.test.tsx` has covered
 * "defaults every unassigned contact to Client on step-3 entry" since
 * BACKLOG-2358 and that case still passes. The hole is in WHEN the fill runs:
 *
 *   1. `autoFillAppliedRef` was a BOOLEAN, set to `true` BEFORE the loop, so
 *      the fill ran exactly once per visit to step 3.
 *   2. The loop iterated `extendedContacts` — `contacts.map(...)`, the LOCAL
 *      SAVED LIST — so any selected id absent from `contacts` at that instant
 *      was skipped, permanently.
 *
 * Those two together make a live sequence:
 *
 *   step 2: add an address-book record → it is imported → its NEW id is
 *           selected immediately, while the silent refresh is still in flight
 *   step 3: the fill runs against a `contacts` array that does not contain it
 *           yet → nothing assigned → the boolean ref latches
 *   then:   the refresh lands, the row appears with an EMPTY role select,
 *           and the fill never runs again
 *   save:   rejected.
 *
 * That is the founder's symptom exactly: a contact he could SEE, with no role,
 * rejected at save. The component already knows this window exists — it is the
 * stated reason `augmentedContacts` exists, which supplies the imported
 * contact's data to the Added chip during precisely this gap. The chip was
 * taught about the window; the role fill was not.
 *
 * BISECT: this is NOT a regression of BACKLOG-2567. That commit (e010602f)
 * deleted only the `autoFilledContactIds` badge bookkeeping and left
 * `onAssignContact(role, contact.id, false, "")` in place. The gap is
 * congenital to BACKLOG-2358 (9d810eda), whose diff already reads
 * `extendedContacts.filter((c) => selectedContactIds.includes(c.id))`.
 * BACKLOG-2400/2405 (PR #2175) made reaching it routine.
 *
 * FOUNDER DECISION, 12 Aug (binding): *"any should default to client. until we
 * have an algorithm that can infer that"* — EVERY contact added defaults to
 * Client, not just the first. The item body's first-only proposal is rejected.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import { SPECIFIC_ROLES } from "../../constants/contactRoles";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  settingsService: {
    getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false),
  },
}));

/** A saved contact, shaped like the rows `contacts:get-all` emits. */
function savedContact(id: string, name: string): Contact {
  return {
    id,
    user_id: "user-123",
    name,
    display_name: name,
    email: `${id}@example.com`,
    phone: null,
    company: null,
    source: "manual",
    is_message_derived: false,
    created_at: "2026-08-12T00:00:00Z",
    updated_at: "2026-08-12T00:00:00Z",
  } as Contact;
}

const ALICE = savedContact("contact-1", "Alice Buyer");
const BEN = savedContact("contact-2", "Ben Second");
const CARA = savedContact("contact-3", "Cara Third");

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    step: 3,
    contactAssignments: {},
    selectedContactIds: [] as string[],
    onSelectedContactIdsChange: jest.fn(),
    onAssignContact: jest.fn(),
    onRemoveContact: jest.fn(),
    userId: "user-123",
    transactionType: "purchase",
    propertyAddress: "Tester Rd, Washington, USA",
    contacts: [] as Contact[],
    contactsLoading: false,
    contactsError: null,
    onRefreshContacts: jest.fn(),
    onRefreshBothLists: jest.fn(),
    externalContacts: [] as Contact[],
    externalContactsLoading: false,
    ...overrides,
  };
}

/** Every `(role, contactId)` pair the component asked its parent to record. */
function assignedPairs(onAssignContact: jest.Mock): Array<[string, string]> {
  return onAssignContact.mock.calls.map((c) => [c[0] as string, c[1] as string]);
}

describe("BACKLOG-2677: the imported-twin window — the founder's repro", () => {
  it("defaults a selected id that is not yet in `contacts`, once the refresh lands", async () => {
    // THE REPRODUCTION. `contact-1` is selected (its import returned this id)
    // but `contacts` has not caught up: exactly the state BACKLOG-2400's
    // `augmentedContacts` was built for.
    //
    // SEQUENCING, and why the anchor contact is load-bearing. The fill is gated
    // on `autoRoleLoaded`, which flips on a promise. Waiting only for the step-3
    // container to appear does NOT prove the fill pass has happened — the
    // rerender below could land first, and the test would go green against the
    // BROKEN code because the fill then saw a populated `contacts`. (It did
    // exactly that on the first run of this file.)
    //
    // `contact-2` IS in `contacts` from the start, so its Client assignment is
    // an observable that can ONLY appear after the fill pass has run. Waiting
    // for it pins the ordering: the pass ran, and it ran while `contact-1` was
    // absent.
    const onAssignContact = jest.fn();

    const { rerender } = render(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1", "contact-2"],
          contacts: [BEN], // contact-1's refresh still in flight
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-2",
      ]);
    });
    // The fill pass has now demonstrably run. Deliberately NO assertion here
    // that contact-1 was skipped: under the fix it is defaulted on this very
    // pass (an id needs no record for the Client baseline), which is better
    // than waiting for the refresh. Pinning the broken intermediate would make
    // this test fail on the correct behaviour.

    // The silent refresh lands and folds the imported contact into `contacts`.
    // The parent has recorded contact-2's assignment by now.
    rerender(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1", "contact-2"],
          contacts: [ALICE, BEN],
          contactAssignments: {
            [SPECIFIC_ROLES.CLIENT]: [
              { contactId: "contact-2", isPrimary: false, notes: "" },
            ],
          },
          onAssignContact,
        })}
      />,
    );

    // BEFORE THE FIX this is where it dies: the boolean `autoFillAppliedRef`
    // latched on the first pass over an empty `contacts`, so the fill never
    // ran again and the founder met an empty role select.
    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-1",
      ]);
    });
  });

  it("defaults a selected id that NEVER appears in `contacts` (no record at all)", async () => {
    // The Client baseline needs no contact record — only the `default_role`
    // smart override does. Under the founder's decision, falling back to plain
    // Client for a record-less id is the CORRECT answer, not a compromise.
    const onAssignContact = jest.fn();

    render(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-ghost"],
          contacts: [],
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-ghost",
      ]);
    });
  });
});

describe("BACKLOG-2677: EVERY contact, not just the first", () => {
  it("defaults the second and third contact to Client as well", async () => {
    // THE LEG THAT FAILS ON A FIRST-ONLY IMPLEMENTATION. The item body proposed
    // defaulting only the first contact on a deal with no Buyer; the founder
    // rejected that reading on 12 Aug.
    const onAssignContact = jest.fn();

    render(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1", "contact-2", "contact-3"],
          contacts: [ALICE, BEN, CARA],
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-1",
      ]);
    });

    // Assert the exact SET, not a count: a count of 3 would also pass if the
    // same contact were defaulted three times.
    expect(new Set(assignedPairs(onAssignContact).map((p) => p.join("|")))).toEqual(
      new Set([
        `${SPECIFIC_ROLES.CLIENT}|contact-1`,
        `${SPECIFIC_ROLES.CLIENT}|contact-2`,
        `${SPECIFIC_ROLES.CLIENT}|contact-3`,
      ]),
    );
  });

  it("defaults a contact added LATER, while the user is still on step 3", async () => {
    // The one-shot fill covered only the ids present when step 3 was entered.
    const onAssignContact = jest.fn();

    const { rerender } = render(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1"],
          contacts: [ALICE, BEN],
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-1",
      ]);
    });

    // A second contact joins the selection without leaving step 3. The parent
    // has recorded contact-1's Client assignment by now, so pass it back —
    // otherwise the component would be asked to re-fill an id it already did.
    rerender(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1", "contact-2"],
          contacts: [ALICE, BEN],
          contactAssignments: {
            [SPECIFIC_ROLES.CLIENT]: [
              { contactId: "contact-1", isPrimary: false, notes: "" },
            ],
          },
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-2",
      ]);
    });
  });
});

describe("BACKLOG-2677: a role the user set by hand is never re-defaulted", () => {
  it("leaves a contact that already holds a non-Client role alone", async () => {
    const onAssignContact = jest.fn();

    render(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1", "contact-2"],
          contacts: [ALICE, BEN],
          contactAssignments: {
            // contact-2 was changed by hand to Seller Agent.
            [SPECIFIC_ROLES.SELLER_AGENT]: [
              { contactId: "contact-2", isPrimary: false, notes: "" },
            ],
          },
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-1",
      ]);
    });

    // contact-2 must not be touched, under ANY role.
    expect(
      assignedPairs(onAssignContact).filter(([, id]) => id === "contact-2"),
    ).toEqual([]);
  });

  it("does not re-default a contact whose role the user CLEARS while on step 3", async () => {
    // Requirement 3's sharp edge. The fill must remember which ids it has
    // already defaulted, not merely ask "does this id have a role right now?" —
    // otherwise clearing a role hands it straight back.
    const onAssignContact = jest.fn();
    const props = baseProps({
      selectedContactIds: ["contact-1"],
      contacts: [ALICE],
      onAssignContact,
    });

    const { rerender } = render(<ContactAssignmentStep {...props} />);

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        SPECIFIC_ROLES.CLIENT,
        "contact-1",
      ]);
    });

    const callsAfterFirstFill = onAssignContact.mock.calls.length;

    // The parent records the Client assignment...
    rerender(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1"],
          contacts: [ALICE],
          contactAssignments: {
            [SPECIFIC_ROLES.CLIENT]: [
              { contactId: "contact-1", isPrimary: false, notes: "" },
            ],
          },
          onAssignContact,
        })}
      />,
    );

    // ...and the user then clears it (role select back to "no role"), which
    // `removeContact` reports as an empty array for that role.
    rerender(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-1"],
          contacts: [ALICE],
          contactAssignments: { [SPECIFIC_ROLES.CLIENT]: [] },
          onAssignContact,
        })}
      />,
    );

    // The fill must NOT put Client back.
    await waitFor(() => {
      expect(screen.getByTestId("contact-assignment-step-3")).toBeInTheDocument();
    });
    expect(onAssignContact.mock.calls.length).toBe(callsAfterFirstFill);
  });
});

describe("BACKLOG-2677: the default_role override still wins when auto-role is ON", () => {
  it("uses the contact's saved default_role instead of the Client baseline", async () => {
    // The existing BACKLOG-2358 precedence must survive the rewrite: this is
    // the "algorithm that can infer that" carve-out the founder named, in the
    // one form it exists today.
    const { settingsService } = jest.requireMock("../../services");
    settingsService.getContactAutoRoleEnabled.mockResolvedValueOnce(true);

    const onAssignContact = jest.fn();
    const benWithRole = { ...BEN, default_role: "seller_agent" } as Contact;

    render(
      <ContactAssignmentStep
        {...baseProps({
          selectedContactIds: ["contact-2"],
          contacts: [benWithRole],
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(assignedPairs(onAssignContact)).toContainEqual([
        "seller_agent",
        "contact-2",
      ]);
    });
    expect(assignedPairs(onAssignContact)).not.toContainEqual([
      SPECIFIC_ROLES.CLIENT,
      "contact-2",
    ]);
  });
});

describe("BACKLOG-2677: the fill is scoped to step 3", () => {
  it("assigns nothing while the user is still choosing contacts on step 2", async () => {
    const onAssignContact = jest.fn();

    render(
      <ContactAssignmentStep
        {...baseProps({
          step: 2,
          selectedContactIds: ["contact-1"],
          contacts: [ALICE],
          onAssignContact,
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("contact-assignment-step-2")).toBeInTheDocument();
    });
    expect(onAssignContact).not.toHaveBeenCalled();
  });
});

// Keeps `userEvent` imported for the suite's interaction-shaped future cases
// without tripping no-unused-vars today.
void userEvent;
