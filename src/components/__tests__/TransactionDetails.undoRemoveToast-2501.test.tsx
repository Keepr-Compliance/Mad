/**
 * "{Name} removed" undo toast on a transaction (BACKLOG-2501)
 *
 * Founder QA, having passed the BACKLOG-2367 transaction restore round-trip:
 * *"test 2 passed (can we add the same toast here with undo?)"*.
 *
 * `EditContactsModal` reports WHO a save took off the deal (pinned by
 * `EditContactsModal.removedReporting-2501.test.tsx`); this suite pins what
 * `TransactionDetails` does with that report — the toast, and what Undo calls.
 * The modal is stubbed to a button that fires `onSave` with a removal report,
 * which is the same "stub the child, fire its callback" seam
 * `TransactionDetails.attachmentsRefresh.test.tsx` uses.
 *
 * ===========================================================================
 * THE TWO TOMBSTONES ARE INDEPENDENT — AND THAT IS ASSERTED HERE
 * ===========================================================================
 * Undoing a removal from a DEAL must not un-delete the person from the
 * database. `contacts:restore` is therefore asserted NOT to be called: the two
 * tombstones are independent by design and there is a passing DB suite saying
 * so, which a renderer that called both would quietly contradict.
 *
 * Fixture values are reserved-for-documentation only: `example.com`.
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import { NotificationProvider } from "../../contexts/NotificationContext";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team" as const,
    hasAIAddon: true,
    organizationId: "org-123",
    canExport: false,
    canSubmit: true,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { id: "user-456", email: "agent@example.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "agent@example.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("../../contexts/NetworkContext", () => ({
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

jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));

/**
 * The report a save hands back. Two buttons so a single-removal save and a
 * multi-removal save are both drivable, and a third that reports nobody.
 */
const DANA = { contactId: "c-dana", displayName: "Dana Example" };
const OMAR = { contactId: "c-omar", displayName: "Omar Example" };

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock(
  "../transactionDetailsModule/components/modals/EditContactsModal",
  () => ({
    EditContactsModal: (props: any) => (
      <div>
        <button
          data-testid="save-removing-one"
          onClick={() =>
            props.onSave?.(undefined, [
              { contactId: "c-dana", displayName: "Dana Example" },
            ])
          }
        >
          save removing one
        </button>
        <button
          data-testid="save-removing-two"
          onClick={() =>
            props.onSave?.(undefined, [
              { contactId: "c-dana", displayName: "Dana Example" },
              { contactId: "c-omar", displayName: "Omar Example" },
            ])
          }
        >
          save removing two
        </button>
        <button
          data-testid="save-removing-none"
          onClick={() => props.onSave?.(undefined, [])}
        >
          save removing none
        </button>
      </div>
    ),
  }),
);
/* eslint-enable @typescript-eslint/no-explicit-any */

const getAllAttachments = window.api.transactions.getAllAttachments as jest.Mock;

/**
 * Partial fixture, matching `TransactionDetails.attachmentsRefresh.test.tsx`:
 * this suite exercises only the removal toast, so the remaining REQUIRED
 * Transaction columns (message_count, attachment_count, export_status,
 * export_count) are omitted.
 */
const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "742 Example Ave",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
} as unknown as Transaction;

let restoreContact: jest.Mock;
let contactsRestore: jest.Mock;

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  restoreContact = jest.fn();
  contactsRestore = jest.fn();
  (window.api.transactions as any).restoreContact = restoreContact;
  (window.api.transactions as any).getRemovedContacts = jest.fn();
  (window.api.contacts as any).restore = contactsRestore;
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

/** Open the Edit Contacts modal (the stub) and run one of its saves. */
async function saveVia(testId: string): Promise<void> {
  await act(async () => {
    await userEvent.click(screen.getAllByTestId("edit-contacts-button")[0]);
  });
  await act(async () => {
    await userEvent.click(await screen.findByTestId(testId));
  });
}

describe("TransactionDetails — undo toast on removal (BACKLOG-2501)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAllAttachments.mockResolvedValue({ success: true, data: [] });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: {
        ...baseTransaction,
        communications: [],
        contact_assignments: [],
      },
    });
    jest
      .mocked(window.api.contacts.getAll)
      .mockResolvedValue({ success: true, contacts: [] });
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [],
    });
    restoreContact.mockResolvedValue({ success: true, restored: true });
    contactsRestore.mockResolvedValue({ success: true, restored: true });
  });

  it("names the removed party and offers Undo", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());

    await saveVia("save-removing-one");

    await waitFor(() => {
      expect(screen.getByText(`${DANA.displayName} removed`)).toBeInTheDocument();
    });
    expect(screen.getByTestId("notification-action")).toHaveTextContent("Undo");

    // The bland "Contacts updated successfully" is replaced, not stacked on top:
    // the removal toast says strictly more.
    expect(
      screen.queryByText("Contacts updated successfully"),
    ).not.toBeInTheDocument();

    // Undo has not fired yet — without this the next test cannot tell a wired
    // button from a restore that ran on its own.
    expect(restoreContact).not.toHaveBeenCalled();
  });

  it("restores exactly that party on Undo, and does not un-delete the contact", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());

    await saveVia("save-removing-one");
    await waitFor(() => {
      expect(screen.getByText(`${DANA.displayName} removed`)).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId("notification-action"));
    });

    // Identity: this transaction, that contact — the EXISTING restore channel.
    await waitFor(() => {
      expect(restoreContact).toHaveBeenCalledWith("txn-123", "c-dana");
    });
    expect(restoreContact.mock.calls).toEqual([["txn-123", "c-dana"]]);

    // The two tombstones are independent. Undoing a removal from THIS DEAL must
    // not touch the contact's own tombstone.
    expect(contactsRestore).not.toHaveBeenCalled();
  });

  it("restores every removed party when a save removed more than one", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());

    await saveVia("save-removing-two");

    // Plural wording follows the existing move-toast idiom (BACKLOG-2390).
    await waitFor(() => {
      expect(screen.getByText("2 contacts removed")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId("notification-action"));
    });

    // Exact identity SET, both parties, this transaction.
    await waitFor(() => {
      expect(restoreContact).toHaveBeenCalledTimes(2);
    });
    expect(
      restoreContact.mock.calls.map((c) => c[1]).sort(),
    ).toEqual([DANA.contactId, OMAR.contactId].sort());
    expect(restoreContact.mock.calls.every((c) => c[0] === "txn-123")).toBe(true);
  });

  it("raises no removal toast when the save removed nobody", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());

    await saveVia("save-removing-none");

    // The pre-existing save confirmation is untouched...
    await waitFor(() => {
      expect(
        screen.getByText("Contacts updated successfully"),
      ).toBeInTheDocument();
    });
    // ...and no Undo is offered for a removal that did not happen.
    expect(screen.queryByTestId("notification-action")).not.toBeInTheDocument();
    expect(screen.queryByText(/ removed$/)).not.toBeInTheDocument();
  });
});
