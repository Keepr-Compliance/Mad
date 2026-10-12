/**
 * BACKLOG-3910 (fix-up round 3): a locked deal is fully read-only, so its LINKED
 * email and text lists cannot be edited either.
 *
 *   L1  Emails tab: Select and the per-thread remove are disabled with the tooltip.
 *   L2  Texts tab: Select and the per-conversation remove are disabled with the tooltip.
 *   L3  Conversation view: Hide / Unhide is disabled with the tooltip.
 *   L4  Bulk email remove never claims success when the main process refuses.
 *   L5  Single email remove shows the refusal reason, not "please try again".
 *
 * Each UI pair is an open case beside a locked case, so a control that is always
 * disabled, or never disabled, fails one of the two.
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act, renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../../../contexts/NotificationContext";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import { ConversationViewModal } from "../modals/ConversationViewModal";
import { useTransactionCommunications } from "../../hooks/useTransactionCommunications";
import { DEAL_LOCK_EDIT_TOOLTIP } from "../../../../utils/dealLock";
import type { Communication } from "../../types";

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper: NotificationProvider });

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const LOCK = DEAL_LOCK_EDIT_TOOLTIP.submitted;
const REFUSAL = "This deal is with your broker for review, so it can't be changed until it's returned to you.";

const base = {
  user_id: "user-1",
  created_at: "2024-01-01T00:00:00Z",
  has_attachments: false,
  is_false_positive: false,
};
const EMAILS = [
  { ...base, id: "e-1", subject: "Offer", sender: "alice@example.com", recipients: "me@example.com", sent_at: "2024-01-10T10:00:00Z" },
  { ...base, id: "e-3", subject: "Inspection", sender: "bob@example.com", recipients: "me@example.com", thread_id: "t-ccc", sent_at: "2024-01-12T10:00:00Z" },
] as Communication[];
const TEXTS = [
  {
    id: "msg-1", user_id: "u", channel: "sms", body_text: "Hi about the property",
    sent_at: "2024-01-16T11:00:00Z", direction: "inbound", thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    has_attachments: false, is_false_positive: false,
  },
] as unknown as Communication[];

function emailsTab(extra: Partial<React.ComponentProps<typeof TransactionEmailsTab>> = {}) {
  return (
    <TransactionEmailsTab
      communications={EMAILS}
      loading={false}
      unlinkingCommId={null}
      onViewEmail={jest.fn()}
      onShowUnlinkConfirm={jest.fn()}
      userId="user-1"
      transactionId="txn-1"
      {...extra}
    />
  );
}

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).unlinkCommunication = jest.fn();
  (window.api.contacts as any).resolveHandles = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
beforeEach(() => {
  jest.clearAllMocks();
  (window.api.contacts.resolveHandles as jest.Mock).mockResolvedValue({ success: true, names: {} });
});

describe("L1 Emails tab linked list", () => {
  it("Select and the per-thread remove: open = enabled, locked = disabled with the tooltip", () => {
    const { unmount } = render(emailsTab());
    expect(screen.getByTestId("select-emails-button")).toBeEnabled();
    screen.getAllByTestId("unlink-thread-button").forEach((b) => expect(b).toBeEnabled());
    unmount();
    render(emailsTab({ editLockedTooltip: LOCK }));
    expect(screen.getByTestId("select-emails-button")).toBeDisabled();
    expect(screen.getByTestId("select-emails-button")).toHaveAttribute("title", LOCK);
    const removes = screen.getAllByTestId("unlink-thread-button");
    expect(removes.length).toBeGreaterThan(0);
    removes.forEach((b) => {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute("title", LOCK);
    });
  });
});

describe("L2 Texts tab linked list", () => {
  it("Select and the per-conversation remove: open = enabled, locked = disabled with the tooltip", async () => {
    const props = { messages: TEXTS, loading: false, error: null, userId: "user-1", transactionId: "txn-1" };
    const { unmount } = render(<TransactionMessagesTab {...props} />);
    await waitFor(() => expect(screen.getAllByTestId("message-thread-card")).toHaveLength(1));
    expect(screen.getByTestId("select-messages-button")).toBeEnabled();
    expect(screen.getByTestId("unlink-thread-button")).toBeEnabled();
    unmount();
    render(<TransactionMessagesTab {...props} editLockedTooltip={LOCK} />);
    await waitFor(() => expect(screen.getAllByTestId("message-thread-card")).toHaveLength(1));
    expect(screen.getByTestId("select-messages-button")).toBeDisabled();
    expect(screen.getByTestId("select-messages-button")).toHaveAttribute("title", LOCK);
    expect(screen.getByTestId("unlink-thread-button")).toBeDisabled();
    expect(screen.getByTestId("unlink-thread-button")).toHaveAttribute("title", LOCK);
  });
});

describe("L3 Conversation view Hide / Unhide", () => {
  const row = (over: Record<string, unknown>) =>
    ({
      id: "m1", communication_id: "comm-m1", user_id: "user-1", transaction_id: "txn-1", message_id: "m1",
      channel: "imessage", communication_type: "imessage", body_text: "see you at closing", body_plain: "see you at closing",
      sender: "+15550100", recipients: "me", sent_at: "2026-01-02T10:00:00", thread_id: "macos-chat-1",
      participants: JSON.stringify({ from: "+15550100", to: ["me"] }), direction: "inbound",
      external_id: "guid-m1", associated_message_type: null, associated_message_guid: null,
      hidden_from_export: 0, has_attachments: 0, ...over,
    }) as unknown as Communication;
  beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (window.api as any).messages = {
      ...(window.api as any).messages,
      getMessageAttachmentsBatch: jest.fn().mockResolvedValue({}),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
  for (const hidden of [0, 1]) {
    it(`${hidden ? "Unhide" : "Hide"}: open = enabled, locked = disabled with the tooltip`, () => {
      const props = {
        messages: [row({ hidden_from_export: hidden })],
        phoneNumber: "+15550100",
        onClose: jest.fn(),
        onSetHiddenFromExport: jest.fn(),
        hideFromExportState: "allowed" as const,
      };
      const { unmount } = rtlRender(<ConversationViewModal {...props} />);
      expect(screen.getByTestId("hide-from-export-m1")).toBeEnabled();
      unmount();
      rtlRender(<ConversationViewModal {...props} hideLockedTooltip={LOCK} />);
      expect(screen.getByTestId("hide-from-export-m1")).toBeDisabled();
      expect(screen.getByTestId("hide-from-export-m1")).toHaveAttribute("title", LOCK);
    });
  }
});

describe("L4 bulk email remove when the main process refuses", () => {
  it("shows the refusal and no success toast, no Undo, no in-place removal", async () => {
    (window.api.transactions.unlinkCommunication as jest.Mock).mockResolvedValue({
      success: false,
      error: REFUSAL,
      dealLocked: "submitted",
    });
    const onShowSuccess = jest.fn();
    const onShowError = jest.fn();
    const onRemoveEmailsByIds = jest.fn(() => 0);
    render(emailsTab({ onShowSuccess, onShowError, onRemoveEmailsByIds }));
    await userEvent.click(screen.getByTestId("select-emails-button"));
    for (const cb of screen.getAllByTestId("email-thread-select")) await userEvent.click(cb);
    await userEvent.click(screen.getAllByTestId("emails-bulk-remove")[0]);
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });
    await waitFor(() => expect(window.api.transactions.unlinkCommunication).toHaveBeenCalledTimes(2));
    expect(onShowSuccess).not.toHaveBeenCalled();
    expect(onShowError).toHaveBeenCalledWith(REFUSAL);
    expect(onRemoveEmailsByIds).not.toHaveBeenCalled();
  });

  it("a partial success counts only the emails actually removed", async () => {
    (window.api.transactions.unlinkCommunication as jest.Mock).mockImplementation(async (cid: string) =>
      cid === "e-1" ? { success: true, unlinkedIds: ["e-1"] } : { success: false, error: REFUSAL },
    );
    const onShowSuccess = jest.fn();
    render(emailsTab({ onShowSuccess, onShowError: jest.fn(), onRemoveEmailsByIds: jest.fn(() => 1) }));
    await userEvent.click(screen.getByTestId("select-emails-button"));
    for (const cb of screen.getAllByTestId("email-thread-select")) await userEvent.click(cb);
    await userEvent.click(screen.getAllByTestId("emails-bulk-remove")[0]);
    await act(async () => {
      await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    });
    await waitFor(() => expect(onShowSuccess).toHaveBeenCalledTimes(1));
    expect(onShowSuccess.mock.calls[0][0]).toBe("Email removed from transaction");
  });
});

describe("L5 single email remove when the main process refuses", () => {
  it("passes the refusal reason to onError, not the generic retry text", async () => {
    (window.api.transactions.unlinkCommunication as jest.Mock).mockResolvedValue({
      success: false,
      error: REFUSAL,
      dealLocked: "submitted",
    });
    const { result } = renderHook(() => useTransactionCommunications());
    const onError = jest.fn();
    await act(async () => {
      await result.current.handleUnlinkCommunication({ id: "e-1" } as Communication, jest.fn(), onError);
    });
    expect(onError).toHaveBeenCalledWith(REFUSAL);
  });

  it("an ordinary failure still says to try again", async () => {
    (window.api.transactions.unlinkCommunication as jest.Mock).mockResolvedValue({ success: false, error: "db busy" });
    const { result } = renderHook(() => useTransactionCommunications());
    const onError = jest.fn();
    await act(async () => {
      await result.current.handleUnlinkCommunication({ id: "e-1" } as Communication, jest.fn(), onError);
    });
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/try again/i));
  });
});
