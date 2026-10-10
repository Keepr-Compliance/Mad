/**
 * BACKLOG-3785 — after Attach Messages the Texts tab fetches only the delta.
 *
 * Linking 150 chats into a deal with 76k texts used to re-download every linked
 * text through `transactions:get-communications` (107 MB) and freeze the
 * window. The attach refresh now sends the ids already shown to
 * `getCommunicationsDelta` and merges `{ added, removedIds }`.
 *
 * The attach modal itself is replaced by a stub that calls `onAttached` the way
 * the real one does after a successful link (`AttachMessagesModal.tsx`
 * handleAttach). Text rows are shaped like `getCommunicationsWithMessages`
 * output (communicationDbService.ts): COALESCE id, communication_id, channel,
 * body_text, sent_at, thread_id, participants JSON, direction.
 */

import React from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../../electron/types/models";

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper: NotificationProvider });

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team" as const,
    hasAIAddon: false,
    organizationId: "org-123",
    canExport: false,
    canSubmit: true,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-456", email: "test@test.com" }, isAuthenticated: true }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "test@test.com" }),
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
  useSyncOrchestrator: () => ({
    state: { isRunning: false, queue: [], currentSync: null, overallProgress: 0, pendingRequest: null },
    isRunning: false,
    queue: [],
    currentSync: null,
    overallProgress: 0,
    pendingRequest: null,
    requestSync: jest.fn(),
    forceSync: jest.fn(),
    acceptPending: jest.fn(),
    rejectPending: jest.fn(),
    cancel: jest.fn(),
  }),
}));
jest.mock("../transactionDetailsModule/components/modals/AttachMessagesModal", () => ({
  AttachMessagesModal: ({ onAttached, onClose }: { onAttached: (ids: string[]) => void; onClose: () => void }) => (
    <button
      data-testid="stub-attach"
      onClick={() => {
        onAttached(["msg-new"]);
        onClose();
      }}
    >
      stub attach
    </button>
  ),
}));

const transaction: Transaction = {
  id: "txn-3785",
  user_id: "user-456",
  property_address: "1 Example Way",
  transaction_type: "purchase",
  status: "active" as const,
  message_count: 1,
  attachment_count: 0,
  export_status: "not_exported" as const,
  export_count: 0,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const textRow = (id: string, phone: string, thread: string, sentAt: string) => ({
  id,
  communication_id: `comm-${id}`,
  user_id: "user-456",
  transaction_id: "txn-3785",
  message_id: id,
  email_id: null,
  link_source: "manual",
  link_confidence: 1,
  match_reason: null,
  channel: "sms",
  communication_type: "sms",
  body_text: `hello from ${id}`,
  body_plain: `hello from ${id}`,
  body: null,
  subject: null,
  sender: phone,
  recipients: "me",
  sent_at: sentAt,
  received_at: sentAt,
  has_attachments: 0,
  thread_id: thread,
  participants: JSON.stringify({ from: phone, to: ["me"] }),
  thread_display_name: null,
  direction: "inbound",
  external_id: `ext-${id}`,
  associated_message_type: null,
  associated_message_guid: null,
  hidden_from_export: 0,
});

const existing = textRow("msg-old", "+12065550142", "thread-old", "2024-02-01T10:00:00Z");
const added = textRow("msg-new", "+12065550143", "thread-new", "2024-02-03T10:00:00Z");

beforeEach(() => {
  jest.clearAllMocks();
  window.api.transactions.getOverview = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...transaction, contact_assignments: [] },
  });
  window.api.transactions.getCommunications = jest.fn().mockResolvedValue({
    success: true,
    transaction: { communications: [existing], contact_assignments: [] },
  });
  window.api.transactions.getCommunicationsDelta = jest.fn().mockResolvedValue({
    success: true,
    added: [added],
    removedIds: [],
    total: 2,
  });
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
});

describe("Attach Messages refresh (BACKLOG-3785)", () => {
  it("merges the delta and does not re-download every linked text", async () => {
    const user = userEvent.setup();
    render(
      <TransactionDetails transaction={transaction} onClose={jest.fn()} userId="user-456" initialTab="messages" />,
    );

    await waitFor(() => expect(screen.getByText(/1 conversation\b/)).toBeInTheDocument());
    expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(1);

    await user.click(screen.getAllByTestId("attach-messages-button")[0]);
    await user.click(await screen.findByTestId("stub-attach"));

    await waitFor(() => expect(screen.getByText(/2 conversations\b/)).toBeInTheDocument());
    expect(window.api.transactions.getCommunicationsDelta).toHaveBeenCalledTimes(1);
    expect(window.api.transactions.getCommunicationsDelta).toHaveBeenCalledWith(
      "txn-3785",
      "text",
      ["msg-old"],
    );
    // The whole-list reload is NOT issued after attach.
    expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(1);
  });

  it("falls back to the full reload when the delta call fails", async () => {
    jest.mocked(window.api.transactions.getCommunicationsDelta).mockResolvedValue({
      success: false,
      error: "boom",
    });
    const user = userEvent.setup();
    render(
      <TransactionDetails transaction={transaction} onClose={jest.fn()} userId="user-456" initialTab="messages" />,
    );
    await waitFor(() => expect(screen.getByText(/1 conversation\b/)).toBeInTheDocument());

    await user.click(screen.getAllByTestId("attach-messages-button")[0]);
    await user.click(await screen.findByTestId("stub-attach"));

    await waitFor(() => expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(2));
  });
});
