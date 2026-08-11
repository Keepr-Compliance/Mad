/**
 * EditContactsModal — reporting who this save took off the deal (BACKLOG-2501)
 *
 * Founder QA, on removing a contact from a transaction: *"can we add the same
 * toast here with undo?"*. The toast is raised by `TransactionDetails`, but only
 * this modal can know WHO left: the removal set is a diff between the
 * assignments loaded on mount and the staged `roleAssignments`, and both die
 * with the modal when it closes. This suite pins the reporting half.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED — AND THAT MATTERED HERE
 * ===========================================================================
 * `makeAssignment` reproduces the actual output of
 * `getTransactionContactsWithRoles`, which is what
 * `transactionService.getTransactionWithContacts` returns as
 * `contact_assignments` and what `transactions:get-details` hands the renderer
 * verbatim (that handler does NOT run `validateResponse`, so nothing is
 * stripped — checked, not assumed). Captured by running that exact SELECT
 * against a real SQLite database built from `electron/database/schema.sql` plus
 * migration v56's two ALTERs. The captured row was:
 *
 *   {
 *     "id": "tc-probe", "transaction_id": "txn-probe", "contact_id": "c-probe",
 *     "role": "listing_agent", "role_category": "agent",
 *     "specific_role": "listing_agent", "is_primary": 1,
 *     "notes": "Primary listing contact",
 *     "created_at": "2026-08-05 05:31:19", "updated_at": "2026-08-05 05:31:19",
 *     "removed_at": null, "removed_reason": null,
 *     "contact_name": "Dana Example", "contact_email": "dana@example.com",
 *     "contact_phone": "+15550100", "contact_company": "Example Realty",
 *     "contact_title": "Broker", "contact_source": "manual",
 *     "contact_email_count": 1, "contact_phone_count": 1
 *   }
 *
 * The sibling suite `EditContactsModal.twoPane.test.tsx` stubs an assignment as
 * `{ id: "a1", contact_id: "db-paul", role: "client" }` — no `contact_name`.
 * Reusing that shape here would have produced a toast reading "No name removed"
 * and looked like a bug in the label rule rather than a hole in the fixture.
 * `contact_name` is ALWAYS set on this row (it is `c.display_name` through a
 * LEFT JOIN, null only for a dangling contact_id), so it belongs in the fixture.
 *
 * ===========================================================================
 * EXACT IDENTITY, NEVER COUNTS
 * ===========================================================================
 * "one contact was reported" is satisfied by reporting the wrong person, and
 * offering Undo for someone who is still on the deal is the defect that would
 * actually hurt. Every assertion names who.
 *
 * Fixture values are reserved-for-documentation only: `example.com` and the
 * `+1 555 01xx` reserved fictional range.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  EditContactsModal,
  type EditContactsModalProps,
  type RemovedTransactionContactSummary,
} from "./EditContactsModal";
import type { Transaction } from "@/types";
import type { ExtendedContact } from "../../../../types/components";

const mockGetDetails = jest.fn();
const mockBatchUpdateContacts = jest.fn();

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getDetails: mockGetDetails,
      batchUpdateContacts: mockBatchUpdateContacts,
    },
  };
});

/**
 * ContactRoleRow renders its controls TWICE — a responsive mobile layout and a
 * desktop one — so its test ids are not unique. Same helper the BACKLOG-1719
 * and BACKLOG-2367 suites use for BulkSelectionBar.
 */
const first = (testId: string) => screen.getAllByTestId(testId)[0];

const TXN_ID = "txn-probe";

/** The renderer-side contact rows the modal resolves assignments against. */
const mockContacts: ExtendedContact[] = [
  {
    id: "c-dana",
    name: "Dana Example",
    display_name: "Dana Example",
    email: "dana@example.com",
    user_id: "user-1",
    source: "contacts_app",
    created_at: "2026-08-01",
    updated_at: "2026-08-01",
  },
  {
    id: "c-omar",
    name: "Omar Example",
    display_name: "Omar Example",
    email: "omar@example.com",
    user_id: "user-1",
    source: "contacts_app",
    created_at: "2026-08-01",
    updated_at: "2026-08-01",
  },
];

// The modal renders OfflineNotice, whose useNetwork() throws without a provider.
jest.mock("../../../../contexts/NetworkContext", () => ({
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

jest.mock("../../../../contexts/ContactsContext", () => ({
  ContactsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useContacts: () => ({
    contacts: mockContacts,
    loading: false,
    error: null,
    refreshContacts: jest.fn(),
    // BACKLOG-2631: the provider carries the address-book half and the shared
    // both-halves refresh now. `Screen2Overlay` calls `triggerLazyLoad` on mount,
    // so a mock without it throws before this suite's subject renders.
    refreshBothLists: jest.fn().mockResolvedValue(undefined),
    externalContacts: [],
    externalContactsLoading: false,
    triggerLazyLoad: jest.fn(),
  }),
}));

/** Transcribed from a real `getTransactionContactsWithRoles` row — see docblock. */
function makeAssignment(o: {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  role?: string;
}) {
  const role = o.role ?? "listing_agent";
  return {
    id: o.id,
    transaction_id: TXN_ID,
    contact_id: o.contact_id,
    role,
    role_category: "agent",
    specific_role: role,
    is_primary: 1,
    notes: "Primary listing contact",
    created_at: "2026-08-05 05:31:19",
    updated_at: "2026-08-05 05:31:19",
    removed_at: null,
    removed_reason: null,
    contact_name: o.contact_name,
    contact_email: o.contact_email,
    contact_phone: "+15550100",
    contact_company: "Example Realty",
    contact_title: "Broker",
    contact_source: "manual",
    contact_email_count: 1,
    contact_phone_count: 1,
  };
}

const DANA_ASSIGNED = makeAssignment({
  id: "tc-dana",
  contact_id: "c-dana",
  contact_name: "Dana Example",
  contact_email: "dana@example.com",
});
const OMAR_ASSIGNED = makeAssignment({
  id: "tc-omar",
  contact_id: "c-omar",
  contact_name: "Omar Example",
  contact_email: "omar@example.com",
  role: "lender",
});

const createTestTransaction = (): Transaction =>
  ({
    id: TXN_ID,
    user_id: "user-1",
    property_address: "742 Example Ave",
    transaction_type: "purchase",
    status: "active",
    created_at: "2026-08-01",
    updated_at: "2026-08-01",
  }) as Transaction;

const createProps = (
  overrides: Partial<EditContactsModalProps> = {},
): EditContactsModalProps => ({
  transaction: createTestTransaction(),
  userId: "user-1",
  onClose: jest.fn(),
  onSave: jest.fn(),
  ...overrides,
});

/** The `removedContacts` argument of the single onSave call. */
function removedArg(
  onSave: jest.Mock,
): RemovedTransactionContactSummary[] | undefined {
  expect(onSave).toHaveBeenCalledTimes(1);
  return onSave.mock.calls[0][1];
}

async function save(): Promise<void> {
  await act(async () => {
    await userEvent.click(screen.getByTestId("edit-contacts-modal-save"));
  });
}

describe("EditContactsModal — removed-party reporting (BACKLOG-2501)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDetails.mockResolvedValue({
      success: true,
      transaction: { contact_assignments: [DANA_ASSIGNED, OMAR_ASSIGNED] },
    });
    mockBatchUpdateContacts.mockResolvedValue({
      success: true,
      autoLinkResults: [],
    });
  });

  it("reports exactly the party taken off the deal, by id and by name", async () => {
    const onSave = jest.fn();
    render(<EditContactsModal {...createProps({ onSave })} />);

    await waitFor(() => {
      expect(first("contact-role-row-c-dana")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(first("remove-contact-c-dana"));
    });
    await save();

    // The persisted removal really was issued, for her.
    await waitFor(() => {
      expect(mockBatchUpdateContacts).toHaveBeenCalled();
    });
    const ops = mockBatchUpdateContacts.mock.calls[0][1] as Array<{
      action: string;
      contactId: string;
    }>;
    expect(
      ops.filter((o) => o.action === "remove").map((o) => o.contactId),
    ).toEqual(["c-dana"]);

    // And the report names HER — not Omar, who is untouched, and not "No name",
    // which is what a fixture missing contact_name would have produced.
    expect(removedArg(onSave)).toEqual([
      { contactId: "c-dana", displayName: "Dana Example" },
    ]);
  });

  it("reports both parties when a save removes two", async () => {
    const onSave = jest.fn();
    render(<EditContactsModal {...createProps({ onSave })} />);

    await waitFor(() => {
      expect(first("contact-role-row-c-dana")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(first("remove-contact-c-dana"));
    });
    await act(async () => {
      await userEvent.click(first("remove-contact-c-omar"));
    });
    await save();

    const removed = removedArg(onSave) ?? [];
    // Exact identity SET, order-independent.
    expect(
      [...removed].sort((a, b) => a.contactId.localeCompare(b.contactId)),
    ).toEqual([
      { contactId: "c-dana", displayName: "Dana Example" },
      { contactId: "c-omar", displayName: "Omar Example" },
    ]);
  });

  it("reports nobody when the save only changes a role", async () => {
    const onSave = jest.fn();
    render(<EditContactsModal {...createProps({ onSave })} />);

    await waitFor(() => {
      expect(screen.getAllByTestId("role-select-c-dana").length).toBeGreaterThan(0);
    });

    // Pick a real alternative from the rendered options rather than hardcoding
    // one: the option set is filtered by transaction type, so a hardcoded role
    // silently stops being selectable when that filter changes.
    const select = first("role-select-c-dana") as HTMLSelectElement;
    const otherRole = Array.from(select.options)
      .map((o) => o.value)
      .find((v) => v && v !== "listing_agent");
    expect(otherRole).toBeDefined();

    // A role change is a remove op for the OLD role plus an add op for the new
    // one — the same "remove" verb a real removal produces. Offering Undo here
    // would invite the user to restore someone who never left.
    await act(async () => {
      await userEvent.selectOptions(select, otherRole as string);
    });
    await save();

    await waitFor(() => {
      expect(mockBatchUpdateContacts).toHaveBeenCalled();
    });
    const ops = mockBatchUpdateContacts.mock.calls[0][1] as Array<{
      action: string;
      contactId: string;
    }>;
    // The remove op IS there — this is the case that would fool a naive read.
    expect(
      ops.filter((o) => o.action === "remove").map((o) => o.contactId),
    ).toEqual(["c-dana"]);
    // ...and she is added straight back under the new role.
    expect(
      ops.filter((o) => o.action === "add").map((o) => o.contactId),
    ).toEqual(["c-dana"]);
    // So nothing is reported as removed from the deal.
    expect(removedArg(onSave)).toEqual([]);
  });

  it("reports nobody when the save removes nobody", async () => {
    const onSave = jest.fn();
    render(<EditContactsModal {...createProps({ onSave })} />);

    await waitFor(() => {
      expect(first("contact-role-row-c-dana")).toBeInTheDocument();
    });
    await save();

    expect(removedArg(onSave)).toEqual([]);
  });
});
