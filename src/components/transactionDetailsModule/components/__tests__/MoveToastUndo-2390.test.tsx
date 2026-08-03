/**
 * RTL Tests — BACKLOG-2390: Undo action on email/message move toasts
 *
 * The move toasts fired when emails/texts move between the transaction-detail
 * sections now carry an "Undo" action. These tests assert that invoking the
 * captured Undo action calls the correct EXISTING inverse IPC with the EXACT ids
 * that moved:
 *   - Messages attach  → Undo calls unlinkMessages(attachedIds)
 *   - Messages remove  → Undo restores via getRemovedMessages + restoreRemovedMessage
 *   - Messages bulk rm  → Undo restores every moved id
 *   - Emails bulk rm    → Undo restores via getRemovedEmails + restoreRemovedEmail
 * Plus a render test for the Toast action button itself.
 *
 * The tabs hand the action to onShowSuccess (the parent toast system); these
 * tests capture that action from the onShowSuccess mock and invoke its onClick,
 * exactly as the rendered Undo button would.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import { NotificationToast } from "../../../ui/Notification/NotificationToast";
import type {
  NotificationAction,
  NotificationOptions,
} from "../../../ui/Notification/types";
import type { Communication } from "../../types";

// TransactionEmailsTab pulls currentUser from useAuth — mock it (no provider).
jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const first = (testId: string) => screen.getAllByTestId(testId)[0];

/**
 * Pull the action that was passed alongside a given success message.
 * BACKLOG-2447: the second argument is now the `NotificationOptions` bag
 * (`{ action }`) rather than a bare action, matching `notify.success`.
 */
function actionForMessage(
  mock: jest.Mock,
  message: string
): NotificationAction | undefined {
  const call = mock.mock.calls.find((c) => c[0] === message);
  return (call?.[1] as NotificationOptions | undefined)?.action;
}

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        // messages
        linkMessages: jest.fn(),
        unlinkMessages: jest.fn(),
        getRemovedMessages: jest.fn(),
        restoreRemovedMessage: jest.fn(),
        getMessageContacts: jest.fn(),
        getMessagesByContact: jest.fn(),
        // emails
        unlinkCommunication: jest.fn(),
        getRemovedEmails: jest.fn(),
        restoreRemovedEmail: jest.fn(),
      },
      contacts: {
        resolveHandles: jest.fn(),
        getAll: jest.fn(),
      },
    },
    writable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  const t = window.api.transactions as unknown as Record<string, jest.Mock>;
  const c = window.api.contacts as unknown as Record<string, jest.Mock>;
  c.resolveHandles.mockResolvedValue({ success: true, names: {} });
  c.getAll.mockResolvedValue({ success: true, contacts: [] });
  t.unlinkMessages.mockResolvedValue({ success: true });
  t.restoreRemovedMessage.mockResolvedValue({ success: true });
  t.linkMessages.mockResolvedValue({ success: true });
  t.restoreRemovedEmail.mockResolvedValue({ success: true });
});

// ---------------------------------------------------------------------------
// Messages — a single conversation (thread-1) with two messages.
// ---------------------------------------------------------------------------
const singleThread: Partial<Communication>[] = [
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
];

describe("BACKLOG-2390 — messages remove-undo (single)", () => {
  it("Undo restores the exact removed message ids via restoreRemovedMessage", async () => {
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;
    // After the remove, the moved messages surface as one suppression row (ig-1).
    t.getRemovedMessages.mockResolvedValue({
      success: true,
      removedMessages: [
        { ignored_id: "ig-1", message_id: "msg-1" },
        { ignored_id: "ig-1", message_id: "msg-2" },
      ],
    });
    const onShowSuccess = jest.fn();
    const onRemoveMessagesByIds = jest.fn();

    render(
      <TransactionMessagesTab
        messages={singleThread as Communication[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-1"
        onRemoveMessagesByIds={onRemoveMessagesByIds}
        onShowSuccess={onShowSuccess}
      />
    );

    await waitFor(() => expect(screen.getByTestId("unlink-thread-button")).toBeInTheDocument());

    // Remove the conversation.
    await act(async () => {
      await userEvent.click(screen.getByTestId("unlink-thread-button"));
    });
    await act(async () => {
      await userEvent.click(screen.getByTestId("unlink-confirm-button"));
    });

    await waitFor(() =>
      expect(onShowSuccess).toHaveBeenCalledWith(
        "Messages removed from transaction",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
      )
    );

    // Invoke the captured Undo action, as clicking the toast button would.
    const undo = actionForMessage(onShowSuccess, "Messages removed from transaction");
    await act(async () => {
      undo?.onClick();
    });

    await waitFor(() => {
      expect(t.getRemovedMessages).toHaveBeenCalledWith("txn-1");
      expect(t.restoreRemovedMessage).toHaveBeenCalledWith(
        "ig-1",
        expect.arrayContaining(["msg-1", "msg-2"]),
        "txn-1"
      );
    });
    // The undo confirmation toast must NOT itself carry an action (no loop).
    expect(onShowSuccess).toHaveBeenCalledWith("Move undone");
    const undoneCall = onShowSuccess.mock.calls.find((c) => c[0] === "Move undone");
    expect(undoneCall?.[1]).toBeUndefined();
  });
});

describe("BACKLOG-2390 — messages bulk remove-undo", () => {
  it("Undo restores every moved id across the removed suppression rows", async () => {
    const twoThreads: Partial<Communication>[] = [
      ...singleThread,
      {
        id: "msg-3", user_id: "u", channel: "sms", body_text: "Thanks!",
        sent_at: "2024-01-19T09:00:00Z", direction: "inbound", thread_id: "thread-2",
        participants: JSON.stringify({ from: "+14155550200", to: ["+14155550101"] }),
        has_attachments: false, is_false_positive: false,
      },
    ];
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;
    t.getRemovedMessages.mockResolvedValue({
      success: true,
      removedMessages: [
        { ignored_id: "ig-1", message_id: "msg-1" },
        { ignored_id: "ig-1", message_id: "msg-2" },
        { ignored_id: "ig-2", message_id: "msg-3" },
      ],
    });
    const onShowSuccess = jest.fn();

    render(
      <TransactionMessagesTab
        messages={twoThreads as Communication[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-1"
        onRemoveMessagesByIds={jest.fn()}
        onShowSuccess={onShowSuccess}
      />
    );

    await waitFor(() => expect(screen.getAllByTestId("message-thread-card")).toHaveLength(2));

    await userEvent.click(screen.getByTestId("select-messages-button"));
    for (const cb of screen.getAllByTestId("message-thread-select")) {
      await userEvent.click(cb);
    }
    await userEvent.click(first("messages-bulk-remove"));
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });

    await waitFor(() =>
      expect(onShowSuccess).toHaveBeenCalledWith(
        "2 conversations removed",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
      )
    );

    const undo = actionForMessage(onShowSuccess, "2 conversations removed");
    await act(async () => {
      undo?.onClick();
    });

    await waitFor(() => {
      // One restore call per suppression row, each with its own message ids.
      expect(t.restoreRemovedMessage).toHaveBeenCalledWith("ig-1", expect.arrayContaining(["msg-1", "msg-2"]), "txn-1");
      expect(t.restoreRemovedMessage).toHaveBeenCalledWith("ig-2", ["msg-3"], "txn-1");
    });
  });
});

describe("BACKLOG-2390 — messages attach-undo", () => {
  it("Undo unlinks the exact ids that were just attached", async () => {
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;
    t.getMessageContacts.mockResolvedValue({
      success: true,
      contacts: [
        { contact: "+14155550100", contactName: "John Doe", messageCount: 2, lastMessageAt: "2024-01-18T10:00:00Z" },
      ],
    });
    t.getMessagesByContact.mockResolvedValue({
      success: true,
      messages: [
        { id: "msg-1", user_id: "u", channel: "sms", body_text: "Hello", sent_at: "2024-01-16T11:00:00Z", direction: "inbound", thread_id: "thread-1", participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }) },
        { id: "msg-2", user_id: "u", channel: "imessage", body_text: "Reply", sent_at: "2024-01-17T12:00:00Z", direction: "outbound", thread_id: "thread-1", participants: JSON.stringify({ from: "+14155550101", to: ["+14155550100"] }) },
      ],
    });
    const onShowSuccess = jest.fn();

    render(
      <TransactionMessagesTab
        messages={[]}
        loading={false}
        error={null}
        userId="user-1"
        transactionId="txn-1"
        onMessagesChanged={jest.fn()}
        onRemoveMessagesByIds={jest.fn()}
        onShowSuccess={onShowSuccess}
      />
    );

    // Open the attach modal from the empty-state button.
    await userEvent.click(screen.getByTestId("attach-messages-button"));

    // Pick the contact, then its conversation, then attach.
    await waitFor(() => expect(screen.getByText("John Doe")).toBeInTheDocument());
    await userEvent.click(screen.getByText("John Doe"));
    await waitFor(() => expect(screen.getByTestId("thread-thread-1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("thread-thread-1"));
    await act(async () => {
      await userEvent.click(screen.getByTestId("attach-button"));
    });

    await waitFor(() =>
      expect(onShowSuccess).toHaveBeenCalledWith(
        "Messages attached successfully",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
      )
    );
    expect(t.linkMessages).toHaveBeenCalledWith(
      expect.arrayContaining(["msg-1", "msg-2"]),
      "txn-1"
    );

    // Invoke Undo → unlinkMessages with the exact attached ids.
    const undo = actionForMessage(onShowSuccess, "Messages attached successfully");
    await act(async () => {
      undo?.onClick();
    });

    await waitFor(() =>
      expect(t.unlinkMessages).toHaveBeenCalledWith(
        expect.arrayContaining(["msg-1", "msg-2"]),
        "txn-1"
      )
    );
  });
});

describe("BACKLOG-2390 — emails bulk remove-undo", () => {
  it("Undo restores the exact removed email ids via restoreRemovedEmail", async () => {
    const t = window.api.transactions as unknown as Record<string, jest.Mock>;
    t.unlinkCommunication.mockImplementation(async (cid: string) => ({ success: true, unlinkedIds: [cid] }));
    t.getRemovedEmails.mockResolvedValue({
      success: true,
      removedEmails: [
        { ignored_id: "ie-1", email_id: "e-1" },
        { ignored_id: "ie-2", email_id: "e-3" },
      ],
    });

    const base = { user_id: "user-1", created_at: "2024-01-01T00:00:00Z", has_attachments: false, is_false_positive: false };
    const comms = [
      { ...base, id: "e-1", subject: "Offer", sender: "alice@example.com", recipients: "me@example.com", sent_at: "2024-01-10T10:00:00Z" },
      { ...base, id: "e-3", subject: "Inspection", sender: "bob@example.com", recipients: "me@example.com", thread_id: "t-ccc", sent_at: "2024-01-12T10:00:00Z" },
    ] as Communication[];

    const onShowSuccess = jest.fn();

    render(
      <TransactionEmailsTab
        communications={comms}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
        onRemoveEmailsByIds={jest.fn((ids: string[]) => ids.length)}
        onShowSuccess={onShowSuccess}
      />
    );

    await userEvent.click(screen.getByTestId("select-emails-button"));
    for (const cb of screen.getAllByTestId("email-thread-select")) {
      await userEvent.click(cb);
    }
    await userEvent.click(first("emails-bulk-remove"));
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });

    await waitFor(() =>
      expect(onShowSuccess).toHaveBeenCalledWith(
        "2 emails removed",
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })
      )
    );

    const undo = actionForMessage(onShowSuccess, "2 emails removed");
    await act(async () => {
      undo?.onClick();
    });

    await waitFor(() => {
      expect(t.getRemovedEmails).toHaveBeenCalledWith("txn-1");
      expect(t.restoreRemovedEmail).toHaveBeenCalledWith("ie-1", "e-1", "txn-1");
      expect(t.restoreRemovedEmail).toHaveBeenCalledWith("ie-2", "e-3", "txn-1");
    });
  });
});

describe("BACKLOG-2390 — Toast action button", () => {
  // BACKLOG-2447: these now exercise NotificationToast. The dismiss-on-action
  // behaviour asserted below did NOT exist in NotificationToast before the
  // migration — it was carried over from the deleted Toast.tsx. Without it a
  // second click on "Undo" replays the undo against already-restored emails.
  it("renders the action and runs onClick then dismisses when clicked", async () => {
    const onClick = jest.fn();
    const onDismiss = jest.fn();

    render(
      <NotificationToast
        notification={{
          id: "toast-1",
          type: "success",
          message: "Emails removed",
          duration: 0,
          action: { label: "Undo", onClick },
        }}
        onDismiss={onDismiss}
      />
    );

    const btn = screen.getByTestId("notification-action");
    expect(btn).toHaveTextContent("Undo");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("toast-1");
  });

  it("renders no action button when the toast has no action", () => {
    render(
      <NotificationToast
        notification={{
          id: "toast-2",
          type: "success",
          message: "Saved",
          duration: 0,
        }}
        onDismiss={jest.fn()}
      />
    );
    expect(screen.queryByTestId("notification-action")).not.toBeInTheDocument();
  });
});
