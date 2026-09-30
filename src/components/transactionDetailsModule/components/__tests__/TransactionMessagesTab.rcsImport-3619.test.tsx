/**
 * BACKLOG-3619 — the import session survives the Messages tab switching from
 * its empty state to its populated header when the first chat lands.
 *
 * The tab renders the Import panel in two different trees. A session owned by
 * the panel would be closed by the unmount, and the next "Send to Keepr" would
 * be answered "click Import first".
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

const mockStart = jest.fn();
const mockEnd = jest.fn();

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    startSession: (...a: unknown[]) => mockStart(...a),
    endSession: (...a: unknown[]) => mockEnd(...a),
    getStatus: jest.fn(),
    onChatReceived: () => () => {},
    // BACKLOG-3620: the tab also shows the Sync job.
    getJob: () => Promise.resolve({ success: true, data: null }),
    onJobProgress: () => () => {},
    startJob: jest.fn(),
    cancelJob: jest.fn(),
  },
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

beforeEach(() => {
  mockStart.mockReset().mockResolvedValue({
    success: true,
    data: {
      bridge: "listening",
      port: 38619,
      session: {
        sessionId: "s-1",
        transactionId: "tx-1",
        chatsReceived: 0,
        messagesReceived: 0,
        messagesStored: 0,
        startedAt: "2026-09-29T00:00:00.000Z",
      },
    },
  });
  mockEnd.mockReset().mockResolvedValue({ success: true });
});

const oneMessage: Partial<Communication>[] = [
  {
    id: "msg-1",
    user_id: "user-1",
    channel: "sms",
    body_text: "Synthetic text",
    sent_at: "2026-09-20T13:05:00Z",
    direction: "inbound",
    thread_id: "gmweb-chat-aaaaaaaaaaaaaaaaaaa",
    participants: JSON.stringify({ from: "Test Contact A", to: ["me"] }),
    has_attachments: false,
    is_false_positive: false,
  },
];

function tab(messages: Partial<Communication>[]) {
  return (
    <TransactionMessagesTab
      messages={messages as Communication[]}
      loading={false}
      error={null}
      userId="user-1"
      transactionId="tx-1"
      onMessagesChanged={jest.fn()}
    />
  );
}

it("shows Import with no contacts, and keeps the session open when the first chat populates the tab", async () => {
  const { rerender, unmount } = render(tab([]));

  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() => expect(screen.getByTestId("rcs-import-session")).toBeInTheDocument());

  rerender(tab(oneMessage));
  await waitFor(() => expect(screen.getByTestId("rcs-import-session")).toBeInTheDocument());
  expect(screen.queryByTestId("rcs-import-button")).not.toBeInTheDocument();
  expect(mockEnd).not.toHaveBeenCalled();

  unmount();
  expect(mockEnd).toHaveBeenCalledWith("s-1");
});
