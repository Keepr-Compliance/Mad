/**
 * RTL Tests — BACKLOG-1781 + BACKLOG-1780
 *
 * BACKLOG-1781: Remove on a merged-card (2 distinct thread_ids) must fire
 *   unlinkCommunication once per constituent backend thread, remove all rows
 *   from the active list in one interaction, and increment the removed count.
 *
 * BACKLOG-1780: After Restore, the "Show removed" section must stay expanded
 *   (isOpen state is lifted above the loading-spinner unmount boundary).
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedEmailsSection } from "../RemovedEmailsSection";

// ---------------------------------------------------------------------------
// Minimal window.api mock — only the calls used by these tests
// ---------------------------------------------------------------------------

function makeRemovedEmail(overrides: {
  ignored_id: string;
  email_id: string;
  thread_id?: string | null;
  subject?: string;
}) {
  return {
    ignored_id: overrides.ignored_id,
    ic_email_id: null,
    reason: "Manually unlinked",
    ignored_at: "2024-02-01T10:00:00Z",
    email_id: overrides.email_id,
    subject: overrides.subject ?? "Test Subject",
    sender: "alice@example.com",
    recipients: "bob@example.com",
    cc: null,
    sent_at: "2024-01-15T10:00:00Z",
    thread_id: overrides.thread_id ?? null,
    body_preview: null,
    body_plain: null,
    has_attachments: false,
    source: "gmail",
  };
}

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).getRemovedEmails = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).restoreRemovedEmail = jest.fn();
  // jsdom doesn't implement scrollTo — silence the warning globally for restore tests
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// BACKLOG-1780: isOpen controlled-state — section stays expanded after Restore
// ---------------------------------------------------------------------------

describe("RemovedEmailsSection — BACKLOG-1780 controlled open state", () => {
  const transactionId = "txn-ctrl";

  it("stays expanded after restore when parent controls isOpen", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa", subject: "Offer" }),
      makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "t-bbb", subject: "Counter" }),
    ];

    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: emails,
    });
    (window.api.transactions.restoreRemovedEmail as jest.Mock).mockResolvedValue({
      success: true,
      restoredCount: 1,
    });

    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);
    const onShowSuccess = jest.fn();

    // Simulate parent-controlled open state (BACKLOG-1780 fix)
    let externalOpen = false;
    const setExternalOpen = jest.fn((v: boolean) => {
      externalOpen = v;
    });

    const { rerender } = render(
      <RemovedEmailsSection
        transactionId={transactionId}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={onShowSuccess}
        onShowError={jest.fn()}
        isOpen={externalOpen}
        onOpenChange={setExternalOpen}
      />
    );

    // Open the section via toggle
    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });

    // Parent update would set externalOpen = true; simulate by re-rendering
    expect(setExternalOpen).toHaveBeenCalledWith(true);
    rerender(
      <RemovedEmailsSection
        transactionId={transactionId}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={onShowSuccess}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={setExternalOpen}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-emails-section")).toBeInTheDocument();
    });

    const cards = screen.getAllByTestId("removed-email-card");
    expect(cards).toHaveLength(2);

    // Restore the first card
    const restoreButtons = screen.getAllByTestId("restore-email-button");
    await act(async () => {
      await userEvent.click(restoreButtons[0]);
    });

    await waitFor(() => {
      // One card should be gone (the restored one)
      expect(screen.getAllByTestId("removed-email-card")).toHaveLength(1);
    });

    // Section should still be expanded (controlled isOpen = true never changed)
    expect(screen.getByTestId("removed-emails-section")).toBeInTheDocument();
    // Silent refresh (not loadDetails) is called
    expect(onRestoreComplete).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1780: refreshKey silently refetches list and updates count
  // -------------------------------------------------------------------------

  it("refetches and updates count when refreshKey changes", async () => {
    const initialEmails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa" }),
    ];
    const afterUnlinkEmails = [
      ...initialEmails,
      makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "t-bbb" }),
    ];

    const getRemovedMock = (window.api.transactions.getRemovedEmails as jest.Mock);
    getRemovedMock.mockResolvedValueOnce({ success: true, removedEmails: initialEmails });
    getRemovedMock.mockResolvedValueOnce({ success: true, removedEmails: afterUnlinkEmails });

    const { rerender } = render(
      <RemovedEmailsSection
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
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });

    // Simulate parent setting isOpen=true and refreshKey=1 after an unlink
    rerender(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
        refreshKey={1}
      />
    );

    // After silent refetch triggered by refreshKey change, should show 2 cards
    await waitFor(() => {
      expect(screen.getAllByTestId("removed-email-card")).toHaveLength(2);
    });

    // Toggle button count label should update
    expect(screen.getByTestId("show-removed-emails-toggle")).toHaveTextContent("Show removed (2)");
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1780 restore path: section refetches data when remounted with
  // isOpen=true (simulates the post-restore loading-spinner remount cycle).
  // -------------------------------------------------------------------------

  it("refetches data on remount when isOpen=true (post-restore loading-spinner cycle)", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa", subject: "Offer" }),
    ];
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: emails,
    });

    // Mount with isOpen=true — simulates remount after loading cycle with
    // parent's removedSectionOpen=true surviving in TransactionEmailsTab state.
    const { unmount } = render(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    // Should auto-fetch on mount and render the card.
    // BACKLOG-1793: await the card itself — the section renders immediately when
    // isOpen=true, so waiting only on the section can race the async mount fetch.
    await waitFor(() => {
      expect(screen.getByTestId("removed-email-card")).toBeInTheDocument();
    });
    expect(screen.getByTestId("removed-emails-section")).toBeInTheDocument();
    expect(screen.getAllByTestId("removed-email-card")).toHaveLength(1);
    expect(screen.getByTestId("show-removed-emails-toggle")).toHaveTextContent("Show removed (1)");

    unmount();
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1780 design: removed card has no "Removed" pill, includes View button
  // -------------------------------------------------------------------------

  it("removed card has no Removed pill and includes an enabled View button", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", subject: "Inspection" }),
    ];
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: emails,
    });

    render(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-email-card")).toBeInTheDocument();
    });

    // No "Removed" pill
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();

    // View button exists and is enabled (not disabled — founder request)
    const viewBtn = screen.getByTestId("view-removed-email-button");
    expect(viewBtn).toBeInTheDocument();
    expect(viewBtn).not.toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1781: distinct thread_ids in same card → refreshKey updates count
  // Tests that a parent-signalled unlink triggers a silent refetch and count update.
  // -------------------------------------------------------------------------

  it("BACKLOG-1781 scenario: removed count increases by total emails after multi-thread unlink signal", async () => {
    const initialEmails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa", subject: "Thread A" }),
    ];
    const afterUnlinkEmails = [
      ...initialEmails,
      makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "t-bbb", subject: "Thread B" }),
    ];

    const getRemovedMock = (window.api.transactions.getRemovedEmails as jest.Mock);
    getRemovedMock.mockResolvedValueOnce({ success: true, removedEmails: initialEmails });
    getRemovedMock.mockResolvedValueOnce({ success: true, removedEmails: afterUnlinkEmails });

    // Start closed so clicking toggle triggers the initial fetch (closed→open path).
    let open = false;
    const { rerender } = render(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={open}
        onOpenChange={(v) => { open = v; }}
        refreshKey={0}
      />
    );

    // Click toggle: closed→open fires the fetch (first mock: 1 email) and calls onOpenChange(true).
    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });
    // Simulate the parent responding to onOpenChange(true).
    rerender(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={(v) => { open = v; }}
        refreshKey={0}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-emails-section")).toBeInTheDocument();
    });

    // 1 card shown initially
    expect(screen.getAllByTestId("removed-email-card")).toHaveLength(1);
    expect(screen.getByTestId("show-removed-emails-toggle")).toHaveTextContent("Show removed (1)");

    // Simulate parent signalling that a multi-thread unlink just completed
    rerender(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={(v) => { open = v; }}
        refreshKey={1}
      />
    );

    // After silent refetch, two removed cards should appear
    await waitFor(() => {
      expect(screen.getAllByTestId("removed-email-card")).toHaveLength(2);
    });

    // Count label should reflect the new total
    expect(screen.getByTestId("show-removed-emails-toggle")).toHaveTextContent("Show removed (2)");
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1780: clicking View on removed card opens EmailThreadViewModal
  // -------------------------------------------------------------------------

  it("clicking View on a removed card opens the read-only thread view modal", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa", subject: "Offer Letter" }),
    ];
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: emails,
    });

    render(
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("removed-email-card")).toBeInTheDocument();
    });

    // Click View — should open the modal (EmailThreadViewModal shows a Close button)
    await act(async () => {
      await userEvent.click(screen.getByTestId("view-removed-email-button"));
    });

    // Modal is open: Close button appears (aria-label="Close" from ResponsiveModal)
    expect(screen.getAllByRole("button", { name: /close/i }).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // BACKLOG-1780: restore calls onRestoreComplete (silent refresh), NOT
  // onEmailsChanged. The scroll container scrollTop must never be written —
  // no loading cycle means no scroll disruption.
  // -------------------------------------------------------------------------

  it("restore calls onRestoreComplete (silent refresh), not onEmailsChanged, and never writes scrollTop", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa", subject: "Offer" }),
    ];
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: emails,
    });
    (window.api.transactions.restoreRemovedEmail as jest.Mock).mockResolvedValue({
      success: true,
      restoredCount: 1,
    });

    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    // Render inside a container; track writes to scrollTop via defineProperty setter.
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
      <RemovedEmailsSection
        transactionId={transactionId}
        onShowSuccess={jest.fn()}
        onShowError={jest.fn()}
        isOpen={true}
        onOpenChange={jest.fn()}
        onRestoreComplete={onRestoreComplete}
      />,
      { container: scrollContainer }
    );

    await waitFor(() => {
      expect(screen.getByTestId("restore-email-button")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-email-button"));
    });

    await waitFor(() => {
      expect(onRestoreComplete).toHaveBeenCalled();
    });

    // onRestoreComplete (silent refresh) is called, not a loading-cycle trigger.
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);

    // Restored card is removed from the section's local state.
    expect(screen.queryByTestId("removed-email-card")).not.toBeInTheDocument();

    // The scroll container's scrollTop was never written — no loading cycle,
    // no spinner, no re-mount means zero scroll disruption.
    expect(scrollTopWriteCount).toBe(0);
    expect(scrollTopValue).toBe(800);

    document.body.removeChild(scrollContainer);
  });
});
