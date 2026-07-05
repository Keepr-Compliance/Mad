/**
 * RTL Tests — BACKLOG-1793
 *
 * Ports ALL removed-section fixes from the Emails tab to the Texts tab via the
 * SHARED useRemovedSection hook + RemovedItemsSection shell. These tests assert
 * the five ported behaviours on the MESSAGES side:
 *
 *   1. No red "Removed" pill on removed cards.
 *   3. Restore does NOT collapse the section (controlled-open state).
 *   4. Restore does NOT move the scroll — SILENT refresh via onRestoreComplete
 *      (not onMessagesChanged); scrollTop is never written.
 *   5. View works on removed items — opens the read-only ConversationViewModal.
 *
 * (Behaviour 2 — trash icon on ACTIVE cards — is covered in
 *  TransactionMessagesTab-1793.test.tsx, where active cards render.)
 *
 * Plus the shared machinery: refreshKey silent refetch + mount-time rehydrate.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedMessagesSection } from "../RemovedMessagesSection";

// ---------------------------------------------------------------------------
// window.api mock helpers
// ---------------------------------------------------------------------------

function makeRemovedMessage(overrides: {
  ignored_id: string;
  message_id: string;
  thread_id?: string | null;
  body?: string;
  from?: string;
}) {
  const from = overrides.from ?? "+14155550100";
  return {
    ignored_id: overrides.ignored_id,
    ic_thread_id: null,
    reason: "Manually unlinked by user",
    ignored_at: "2024-02-01T10:00:00Z",
    message_id: overrides.message_id,
    body: overrides.body ?? "Message body content",
    subject: null,
    channel: "sms",
    thread_id: overrides.thread_id ?? "t-1",
    sent_at: "2024-01-15T10:00:00Z",
    received_at: null,
    participants: JSON.stringify({ from, to: ["me"], chat_members: [from] }),
    participants_flat: null,
    direction: "inbound",
  };
}

beforeAll(() => {
  // getRemovedMessages / restoreRemovedMessage exist in the shared setup, but we
  // re-assign fresh mocks here so each suite controls its resolved values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).getRemovedMessages = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).restoreRemovedMessage = jest.fn();
  // jsdom doesn't implement scrollTo — silence the warning globally for restore tests
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
});

const transactionId = "txn-msg-1793";

describe("RemovedMessagesSection — BACKLOG-1793 shared removed-section", () => {
  // -------------------------------------------------------------------------
  // Behaviour 1: no red "Removed" pill on removed cards
  // -------------------------------------------------------------------------
  it("removed card has no red 'Removed' pill", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1" })],
    });

    const { container } = render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
    });

    // No "Removed" pill text, and no red pill styling
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-red-50")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Behaviour 3: restore does NOT collapse the section (controlled open state)
  // -------------------------------------------------------------------------
  it("stays expanded after restore when parent controls isOpen", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [
        makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-a", from: "+14155550100" }),
        makeRemovedMessage({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-b", from: "+14155550200" }),
      ],
    });
    (window.api.transactions.restoreRemovedMessage as jest.Mock).mockResolvedValue({ success: true });

    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(2);
    });

    const restoreButtons = screen.getAllByTestId("restore-removed-message");
    await act(async () => {
      await userEvent.click(restoreButtons[0]);
    });

    await waitFor(() => {
      // One card removed (the restored one)
      expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(1);
    });

    // Section still expanded (controlled isOpen=true never changed)
    expect(screen.getByTestId("removed-messages-section")).toBeInTheDocument();
    // Silent refresh path used
    expect(onRestoreComplete).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Behaviour 4: restore does NOT move the scroll — SILENT refresh path
  // -------------------------------------------------------------------------
  it("restore calls onRestoreComplete (silent), not onMessagesChanged, and never writes scrollTop", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1" })],
    });
    (window.api.transactions.restoreRemovedMessage as jest.Mock).mockResolvedValue({ success: true });

    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);
    const onMessagesChanged = jest.fn().mockResolvedValue(undefined);

    // Track writes to scrollTop via a defineProperty setter spy.
    const scrollContainer = document.createElement("div");
    let scrollTopValue = 800;
    let scrollTopWriteCount = 0;
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => scrollTopValue,
      set: (v: number) => { scrollTopValue = v; scrollTopWriteCount++; },
      configurable: true,
    });
    document.body.appendChild(scrollContainer);

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onRestoreComplete={onRestoreComplete}
        onMessagesChanged={onMessagesChanged}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />,
      { container: scrollContainer }
    );

    await waitFor(() => {
      expect(screen.getByTestId("restore-removed-message")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-removed-message"));
    });

    await waitFor(() => {
      expect(onRestoreComplete).toHaveBeenCalled();
    });

    // Silent refresh used; the loading-cycle callback (onMessagesChanged) is NOT.
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
    expect(onMessagesChanged).not.toHaveBeenCalled();

    // Restored card removed from local state.
    expect(screen.queryByTestId("removed-thread-card")).not.toBeInTheDocument();

    // No loading cycle → the scroll container's scrollTop was never written.
    expect(scrollTopWriteCount).toBe(0);
    expect(scrollTopValue).toBe(800);

    document.body.removeChild(scrollContainer);
  });

  // -------------------------------------------------------------------------
  // Behaviour 5: View works on removed items (read-only conversation modal)
  // -------------------------------------------------------------------------
  it("clicking View on a removed card opens the read-only conversation modal (no Remove inside)", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [
        makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1", body: "Removed conversation preview" }),
      ],
    });

    render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
    });

    // Click "View Full →" to open the conversation modal
    await act(async () => {
      await userEvent.click(screen.getByTestId("toggle-thread-button"));
    });

    // Modal shows the message body (read-only conversation view)
    await waitFor(() => {
      expect(screen.getByText("Removed conversation preview")).toBeInTheDocument();
    });

    // Read-only: there is no unlink/remove control anywhere in the removed context
    expect(screen.queryByTestId("unlink-thread-button")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Shared machinery: refreshKey silently refetches and updates the count
  // -------------------------------------------------------------------------
  it("refetches and updates count when refreshKey changes", async () => {
    const initial = [makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-a" })];
    const afterUnlink = [
      ...initial,
      makeRemovedMessage({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-b", from: "+14155550200" }),
    ];
    const mock = window.api.transactions.getRemovedMessages as jest.Mock;
    mock.mockResolvedValueOnce({ success: true, removedMessages: initial });
    mock.mockResolvedValueOnce({ success: true, removedMessages: afterUnlink });

    const { rerender } = render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={false}
        onOpenChange={jest.fn()}
        refreshKey={0}
      />
    );

    // Open → fetches initial list (count = 1)
    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-messages-toggle"));
    });

    rerender(
      <RemovedMessagesSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
        refreshKey={1}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(2);
    });
    expect(screen.getByTestId("show-removed-messages-toggle")).toHaveTextContent("Show removed (2)");
  });

  // -------------------------------------------------------------------------
  // Shared machinery: mount-time rehydrate when isOpen=true (post-loading cycle)
  // -------------------------------------------------------------------------
  it("refetches data on mount when isOpen=true (post-restore loading-spinner cycle)", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1" })],
    });

    const { unmount } = render(
      <RemovedMessagesSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    // Auto-fetches on mount → the card appears without user interaction.
    await waitFor(() => {
      expect(screen.getByTestId("removed-thread-card")).toBeInTheDocument();
    });
    expect(screen.getByTestId("removed-messages-section")).toBeInTheDocument();
    expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(1);
    expect(screen.getByTestId("show-removed-messages-toggle")).toHaveTextContent("Show removed (1)");

    unmount();
  });
});
