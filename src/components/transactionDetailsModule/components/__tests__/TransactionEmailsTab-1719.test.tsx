/**
 * RTL Tests — BACKLOG-1719: Emails tab active-list bulk REMOVE
 *
 * Verifies the multi-select bulk-remove flow on the active email list:
 *  - selecting threads reveals the floating bulk bar,
 *  - Remove → confirm dialog with the right "N conversations (M emails)?" copy,
 *  - the FROZEN unlinkCommunication IPC is looped once per constituent backend
 *    thread across all selections (generalised BACKLOG-1781 pattern),
 *  - a SINGLE in-place removal (onRemoveEmailsByIds) and ONE toast,
 *  - single-remove (non-selection) flow is unchanged.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import type { Communication } from "../../types";

// useAuth is only used for currentUser (email + id). Mock it so no AuthProvider
// is required. Path resolves to src/contexts (same module the component imports).
jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const first = (testId: string) => screen.getAllByTestId(testId)[0];

// Two active email cards:
//  - "Offer" card groups e-1 + e-2 by normalised subject (both thread_id null →
//    TWO distinct backend representatives inside one card).
//  - "Inspection" card is a single thread (thread_id t-ccc).
function makeComms(): Communication[] {
  const base = {
    user_id: "user-1",
    created_at: "2024-01-01T00:00:00Z",
    has_attachments: false,
    is_false_positive: false,
  };
  return [
    { ...base, id: "e-1", subject: "Offer", sender: "alice@example.com", recipients: "me@example.com", sent_at: "2024-01-10T10:00:00Z" },
    { ...base, id: "e-2", subject: "Re: Offer", sender: "alice@example.com", recipients: "me@example.com", sent_at: "2024-01-11T10:00:00Z" },
    { ...base, id: "e-3", subject: "Inspection", sender: "bob@example.com", recipients: "me@example.com", thread_id: "t-ccc", sent_at: "2024-01-12T10:00:00Z" },
  ] as Communication[];
}

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).unlinkCommunication = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.transactions.unlinkCommunication as jest.Mock).mockImplementation(
    async (cid: string) => ({ success: true, unlinkedIds: [cid] })
  );
});

describe("TransactionEmailsTab — BACKLOG-1719 bulk remove", () => {
  it("loops unlinkCommunication once per constituent thread and removes in place once", async () => {
    const onRemoveEmailsByIds = jest.fn((ids: string[]) => ids.length);
    const onShowSuccess = jest.fn();

    render(
      <TransactionEmailsTab
        communications={makeComms()}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        onRemoveEmailsByIds={onRemoveEmailsByIds}
        onShowSuccess={onShowSuccess}
      />
    );

    // Two active cards, no checkboxes until selection mode.
    expect(screen.getAllByTestId("email-thread-card")).toHaveLength(2);
    expect(screen.queryByTestId("email-thread-select")).not.toBeInTheDocument();

    // Enter selection mode → checkboxes appear on both cards.
    await userEvent.click(screen.getByTestId("select-emails-button"));
    expect(screen.getAllByTestId("email-thread-select")).toHaveLength(2);

    // Select both cards.
    for (const cb of screen.getAllByTestId("email-thread-select")) {
      await userEvent.click(cb);
    }

    // Open the confirm dialog from the floating bar.
    await userEvent.click(first("emails-bulk-remove"));
    expect(screen.getByTestId("bulk-remove-confirm-title")).toHaveTextContent(
      "Remove 2 conversations (3 emails)?"
    );

    // Confirm.
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });

    await waitFor(() => {
      // 3 distinct backend threads across 2 selected cards → 3 IPC calls.
      expect(window.api.transactions.unlinkCommunication).toHaveBeenCalledTimes(3);
    });
    const calledWith = (window.api.transactions.unlinkCommunication as jest.Mock).mock.calls.map((c) => c[0]);
    expect(new Set(calledWith)).toEqual(new Set(["e-1", "e-2", "e-3"]));

    // ONE in-place removal with all aggregated unlinked ids, ONE toast.
    expect(onRemoveEmailsByIds).toHaveBeenCalledTimes(1);
    expect(new Set(onRemoveEmailsByIds.mock.calls[0][0])).toEqual(new Set(["e-1", "e-2", "e-3"]));
    expect(onShowSuccess).toHaveBeenCalledWith("3 emails removed");

    // Selection mode exits after the bulk action.
    expect(screen.queryByTestId("email-thread-select")).not.toBeInTheDocument();
  });

  it("Select All selects every visible thread", async () => {
    render(
      <TransactionEmailsTab
        communications={makeComms()}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        onRemoveEmailsByIds={jest.fn((ids: string[]) => ids.length)}
        onShowSuccess={jest.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("select-emails-button"));
    // Use the bar's Select All (desktop layout first).
    await userEvent.click(screen.getAllByText("Select All")[0]);

    await userEvent.click(first("emails-bulk-remove"));
    // Both conversations (3 emails) selected via Select All.
    expect(screen.getByTestId("bulk-remove-confirm-title")).toHaveTextContent(
      "Remove 2 conversations (3 emails)?"
    );
  });

  it("founder design: Select sits on the address-filter row to its LEFT, with the edit icon", () => {
    render(
      <TransactionEmailsTab
        communications={makeComms()}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        hasContacts
        onToggleAddressFilter={jest.fn()}
      />
    );

    const selectBtn = screen.getByTestId("select-emails-button");
    const addressToggle = screen.getByTestId("address-filter-toggle");

    // Same row: the Select button's parent (the control row) also holds the filter.
    expect(selectBtn.parentElement).toBeTruthy();
    expect(selectBtn.parentElement).toContainElement(addressToggle);

    // Select comes before the filter toggle in DOM order (i.e. to its LEFT).
    expect(selectBtn.compareDocumentPosition(addressToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Edit icon matches the transaction-window bulk-edit button size (w-5 h-5).
    const icon = selectBtn.querySelector("svg");
    expect(icon).toBeInTheDocument();
    expect(icon?.getAttribute("class") || "").toContain("w-5");
    expect(icon?.getAttribute("class") || "").toContain("h-5");
  });

  it("single-remove (non-selection) flow is unchanged — uses onShowUnlinkThread", async () => {
    const onShowUnlinkThread = jest.fn();

    render(
      <TransactionEmailsTab
        communications={makeComms()}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        onShowUnlinkThread={onShowUnlinkThread}
        userId="user-1"
        transactionId="txn-1"
      />
    );

    // Per-card remove buttons are visible outside selection mode.
    const removeButtons = screen.getAllByTestId("unlink-thread-button");
    expect(removeButtons.length).toBeGreaterThan(0);
    await userEvent.click(removeButtons[0]);
    expect(onShowUnlinkThread).toHaveBeenCalledTimes(1);

    // unlinkCommunication is NOT invoked by the single path here (parent owns it).
    expect(window.api.transactions.unlinkCommunication).not.toHaveBeenCalled();
  });
});
