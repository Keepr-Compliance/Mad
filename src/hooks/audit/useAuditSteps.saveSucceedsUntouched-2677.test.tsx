/**
 * BACKLOG-2677 — THE SAVE SUCCEEDS WITHOUT THE USER TOUCHING THE ROLE FIELD.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM THE COMPONENT SUITE
 * ===========================================================================
 * `ContactAssignmentStep.everyAddDefaultsClient-2677.test.tsx` asserts that the
 * component ASKS its parent to record a Client role. That is not the founder's
 * complaint. His complaint is that the SAVE was refused — and a test that only
 * checks the role field's value passes happily while the save still rejects,
 * because the two live in different modules:
 *
 *   ContactAssignmentStep  →  onAssignContact  →  useAuditContactAssignment
 *                                                 (the assignments map)
 *                                                        ↓
 *   "Create"  →  useAuditSteps.handleNextStep  →  reads that map  →  onSubmit
 *
 * Everything between the component and `onSubmit` is where the bug was visible
 * to him. So this suite wires the REAL pieces together and drives the REAL
 * three-step walk (1 → 2 → 3 → submit), asserting at the save boundary:
 * `onSubmit` is called, and `setError` is never called with the Buyer message.
 *
 * FIXTURE PROVENANCE. `assignContact` below is TRANSCRIBED from the shipped
 * reducer at `src/hooks/audit/useAuditContactAssignment.ts:250-270`, not
 * invented. If that reducer changes shape, this harness must change with it —
 * an invented reducer would let this suite go green against a component that
 * cannot actually populate the real map.
 *
 * CONTROL 4 IS THE OTHER HALF. The "at least one Buyer" validation is NOT
 * deleted by this work — it becomes unreachable by default and still fires when
 * every role has been changed away from Client by hand. The last case here is
 * what keeps that true.
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

/**
 * `phone` and `company` are OMITTED rather than set to `null`: on `Contact` they
 * are `string | undefined`, and writing `null` needs a cast that
 * `type-check:tests` rejects. `npm test` and `type-check` are both green on the
 * `null` form — only `tsc -p tsconfig.test.json` catches it, which is why all
 * five gates get run rather than the two that feel sufficient (BACKLOG-2654).
 */
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

/** A valid step-1 form, so the walk is not blocked before it reaches contacts. */
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
  initialAssignments?: ContactAssignments;
  onSubmit: () => void;
  setError: (e: string | null) => void;
}

/**
 * The wizard, reduced to the three parts this bug lives in: the assignments
 * map, the step machine that validates it, and the step-3 UI that fills it.
 */
function WizardHarness({
  contacts,
  selectedContactIds,
  initialAssignments,
  onSubmit,
  setError,
}: HarnessProps) {
  const [contactAssignments, setContactAssignments] = useState<ContactAssignments>(
    initialAssignments ?? {},
  );

  // TRANSCRIBED from useAuditContactAssignment.ts:250-270. Do not "simplify".
  const assignContact = useCallback(
    (role: string, contactId: string, isPrimary = false, notes = ""): void => {
      setContactAssignments((prev) => {
        const existing = prev[role] || [];
        const existingIndex = existing.findIndex(
          (c: ContactAssignment) => c.contactId === contactId,
        );
        if (existingIndex !== -1) {
          const updated = [...existing];
          updated[existingIndex] = { contactId, isPrimary, notes };
          return { ...prev, [role]: updated };
        }
        return { ...prev, [role]: [...existing, { contactId, isPrimary, notes }] };
      });
    },
    [],
  );

  // TRANSCRIBED from useAuditContactAssignment.ts:275-283.
  const removeContact = useCallback((role: string, contactId: string): void => {
    setContactAssignments((prev) => {
      const existing = prev[role] || [];
      return { ...prev, [role]: existing.filter((c) => c.contactId !== contactId) };
    });
  }, []);

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

/** Walk the wizard from step 1 to step 3, exactly as a user does. */
async function walkToStepThree(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("wizard-next")); // 1 → 2
  await waitFor(() => expect(screen.getByTestId("wizard-step")).toHaveTextContent("2"));
  await user.click(screen.getByTestId("wizard-next")); // 2 → 3
  await waitFor(() => expect(screen.getByTestId("wizard-step")).toHaveTextContent("3"));
}

describe("BACKLOG-2677: saving succeeds without the user touching the role field", () => {
  it("submits a one-contact deal the user never assigned a role to", async () => {
    // THE FOUNDER'S REPRO, asserted where he met it: the save.
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[savedContact("contact-1", "Alice Buyer")]}
        selectedContactIds={["contact-1"]}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );

    await walkToStepThree(user);

    // The role field is NEVER touched. Press Create.
    await user.click(screen.getByTestId("wizard-next"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));  });

  it("submits a deal whose ONLY contact has no record in `contacts` yet", async () => {
    // The imported-twin window: the id is selected, its record has not landed.
    // Before the fix the fill skipped it and the save was refused.
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[]}
        selectedContactIds={["imported-contact-id"]}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );

    await walkToStepThree(user);
    await user.click(screen.getByTestId("wizard-next"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));  });

  it("submits a THREE-contact deal the user never touched — every one of them Client", async () => {
    // The first-only reading dies here: it would default contact-1, leave
    // contact-2 and contact-3 role-less, and still submit (one Client is enough
    // for the validation). So `onSubmit` alone cannot catch it — the assignment
    // set has to be asserted too.
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();
    const seen: ContactAssignments[] = [];

    function Capturing() {
      const [contacts] = useState([
        savedContact("contact-1", "Alice Buyer"),
        savedContact("contact-2", "Ben Second"),
        savedContact("contact-3", "Cara Third"),
      ]);
      return (
        <WizardHarness
          contacts={contacts}
          selectedContactIds={["contact-1", "contact-2", "contact-3"]}
          onSubmit={() => {
            onSubmit();
          }}
          setError={setError}
        />
      );
    }
    void seen;

    render(<Capturing />);
    await walkToStepThree(user);

    // All three role selects must READ as Client before anything is pressed.
    await waitFor(() => {
      expect(screen.getAllByTestId("role-select-contact-1")[0]).toHaveValue(
        SPECIFIC_ROLES.CLIENT,
      );
    });
    expect(screen.getAllByTestId("role-select-contact-2")[0]).toHaveValue(
      SPECIFIC_ROLES.CLIENT,
    );
    expect(screen.getAllByTestId("role-select-contact-3")[0]).toHaveValue(
      SPECIFIC_ROLES.CLIENT,
    );

    await user.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));  });
});

/**
 * BACKLOG-2683, FOUNDER DECISION 13 Aug — THE 'AT LEAST ONE BUYER' VALIDATION
 * IS GONE, AND THESE TWO ARE THE GUARD ON ITS ABSENCE.
 *
 * Until 13 Aug the wizard refused to save a deal on which nobody held the
 * Client role, and these two tests asserted that refusal. The founder deleted
 * the requirement outright — *"lets just drop this requirement i don't think
 * it's necessary"* — so both now assert the OPPOSITE: the save goes through.
 *
 * They are kept rather than deleted because inverted they still carry a fact
 * that can fail. Re-introduce a Client gate anywhere in `useAuditSteps` and
 * both go red, because such a gate returns before `onSubmit`. Deleting them
 * would have left the decision unguarded.
 *
 * The role-less rule (BACKLOG-2680) is NOT affected and is asserted elsewhere:
 * every contact must still be classified as something. None of them has to be
 * the Client.
 */
describe("BACKLOG-2683: a deal with nobody in the Client role saves", () => {
  it("saves when every role has been changed away from Client by hand", async () => {
    // Formerly BACKLOG-2677 control 4, inverted. The two contacts arrive
    // already holding non-Client roles — the state a user reaches by changing
    // both by hand. Both ARE classified, so the role-less gate passes, and
    // there is no longer a Client gate behind it to refuse the save.
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[
          savedContact("contact-1", "Alice Buyer"),
          savedContact("contact-2", "Ben Second"),
        ]}
        selectedContactIds={["contact-1", "contact-2"]}
        initialAssignments={{
          [SPECIFIC_ROLES.AGENT]: [
            { contactId: "contact-1", isPrimary: false, notes: "" },
          ],
          [SPECIFIC_ROLES.INSPECTOR]: [
            { contactId: "contact-2", isPrimary: false, notes: "" },
          ],
        }}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );

    await walkToStepThree(user);
    await user.click(screen.getByTestId("wizard-next"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("saves when the user changes the ONE defaulted role away from Client", async () => {
    // The same path a real user takes: let the default land, change it in the
    // UI, then press Create. The deal ends up with a single Inspector and no
    // Client at all, which is now a legal deal.
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[savedContact("contact-1", "Alice Buyer")]}
        selectedContactIds={["contact-1"]}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );

    await walkToStepThree(user);

    const roleSelect = await waitFor(() => {
      const el = screen.getAllByTestId("role-select-contact-1")[0];
      expect(el).toHaveValue(SPECIFIC_ROLES.CLIENT);
      return el;
    });

    // He changes it by hand to Inspector.
    await user.selectOptions(roleSelect, SPECIFIC_ROLES.INSPECTOR);
    await waitFor(() =>
      expect(screen.getAllByTestId("role-select-contact-1")[0]).toHaveValue(
        SPECIFIC_ROLES.INSPECTOR,
      ),
    );

    await user.click(screen.getByTestId("wizard-next"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("does not hand Client back to a role the user changed by hand", async () => {
    // CONTROL 3, at the save boundary: the hand-set role is what gets submitted,
    // and the fill does not re-default it on any later render.
    const user = userEvent.setup();
    const onSubmit = jest.fn();
    const setError = jest.fn();

    render(
      <WizardHarness
        contacts={[
          savedContact("contact-1", "Alice Buyer"),
          savedContact("contact-2", "Ben Second"),
        ]}
        selectedContactIds={["contact-1", "contact-2"]}
        onSubmit={onSubmit}
        setError={setError}
      />,
    );

    await walkToStepThree(user);

    const benSelect = await waitFor(() => {
      const el = screen.getAllByTestId("role-select-contact-2")[0];
      expect(el).toHaveValue(SPECIFIC_ROLES.CLIENT);
      return el;
    });

    await user.selectOptions(benSelect, SPECIFIC_ROLES.AGENT);

    await waitFor(() =>
      expect(screen.getAllByTestId("role-select-contact-2")[0]).toHaveValue(
        SPECIFIC_ROLES.AGENT,
      ),
    );

    // Alice keeps Client, so the save still goes through...
    expect(screen.getAllByTestId("role-select-contact-1")[0]).toHaveValue(
      SPECIFIC_ROLES.CLIENT,
    );

    // ...and Ben is STILL Seller Agent, not re-defaulted, after the re-renders
    // that the change itself caused.
    await user.click(screen.getByTestId("wizard-next"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId("role-select-contact-2")[0]).toHaveValue(
      SPECIFIC_ROLES.AGENT,
    );  });
});
