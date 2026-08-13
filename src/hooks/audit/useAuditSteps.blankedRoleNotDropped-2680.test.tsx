/**
 * BACKLOG-2680 — THE WIZARD MUST NOT SILENTLY DROP A CONTACT WHOSE ROLE WAS
 * BLANKED.
 *
 * ===========================================================================
 * THE WALK-THROUGH THIS SUITE REPRODUCES
 * ===========================================================================
 * Sam adds three people to a new purchase: his client Dana, the seller's agent,
 * and an inspector. He is not sure what the inspector's role should be, so he
 * sets that dropdown back to blank, meaning to fill it in later. He presses
 * Create.
 *
 * Before this change the deal saved successfully with TWO of the three, and he
 * was told nothing:
 *
 *   1. `ContactAssignmentStep.handleRoleChange` with an empty new role removes
 *      the contact from its old role and does not reassign it, so the contact
 *      is in NO key of the assignments map.
 *   2. `useAuditSteps`'s step-3 gate asked only whether SOMEONE held `client`.
 *      Dana did. It never asked whether every selected contact still had a
 *      role, so it passed.
 *   3. `useAuditSubmission` builds its payload by iterating the ROLE MAP, not
 *      `selectedContactIds`, so a contact in no role produced no row.
 *
 * ===========================================================================
 * WHY THE BLANKING IS DRIVEN THROUGH THE REAL DROPDOWN
 * ===========================================================================
 * The blank option is not hypothetical — `ContactRoleRow` renders
 * `<option value="">Select role...</option>`, so choosing it is a reachable,
 * deliberate user action. This suite selects that option on the REAL component
 * rather than hand-building an assignments map with a gap in it, because a
 * hand-built map is a fixture describing a state I would be asserting the
 * producer can reach. `userEvent.selectOptions` proves it can.
 *
 * ===========================================================================
 * WHAT THIS MUST NOT UNDO — BACKLOG-2677
 * ===========================================================================
 * 2677's fix defaults EVERY added contact to Client and its
 * `defaultedContactIdsRef` Set exists so a role the user CLEARED BY HAND is
 * never handed Client back. This fix reports the cleared role rather than
 * overwriting it, so that guarantee is untouched — and the last test here
 * pins it: after the block, the cleared row is still blank, not re-defaulted.
 *
 * The harness is the one from `useAuditSteps.saveSucceedsUntouched-2677`, whose
 * reducers are TRANSCRIBED from `useAuditContactAssignment.ts`. Do not
 * "simplify" them.
 */

import React, { useCallback, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "../../components/audit/ContactAssignmentStep";
import { useAuditSteps } from "./useAuditSteps";
import { SPECIFIC_ROLES } from "../../constants/contactRoles";
import type { AddressData, ContactAssignment, ContactAssignments } from "./types";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../services", () => ({
  settingsService: {
    getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false),
  },
}));

const BUYER_ERROR = "At least one contact must be assigned the Buyer (Client) role";

function savedContact(id: string, name: string): Contact {
  return {
    id,
    user_id: "user-123",
    name,
    display_name: name,
    email: `${id}@example.com`,
    source: "manual",
    is_message_derived: false,
    created_at: "2026-08-12T00:00:00Z",
    updated_at: "2026-08-12T00:00:00Z",
  } as Contact;
}

const ADDRESS: AddressData = {
  property_address: "Tester Rd, Washington, USA",
  property_street: "Tester Rd",
  property_city: "Washington",
  property_state: "DC",
  property_zip: "20001",
  property_coordinates: null,
  transaction_type: "purchase",
  started_at: "2026-08-12",
};

interface HarnessProps {
  contacts: Contact[];
  selectedContactIds: string[];
  onSubmit: () => void;
  setError: (e: string | null) => void;
  onAssignmentsChange?: (a: ContactAssignments) => void;
}

function WizardHarness({
  contacts,
  selectedContactIds,
  onSubmit,
  setError,
  onAssignmentsChange,
}: HarnessProps) {
  const [contactAssignments, setContactAssignments] = useState<ContactAssignments>({});

  // TRANSCRIBED from useAuditContactAssignment.ts:250-270. Do not "simplify".
  const assignContact = useCallback(
    (role: string, contactId: string, isPrimary = false, notes = ""): void => {
      setContactAssignments((prev) => {
        const existing = prev[role] || [];
        const existingIndex = existing.findIndex(
          (c: ContactAssignment) => c.contactId === contactId,
        );
        let next: ContactAssignments;
        if (existingIndex !== -1) {
          const updated = [...existing];
          updated[existingIndex] = { contactId, isPrimary, notes };
          next = { ...prev, [role]: updated };
        } else {
          next = { ...prev, [role]: [...existing, { contactId, isPrimary, notes }] };
        }
        onAssignmentsChange?.(next);
        return next;
      });
    },
    [onAssignmentsChange],
  );

  // TRANSCRIBED from useAuditContactAssignment.ts:275-283.
  const removeContact = useCallback(
    (role: string, contactId: string): void => {
      setContactAssignments((prev) => {
        const existing = prev[role] || [];
        const next = { ...prev, [role]: existing.filter((c) => c.contactId !== contactId) };
        onAssignmentsChange?.(next);
        return next;
      });
    },
    [onAssignmentsChange],
  );

  const { step, handleNextStep } = useAuditSteps({
    isEditing: false,
    addressData: ADDRESS,
    selectedContactIds,
    contactAssignments,
    onSubmit,
    setError,
  });

  return (
    <div>
      <button data-testid="wizard-next" onClick={handleNextStep}>
        Next
      </button>
      <span data-testid="wizard-step">{step}</span>
      {step >= 2 && (
        <ContactAssignmentStep
          step={step}
          contactAssignments={contactAssignments}
          selectedContactIds={selectedContactIds}
          onSelectedContactIdsChange={jest.fn()}
          onAssignContact={assignContact}
          onRemoveContact={removeContact}
          userId="user-123"
          transactionType="purchase"
          propertyAddress={ADDRESS.property_address}
          contacts={contacts}
          contactsLoading={false}
          contactsError={null}
          onRefreshContacts={jest.fn()}
          onRefreshBothLists={jest.fn()}
          externalContacts={[]}
          externalContactsLoading={false}
        />
      )}
    </div>
  );
}

async function walkToStepThree(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("wizard-next"));
  await waitFor(() => expect(screen.getByTestId("wizard-step")).toHaveTextContent("2"));
  await user.click(screen.getByTestId("wizard-next"));
  await waitFor(() => expect(screen.getByTestId("wizard-step")).toHaveTextContent("3"));
}

/**
 * `ContactRoleRow` renders the dropdown TWICE — a mobile layout and a desktop
 * layout, one hidden by CSS (the item names both sites: `ContactRoleRow.tsx:177`
 * and `:245`). `getByTestId` therefore throws "found multiple elements", so
 * every access goes through these two helpers.
 *
 * `expectRole` asserts on ALL copies rather than the first: the two layouts are
 * fed from the same `currentRole` prop, and checking one would leave a
 * divergence between them invisible — which is the whole failure class this PR
 * is about.
 */
function roleSelect(contactId: string): HTMLElement {
  return screen.getAllByTestId(`role-select-${contactId}`)[0];
}

function expectRole(contactId: string, value: string): void {
  for (const el of screen.getAllByTestId(`role-select-${contactId}`)) {
    expect(el).toHaveValue(value);
  }
}

const THREE = [
  savedContact("contact-1", "Dana Whitlock"),
  savedContact("contact-2", "Sasha Reyes"),
  savedContact("contact-3", "Inspector Ives"),
];
const THREE_IDS = ["contact-1", "contact-2", "contact-3"];

describe("BACKLOG-2680: a contact whose role is blanked is not silently dropped", () => {
  it("refuses the save and says how many contacts have no role", async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={THREE}
        selectedContactIds={THREE_IDS}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );
    await walkToStepThree(user);

    // Every contact arrives as Client (BACKLOG-2677). Sam blanks the inspector.
    await user.selectOptions(roleSelect("contact-3"), "");
    await waitFor(() => expectRole("contact-3", ""));

    await user.click(screen.getByTestId("wizard-next"));

    // THE ASSERTION IS AT THE SAVE BOUNDARY. A test checking only the field
    // value passes while the deal still saves without him.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "Please assign a role to all contacts (1 contact missing roles)",
    );
  });

  it("counts more than one role-less contact", async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={THREE}
        selectedContactIds={THREE_IDS}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );
    await walkToStepThree(user);

    await user.selectOptions(roleSelect("contact-2"), "");
    await user.selectOptions(roleSelect("contact-3"), "");
    await user.click(screen.getByTestId("wizard-next"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "Please assign a role to all contacts (2 contacts missing roles)",
    );
  });

  /**
   * THE OTHER TWO ARE UNAFFECTED — control 2 of the item. The block must not
   * disturb the roles the user did set.
   */
  it("leaves the other two contacts assigned", async () => {
    const user = userEvent.setup();
    const seen: ContactAssignments[] = [];

    render(
      <WizardHarness
        contacts={THREE}
        selectedContactIds={THREE_IDS}
        onSubmit={jest.fn()}
        setError={jest.fn()}
        onAssignmentsChange={(a) => seen.push(a)}
      />,
    );
    await walkToStepThree(user);

    await user.selectOptions(roleSelect("contact-3"), "");
    await user.click(screen.getByTestId("wizard-next"));

    expectRole("contact-1", SPECIFIC_ROLES.CLIENT);
    expectRole("contact-2", SPECIFIC_ROLES.CLIENT);
  });

  /**
   * BACKLOG-2677 IS NOT UNDONE. A role the user cleared BY HAND stays cleared —
   * the block reports it rather than re-defaulting it. This is 2677's control
   * M4, re-asserted here because this change is the one that could break it.
   */
  it("does not re-default the role it just refused to save", async () => {
    const user = userEvent.setup();

    render(
      <WizardHarness
        contacts={THREE}
        selectedContactIds={THREE_IDS}
        onSubmit={jest.fn()}
        setError={jest.fn()}
      />,
    );
    await walkToStepThree(user);

    await user.selectOptions(roleSelect("contact-3"), "");
    await user.click(screen.getByTestId("wizard-next"));

    expectRole("contact-3", "");
  });

  /**
   * THE SAVE STILL GOES THROUGH when every contact has a role — the leg that
   * fails if the new check is wired up wrongly and blocks everything.
   */
  it("still submits when every contact has a role", async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={THREE}
        selectedContactIds={THREE_IDS}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );
    await walkToStepThree(user);

    await user.click(screen.getByTestId("wizard-next"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalledWith(expect.stringContaining("missing roles"));
  });

  /**
   * THE ORDER OF THE TWO GATES IS PART OF THE FIX, NOT AN ACCIDENT.
   *
   * When BOTH rules fail — one contact on the deal, and its role blanked —
   * whichever gate runs first decides the sentence the user reads. Edit
   * Contacts asks about role-less contacts FIRST, so the wizard must too, or
   * the two surfaces answer one action with two different explanations and
   * BACKLOG-2680's control 3 is not met.
   *
   * "You have not given this person a role" is also the true reason here.
   * "At least one contact must be assigned the Buyer (Client) role" describes a
   * consequence of the blanking and sends the user looking for a second person
   * to add.
   *
   * This is the control that catches a reordering; without it the two gates can
   * be swapped with every other test still green.
   */
  it("reports the role-less contact, not the missing Client, when both rules fail", async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[THREE[0]]}
        selectedContactIds={["contact-1"]}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );
    await walkToStepThree(user);

    await user.selectOptions(roleSelect("contact-1"), "");
    await user.click(screen.getByTestId("wizard-next"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "Please assign a role to all contacts (1 contact missing roles)",
    );
    expect(setError).not.toHaveBeenCalledWith(BUYER_ERROR);
  });

  /**
   * THE CLIENT RULE IS STILL REACHABLE, and still fires when every role has
   * been changed away from Client by hand — BACKLOG-2677 control 4. It is
   * unreachable by default, not deleted, and the new check must not have
   * shadowed it: every contact here HAS a role, so the missing-roles check
   * passes and the Buyer check is the one that must speak.
   */
  it("still reports the missing Client when every role was changed away by hand", async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[THREE[0]]}
        selectedContactIds={["contact-1"]}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );
    await walkToStepThree(user);

    await user.selectOptions(
      roleSelect("contact-1"),
      SPECIFIC_ROLES.SELLER_AGENT,
    );
    await user.click(screen.getByTestId("wizard-next"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(BUYER_ERROR);
  });
});
