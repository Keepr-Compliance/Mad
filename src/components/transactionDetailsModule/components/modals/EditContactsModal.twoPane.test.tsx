/**
 * EditContactsModal — two-pane integration tests (BACKLOG-2405)
 *
 * Unlike EditContactsModal.test.tsx (which mocks ContactSearchList), this suite
 * renders the REAL ContactSearchList + ContactRow + ContactAssignmentStep so it
 * exercises the actual assemble/dedup pipeline. It proves the founder-QA leak
 * fix: an assigned contact that ALSO exists in the address book (external twin
 * with a DIFFERENT id, name-only so no email/phone can bridge them) must NOT
 * appear in "Available".
 *
 * Root cause it guards: the old Screen2Overlay STRIPPED assigned DB contacts from
 * the array fed to the picker, so assembleDedupedContacts had nothing to dedup
 * the external twin against and the twin leaked into Available. The fix keeps the
 * assigned contact in `contacts` (and seeds it into the selection), so the twin
 * dedups out (identity) and the contact shows only as an Added chip.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EditContactsModal, EditContactsModalProps } from "./EditContactsModal";
import type { Transaction } from "@/types";
import type { ExtendedContact } from "../../../../types/components";
import userEvent from "@testing-library/user-event";

const mockGetDetails = jest.fn();
const mockBatchUpdateContacts = jest.fn();
const mockGetAvailable = jest.fn();

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getDetails: mockGetDetails,
      batchUpdateContacts: mockBatchUpdateContacts,
    },
    contacts: {
      getAvailable: mockGetAvailable,
    },
  };
});

// A contact ALREADY assigned to the deal, imported with TWO emails. getAvailable
// only matches on the PRIMARY email, so an address-book entry under the SECONDARY
// email (paul@home.com) is not recognized as already-imported and is returned —
// the realistic id-swap leak. (allEmails carries both, so the frontend dedup CAN
// bridge them once the DB row is present.)
const assignedTwoEmail: ExtendedContact = {
  id: "db-paul",
  name: "Paul Multi",
  display_name: "Paul Multi",
  email: "paul@work.com",
  allEmails: ["paul@work.com", "paul@home.com"],
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-02-01",
  updated_at: "2024-02-01",
};

const janeUnassigned: ExtendedContact = {
  id: "c-jane",
  name: "Jane Doe",
  display_name: "Jane Doe",
  email: "jane@example.com",
  user_id: "user-1",
  source: "manual",
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
};

// The address-book twin of the assigned contact: SAME person, DIFFERENT id, and
// carrying only the SECONDARY email — so getAvailable's primary-email filter
// missed it. Same source profile as the working contacts so the category filter
// treats it identically; the ONLY thing that can hide it from Available is the
// dedup against the DB row.
const externalTwin: ExtendedContact = {
  id: "ext-paul",
  name: "Paul Multi",
  display_name: "Paul Multi",
  email: "paul@home.com",
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-02-01",
  updated_at: "2024-02-01",
};

// A genuinely-new address-book contact (matches nobody). Used purely as a
// deterministic "externals have loaded" signal so the leak assertion never races
// the async getAvailable — she appears in Available on BOTH old and fixed code.
const externalNew: ExtendedContact = {
  id: "ext-zoe",
  name: "Zoe New",
  display_name: "Zoe New",
  email: "zoe@example.com",
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-03-01",
  updated_at: "2024-03-01",
};

jest.mock("../../../../contexts/ContactsContext", () => ({
  ContactsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useContacts: () => ({
    contacts: [assignedTwoEmail, janeUnassigned],
    loading: false,
    error: null,
    refreshContacts: jest.fn(),
    silentRefresh: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Screen 1 / Step 3 role rows are not under test here — mock them to keep the
// suite focused on the real Available/Added two-pane (ContactSearchList).
jest.mock("../../../shared/ContactRoleRow", () => ({
  ContactRoleRow: ({ contact }: { contact: ExtendedContact }) => (
    <div data-testid={`contact-role-row-${contact.id}`}>{contact.display_name}</div>
  ),
}));

jest.mock("../../../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

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

const createTestTransaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    id: "txn-1",
    user_id: "user-1",
    property_address: "123 Main St",
    transaction_type: "purchase",
    status: "active",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    ...overrides,
  }) as Transaction;

const createDefaultProps = (
  overrides: Partial<EditContactsModalProps> = {},
): EditContactsModalProps => ({
  transaction: createTestTransaction(),
  userId: "user-1",
  onClose: jest.fn(),
  onSave: jest.fn(),
  ...overrides,
});

const availableNames = (): string[] =>
  screen.queryAllByTestId("contact-row").map((r) => r.textContent || "");

describe("EditContactsModal two-pane (BACKLOG-2405, real ContactSearchList)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The deal already has the name-only contact assigned.
    mockGetDetails.mockResolvedValue({
      success: true,
      transaction: {
        contact_assignments: [{ id: "a1", contact_id: "db-paul", role: "client" }],
      },
    });
    // The address book returns the twin (its strong-id filter let a name-only
    // contact through) plus a genuinely-new contact used as a load signal.
    mockGetAvailable.mockResolvedValue({
      success: true,
      contacts: [externalTwin, externalNew],
    });
    mockBatchUpdateContacts.mockResolvedValue({ success: true, autoLinkResults: [] });
  });

  it("does NOT leak an assigned contact's external twin into Available; shows it only as an Added chip", async () => {
    const user = userEvent.setup();
    render(<EditContactsModal {...createDefaultProps()} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("add-contacts-button"));

    // Wait until the async address-book load has landed AND been deduped — the
    // genuinely-new "Zoe New" appears on both old and fixed code, so this is a
    // race-free signal that externals are rendered before we assert the leak.
    await waitFor(() => {
      expect(availableNames().some((n) => n.includes("Zoe New"))).toBe(true);
    });
    expect(availableNames().some((n) => n.includes("Jane Doe"))).toBe(true);

    // THE LEAK FIX: "Paul Multi" (the assigned contact) must NOT appear in the
    // Available list — neither its DB row (excluded by selection) nor its
    // address-book twin (deduped by shared allEmails now that the DB row is
    // present). On the pre-fix code the twin survived here.
    expect(availableNames().some((n) => n.includes("Paul Multi"))).toBe(false);

    // It IS pre-populated as a removable Added chip (single representation).
    expect(screen.getByTestId("added-chip-db-paul")).toBeInTheDocument();
  });

  it("removing the pre-populated existing chip returns nothing to Available for it and unlinks on Save", async () => {
    const user = userEvent.setup();
    render(<EditContactsModal {...createDefaultProps()} />);

    await waitFor(() => {
      expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("add-contacts-button"));

    await waitFor(() => {
      expect(screen.getByTestId("added-chip-db-paul")).toBeInTheDocument();
    });

    // ✕ the existing contact.
    await user.click(screen.getByTestId("remove-added-db-paul"));
    expect(screen.queryByTestId("added-chip-db-paul")).not.toBeInTheDocument();

    // Close overlay, Save -> a remove op for db-paul, never a re-add.
    await user.click(screen.getByTestId("add-contacts-overlay-close"));
    await waitFor(() => {
      expect(screen.getByTestId("edit-contacts-modal-save")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("edit-contacts-modal-save"));

    await waitFor(() => {
      expect(mockBatchUpdateContacts).toHaveBeenCalled();
    });
    const ops = mockBatchUpdateContacts.mock.calls[0][1] as Array<{
      action: string;
      contactId: string;
    }>;
    expect(ops.some((o) => o.action === "remove" && o.contactId === "db-paul")).toBe(true);
    expect(ops.some((o) => o.action === "add" && o.contactId === "db-paul")).toBe(false);
  });
});
