/**
 * BACKLOG-3366 — clicking Hide / Unhide in an open conversation reaches the
 * database call, refetches, and the SAME open conversation shows the result.
 *
 * The other 3366 renderer suites cover the modal given a callback and which
 * openers pass the control. Nothing covered the path between them:
 *   ConversationViewModal pill click
 *   -> TransactionMessagesTab.handleSetHiddenFromExport
 *   -> transactionService.hideTextFromExport / unhideTextFromExport
 *   -> window.api.transactions.* (the IPC boundary, mocked here)
 *   -> TransactionDetails.handleHiddenFromExportChanged
 *   -> refreshCommunicationsSilently("text") -> the modal's `messages` prop
 * So this mounts the REAL TransactionDetails (harness copied from
 * TransactionDetails.reviewLinkedListLive-2791.test.tsx) and mocks only the
 * bridge and the entitlement hook.
 *
 * The entitlement hook is mocked to "allowed" at the hook boundary. The
 * shipped stand-in returns "blocked" and stays that way; its own control lives
 * in hideFromExportOpeners-3366.test.tsx.
 *
 * The bridge mocks change the stored marker, and the only way the marker
 * reaches the screen is the refetch. A bubble that turns gray therefore proves
 * the right call happened AND the list was re-read after it.
 *
 * FIXTURE: transcribed from a real `getCommunicationsWithMessages(txn, "text")`
 * row — the thread-link case of
 * electron/services/db/__tests__/communicationDbService.hiddenFromExport-3366.test.ts
 * (C1b) run under Electron node at 13bbd099e. Every projected column is
 * present. Only ids, bodies and timestamps differ; `communication_id` is a
 * plain string because the fixture guard rejects fixed UUIDs.
 *
 * CONTROLS RUN (mutation applied, suite re-run, MEASURED): see the BACKLOG-3366
 * pm_comments entry "SR changes addressed".
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

jest.mock("../../hooks/useHideFromExportState", () => ({
  useHideFromExportState: () => "allowed",
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: false,
    organizationId: null,
    canExport: true,
    canSubmit: false,
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

const TXN = "txn-123";
const X = "m-1";
const Y = "m-2";
const HIDE_ERROR = "Could not hide this text";

const baseTransaction = {
  id: TXN,
  user_id: "user-456",
  property_address: "742 Example Ave",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
} as unknown as Transaction;

/** One row of the shared read, thread-linked text (see FIXTURE above). */
function textRow(id: string, body: string, sentAt: string, hidden: 0 | 1) {
  return {
    id,
    communication_id: "c-3366-thread",
    user_id: "user-456",
    transaction_id: TXN,
    message_id: id,
    email_id: null,
    link_source: "manual",
    link_confidence: 0.9,
    match_reason: null,
    linked_at: "2026-08-01 10:00:00",
    created_at: "2026-08-01 10:00:00",
    channel: "imessage",
    communication_type: "imessage",
    body_text: body,
    body_plain: body,
    body: null,
    subject: null,
    sender: "+15555550142",
    recipients: "me",
    sent_at: sentAt,
    received_at: null,
    has_attachments: 0,
    thread_id: "macos-chat-3366",
    participants: JSON.stringify({ from: "+15555550142", to: ["me"] }),
    thread_display_name: null,
    direction: "inbound",
    external_id: `guid-${id}`,
    associated_message_type: null,
    associated_message_guid: null,
    hidden_from_export: hidden,
    source: null,
    cc: null,
    bcc: null,
    attachment_count: null,
  };
}

/** The stored hide rows. The bridge mocks write it; only a READ shows it. */
let hiddenInDb: Set<string>;
const linkedTexts = () => [
  textRow(X, "the lockbox code is on the back", "2026-06-01T10:00:00.000Z", hiddenInDb.has(X) ? 1 : 0),
  textRow(Y, "see you at the inspection", "2026-06-02T10:00:00.000Z", hiddenInDb.has(Y) ? 1 : 0),
];

/* eslint-disable @typescript-eslint/no-explicit-any */
let getCommunications: jest.Mock;
let hideTextFromExport: jest.Mock;
let unhideTextFromExport: jest.Mock;

beforeAll(() => {
  getCommunications = jest.fn();
  hideTextFromExport = jest.fn();
  unhideTextFromExport = jest.fn();
  const t = window.api.transactions as any;
  t.getCommunications = getCommunications;
  t.hideTextFromExport = hideTextFromExport;
  t.unhideTextFromExport = unhideTextFromExport;
  t.getReviewState = jest.fn();
  t.approveReviewItems = jest.fn();
  t.rejectReviewItems = jest.fn();
  t.syncReviewQueue = jest.fn();
  t.onReviewQueueChanged = jest.fn().mockReturnValue(() => {});
  t.getRemovedContacts = jest.fn().mockResolvedValue({ success: true, removedContacts: [] });
  t.restoreContact = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  hiddenInDb = new Set();

  const t = window.api.transactions as any;
  t.getReviewState.mockResolvedValue({ items: [], count: 0 });
  t.syncReviewQueue.mockResolvedValue({ added: 0, linked: 0, outstanding: 0 });
  t.onReviewQueueChanged.mockReturnValue(() => {});
  t.getRemovedContacts.mockResolvedValue({ success: true, removedContacts: [] });

  jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  } as never);
  getCommunications.mockImplementation(async (_txn: string, channel?: string) => ({
    success: true,
    transaction: { communications: channel === "text" ? linkedTexts() : [], contact_assignments: [] },
  }));
  hideTextFromExport.mockImplementation(async (_txn: string, messageId: string) => {
    hiddenInDb.add(messageId);
    return { success: true, hidden: true };
  });
  unhideTextFromExport.mockImplementation(async (_txn: string, messageId: string) => {
    hiddenInDb.delete(messageId);
    return { success: true, hidden: false };
  });
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] } as never);
  (window.api.transactions.getAllAttachments as jest.Mock).mockResolvedValue({
    success: true,
    data: [],
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

const textReads = () => getCommunications.mock.calls.filter((c) => c[1] === "text").length;

/** The pill for one text. Re-queried every time: a refetch re-renders it. */
const pill = (id: string) => screen.getByTestId(`hide-from-export-${id}`);

/** The bubble that holds a text's pill. */
function bubble(id: string): HTMLElement {
  const el = pill(id).closest("[data-hidden-from-export]");
  if (!el) throw new Error(`no bubble around hide-from-export-${id}`);
  return el as HTMLElement;
}

/** Open the Texts tab, then the linked conversation. */
async function openLinkedConversation(): Promise<void> {
  render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
  await waitFor(() =>
    expect(window.api.transactions.getAllAttachments as jest.Mock).toHaveBeenCalled(),
  );
  await act(async () => {
    await userEvent.click(await screen.findByRole("button", { name: /Texts/i }));
  });
  await screen.findByTestId("message-thread-card");
  await act(async () => {
    await userEvent.click(screen.getByTestId("toggle-thread-button"));
  });
  await screen.findByTestId(`hide-from-export-${X}`);
}

describe("BACKLOG-3366 — Hide / Unhide click reaches the database call and the open conversation updates", () => {
  it("Hide calls the hide channel, refetches, bubble turns gray; Unhide calls the unhide channel, refetches, bubble returns", async () => {
    await openLinkedConversation();

    // Starting state: both bubbles normal, both offer Hide.
    expect(bubble(X)).toHaveAttribute("data-hidden-from-export", "false");
    expect(bubble(X)).not.toHaveClass("bg-gray-200");
    expect(pill(X)).toHaveAccessibleName("Hide from export");
    expect(bubble(Y)).toHaveAttribute("data-hidden-from-export", "false");

    // ── Hide ────────────────────────────────────────────────────────────
    // Counted BEFORE the click: opening the tab already read texts.
    const readsBeforeHide = textReads();
    expect(readsBeforeHide).toBeGreaterThan(0);

    await act(async () => {
      await userEvent.click(pill(X));
    });

    expect(hideTextFromExport).toHaveBeenCalledTimes(1);
    expect(hideTextFromExport).toHaveBeenCalledWith(TXN, X);
    expect(unhideTextFromExport).not.toHaveBeenCalled();

    // The founder-visible result, in the conversation that is still open.
    await waitFor(() => expect(bubble(X)).toHaveAttribute("data-hidden-from-export", "true"));
    expect(bubble(X)).toHaveClass("bg-gray-200", "text-gray-500", "border", "border-gray-300");
    expect(pill(X)).toHaveAccessibleName("Unhide");
    expect(pill(X)).toHaveAttribute("aria-pressed", "true");
    // Only the clicked text changed.
    expect(bubble(Y)).toHaveAttribute("data-hidden-from-export", "false");
    // And it got there by a re-read, not by a local flip.
    expect(textReads()).toBeGreaterThan(readsBeforeHide);

    // ── Unhide ──────────────────────────────────────────────────────────
    const readsBeforeUnhide = textReads();

    await act(async () => {
      await userEvent.click(pill(X));
    });

    expect(unhideTextFromExport).toHaveBeenCalledTimes(1);
    expect(unhideTextFromExport).toHaveBeenCalledWith(TXN, X);
    expect(hideTextFromExport).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(bubble(X)).toHaveAttribute("data-hidden-from-export", "false"));
    expect(bubble(X)).not.toHaveClass("bg-gray-200");
    expect(pill(X)).toHaveAccessibleName("Hide from export");
    expect(pill(X)).toHaveAttribute("aria-pressed", "false");
    expect(textReads()).toBeGreaterThan(readsBeforeUnhide);
  });

  it("a hide whose call fails shows the error, does not refetch, and never shows the text as hidden", async () => {
    hideTextFromExport.mockImplementation(async () => ({ success: false, error: HIDE_ERROR }));

    await openLinkedConversation();
    const readsBefore = textReads();
    expect(readsBefore).toBeGreaterThan(0);

    await act(async () => {
      await userEvent.click(pill(X));
    });

    expect(hideTextFromExport).toHaveBeenCalledTimes(1);
    expect(hideTextFromExport).toHaveBeenCalledWith(TXN, X);
    expect(unhideTextFromExport).not.toHaveBeenCalled();

    // Wait for the error FIRST, so "no refetch" below is measured after the
    // handler has finished, not before it got the chance to refetch.
    await waitFor(() => expect(screen.getByTestId("notification-error")).toHaveTextContent(HIDE_ERROR));
    await waitFor(() => expect(pill(X)).not.toBeDisabled());

    expect(textReads()).toBe(readsBefore);
    expect(bubble(X)).toHaveAttribute("data-hidden-from-export", "false");
    expect(bubble(X)).not.toHaveClass("bg-gray-200");
    expect(screen.queryByTestId("hidden-from-export-label")).not.toBeInTheDocument();
    expect(pill(X)).toHaveAccessibleName("Hide from export");
    expect(pill(X)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("notification-success")).not.toBeInTheDocument();
  });
});
