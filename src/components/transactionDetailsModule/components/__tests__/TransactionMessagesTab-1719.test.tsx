/**
 * RTL Tests — BACKLOG-1719: Texts tab active-list bulk REMOVE
 *
 * Verifies the multi-select bulk-remove flow on the active text list:
 *  - selecting conversations reveals the floating bulk bar,
 *  - Remove → confirm dialog with the right "N conversations (M texts)?" copy,
 *  - ONE unlinkMessages IPC call with every selected conversation's message IDs
 *    aggregated (texts already have a bulk IPC — no per-thread loop),
 *  - a single in-place removal (onRemoveMessagesByIds) + one toast,
 *  - single-remove (non-selection) flow is unchanged.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

const first = (testId: string) => screen.getAllByTestId(testId)[0];

// Two active conversations: thread-1 (msg-1, msg-2) and thread-2 (msg-3),
// different external numbers so they render as two separate cards.
const mockMessages: Partial<Communication>[] = [
  {
    id: "msg-1", user_id: "u", channel: "sms", body_text: "Hi about the property",
    sent_at: "2024-01-16T11:00:00Z", direction: "inbound", thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    has_attachments: false, is_false_positive: false,
  },
  {
    id: "msg-2", user_id: "u", channel: "imessage", body_text: "Schedule a showing?",
    sent_at: "2024-01-17T12:00:00Z", direction: "outbound", thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550101", to: ["+14155550100"] }),
    has_attachments: false, is_false_positive: false,
  },
  {
    id: "msg-3", user_id: "u", channel: "sms", body_text: "Thanks!",
    sent_at: "2024-01-19T09:00:00Z", direction: "inbound", thread_id: "thread-2",
    participants: JSON.stringify({ from: "+14155550200", to: ["+14155550101"] }),
    has_attachments: false, is_false_positive: false,
  },
];

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).unlinkMessages = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.contacts as any).resolveHandles = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.transactions.unlinkMessages as jest.Mock).mockResolvedValue({ success: true });
  (window.api.contacts.resolveHandles as jest.Mock).mockResolvedValue({ success: true, names: {} });
});

describe("TransactionMessagesTab — BACKLOG-1719 bulk remove", () => {
  it("removes all selected conversations with ONE unlinkMessages call", async () => {
    const onRemoveMessagesByIds = jest.fn();
    const onShowSuccess = jest.fn();

    render(
      <TransactionMessagesTab
        messages={mockMessages as Communication[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-1"
        onRemoveMessagesByIds={onRemoveMessagesByIds}
        onShowSuccess={onShowSuccess}
      />
    );

    // Two active cards; no checkboxes until selection mode.
    await waitFor(() => expect(screen.getAllByTestId("message-thread-card")).toHaveLength(2));
    expect(screen.queryByTestId("message-thread-select")).not.toBeInTheDocument();

    // Enter selection mode → checkboxes appear.
    await userEvent.click(screen.getByTestId("select-messages-button"));
    expect(screen.getAllByTestId("message-thread-select")).toHaveLength(2);

    // Select both conversations.
    for (const cb of screen.getAllByTestId("message-thread-select")) {
      await userEvent.click(cb);
    }

    // Confirm dialog copy.
    await userEvent.click(first("messages-bulk-remove"));
    expect(screen.getByTestId("bulk-remove-confirm-title")).toHaveTextContent(
      "Remove 2 conversations (3 texts)?"
    );

    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });

    await waitFor(() => {
      expect(window.api.transactions.unlinkMessages).toHaveBeenCalledTimes(1);
    });
    const [ids, txId] = (window.api.transactions.unlinkMessages as jest.Mock).mock.calls[0];
    expect(new Set(ids)).toEqual(new Set(["msg-1", "msg-2", "msg-3"]));
    expect(txId).toBe("txn-1");

    expect(onRemoveMessagesByIds).toHaveBeenCalledTimes(1);
    expect(new Set(onRemoveMessagesByIds.mock.calls[0][0])).toEqual(new Set(["msg-1", "msg-2", "msg-3"]));
    expect(onShowSuccess).toHaveBeenCalledWith("2 conversations removed");

    // Selection mode exits after the bulk action.
    expect(screen.queryByTestId("message-thread-select")).not.toBeInTheDocument();
  });

  it("founder design: Select sits on the audit-period filter row to its LEFT, with the edit icon", async () => {
    render(
      <TransactionMessagesTab
        messages={mockMessages as Communication[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-1"
        auditStartDate="2024-01-01"
        auditEndDate="2024-12-31"
        onShowSuccess={jest.fn()}
      />
    );

    await waitFor(() => expect(screen.getByTestId("select-messages-button")).toBeInTheDocument());
    const selectBtn = screen.getByTestId("select-messages-button");
    const auditFilter = screen.getByTestId("audit-period-filter");

    // Same row: the Select button's parent (the control row) also holds the filter.
    expect(selectBtn.parentElement).toContainElement(auditFilter);
    // Select comes before the filter in DOM order (i.e. to its LEFT).
    expect(selectBtn.compareDocumentPosition(auditFilter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Edit icon matches the transaction-window bulk-edit button size (w-5 h-5).
    const icon = selectBtn.querySelector("svg");
    expect(icon).toBeInTheDocument();
    expect(icon?.getAttribute("class") || "").toContain("w-5");
    expect(icon?.getAttribute("class") || "").toContain("h-5");
  });

  it("single-remove (non-selection) flow is unchanged — opens the unlink modal", async () => {
    render(
      <TransactionMessagesTab
        messages={mockMessages as Communication[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-1"
        onShowSuccess={jest.fn()}
      />
    );

    await waitFor(() => expect(screen.getAllByTestId("message-thread-card")).toHaveLength(2));

    // Per-card remove buttons visible outside selection mode.
    const removeButtons = screen.getAllByTestId("unlink-thread-button");
    await userEvent.click(removeButtons[0]);

    // The single-unlink confirmation modal appears (not a bulk call yet).
    expect(screen.getByText("Remove Messages from Transaction?")).toBeInTheDocument();
    expect(window.api.transactions.unlinkMessages).not.toHaveBeenCalled();
  });
});
