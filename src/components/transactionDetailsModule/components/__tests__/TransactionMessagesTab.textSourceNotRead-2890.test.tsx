/**
 * BACKLOG-2890 (founder, 2026-11-04): when the messages-source preference could
 * not be read (useAutoRefresh `messagesSyncHeld`), the Texts tab's zero-texts
 * state is the kit EmptyState "Text source not read" with Retry and Choose
 * source, below the existing TextCoverageNotice. Texts present, or a read that
 * worked, keep the tab exactly as before.
 */
import React from "react";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../../../contexts/NotificationContext";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

// The notice reads coverage over IPC; a marker is enough to check its position.
jest.mock("../TextCoverageNotice", () => ({
  TextCoverageNotice: () => <div data-testid="text-coverage-notice" />,
}));
jest.mock("../RemovedMessagesSection", () => ({
  RemovedMessagesSection: () => null,
}));

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        unlinkMessages: jest.fn().mockResolvedValue({ success: true }),
        getMessageContacts: jest.fn().mockResolvedValue({ success: true, contacts: [] }),
        getMessagesByContact: jest.fn().mockResolvedValue({ success: true, messages: [] }),
        linkMessages: jest.fn().mockResolvedValue({ success: true }),
      },
      contacts: {
        getNamesByPhones: jest.fn().mockResolvedValue({ success: true, names: {} }),
      },
    },
    writable: true,
  });
});

const oneText: Partial<Communication>[] = [
  {
    id: "msg-1",
    user_id: "user-456",
    channel: "sms",
    body_text: "Got your message about the property!",
    sent_at: "2024-01-16T11:00:00Z",
    direction: "inbound",
    thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    has_attachments: false,
    is_false_positive: false,
  },
];

const base = {
  loading: false,
  error: null,
  userId: "user-456",
  transactionId: "txn-1",
};

describe("TransactionMessagesTab: text source not read (BACKLOG-2890)", () => {
  it("E1 held + zero texts: the kit EmptyState with its copy and both buttons, below the coverage notice", () => {
    render(
      <TransactionMessagesTab
        {...base}
        messages={[]}
        messagesSyncHeld
        onRetryMessagesRead={jest.fn()}
        onChooseMessagesSource={jest.fn()}
      />,
    );
    const empty = screen.getByTestId("text-source-not-read");
    expect(empty).toHaveTextContent("Text source not read");
    expect(empty).toHaveTextContent(
      "Keepr couldn't read which messages source this Mac uses, so texts weren't synced.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose source" })).toBeInTheDocument();
    expect(screen.queryByText("No text messages linked")).toBeNull();

    // The existing notice stays, above the empty state.
    const notice = screen.getByTestId("text-coverage-notice");
    expect(notice.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Light/dark: the kit EmptyState colours come from theme tokens (CSS
    // variables that switch with the theme), not hard-coded grays.
    expect(empty.className).toContain("bg-card");
    expect(screen.getByText("Text source not read").className).toContain("text-foreground");
    expect(empty.className).not.toContain("bg-gray-50");
  });

  it("E2 held + texts present: the normal list, no EmptyState", () => {
    render(
      <TransactionMessagesTab
        {...base}
        messages={oneText as Communication[]}
        messagesSyncHeld
        onRetryMessagesRead={jest.fn()}
        onChooseMessagesSource={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("text-source-not-read")).toBeNull();
    expect(screen.queryByText("No text messages linked")).toBeNull();
    expect(screen.getByTestId("message-thread-card")).toBeInTheDocument();
  });

  it.each([
    ["false", { messagesSyncHeld: false }],
    ["not passed", {}],
  ])("E3 read OK (held %s) + zero texts: the existing 'No text messages linked' block", (_n, extra) => {
    render(<TransactionMessagesTab {...base} messages={[]} {...extra} />);
    expect(screen.getByText("No text messages linked")).toBeInTheDocument();
    expect(screen.queryByTestId("text-source-not-read")).toBeNull();
    expect(screen.queryByText("Text source not read")).toBeNull();
  });

  it("E4 Retry calls the re-read-then-sync callback; Choose source calls the settings opener", () => {
    const onRetryMessagesRead = jest.fn();
    const onChooseMessagesSource = jest.fn();
    render(
      <TransactionMessagesTab
        {...base}
        messages={[]}
        messagesSyncHeld
        onRetryMessagesRead={onRetryMessagesRead}
        onChooseMessagesSource={onChooseMessagesSource}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryMessagesRead).toHaveBeenCalledTimes(1);
    expect(onChooseMessagesSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose source" }));
    expect(onChooseMessagesSource).toHaveBeenCalledTimes(1);
  });
});
