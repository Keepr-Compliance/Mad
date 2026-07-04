/**
 * RemovedEmailsSection Tests (BACKLOG-1766)
 * Verifies that removed emails sharing a thread_id are grouped into a single
 * card with a "(N emails)" count and a single Restore button.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedEmailsSection } from "../RemovedEmailsSection";

// ---------------------------------------------------------------------------
// window.api mock helpers
// ---------------------------------------------------------------------------

function makeRemovedEmail(overrides: {
  ignored_id: string;
  email_id: string;
  subject?: string;
  thread_id?: string | null;
  sent_at?: string;
  ignored_at?: string;
}) {
  return {
    ignored_id: overrides.ignored_id,
    ic_email_id: null,
    reason: "Manually unlinked by user",
    ignored_at: overrides.ignored_at ?? "2024-01-10T10:00:00Z",
    email_id: overrides.email_id,
    subject: overrides.subject ?? "Test Subject",
    sender: "sender@example.com",
    recipients: "recipient@example.com",
    cc: null,
    sent_at: overrides.sent_at ?? "2024-01-01T10:00:00Z",
    thread_id: overrides.thread_id ?? null,
    body_preview: null,
    body_plain: null,
    has_attachments: false,
    source: "gmail",
  };
}

beforeAll(() => {
  // getRemovedEmails and restoreRemovedEmail are not in the shared test setup;
  // add them here for this test suite.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).getRemovedEmails = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).restoreRemovedEmail = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RemovedEmailsSection (BACKLOG-1766)", () => {
  const transactionId = "txn-123";

  it("renders one grouped card for 3 emails sharing the same thread_id", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "thread-abc", sent_at: "2024-01-01T08:00:00Z", subject: "Offer on 123 Main" }),
      makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "thread-abc", sent_at: "2024-01-02T09:00:00Z", subject: "Re: Offer on 123 Main" }),
      makeRemovedEmail({ ignored_id: "ig-3", email_id: "e-3", thread_id: "thread-abc", sent_at: "2024-01-03T10:00:00Z", subject: "Re: Offer on 123 Main" }),
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
      />
    );

    // Open the section
    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("removed-emails-section")).toBeInTheDocument();
    });

    // Should show exactly ONE card, not three
    const cards = screen.getAllByTestId("removed-email-card");
    expect(cards).toHaveLength(1);

    // Card should display the "(3 emails)" count label
    expect(screen.getByText(/\(3 emails\)/)).toBeInTheDocument();

    // Should show exactly ONE Restore button
    const restoreButtons = screen.getAllByTestId("restore-email-button");
    expect(restoreButtons).toHaveLength(1);
  });

  it("renders separate cards for emails with different thread_ids", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "thread-aaa", subject: "Thread A" }),
      makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "thread-bbb", subject: "Thread B" }),
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
      />
    );

    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-email-card")).toHaveLength(2);
    });
  });

  it("renders a single email with null thread_id as its own card (unchanged)", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: null, subject: "Standalone" }),
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
      />
    );

    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-email-card")).toHaveLength(1);
    });

    // Single email — no "(N emails)" label
    expect(screen.queryByText(/\(\d+ emails\)/)).not.toBeInTheDocument();
    expect(screen.getAllByTestId("restore-email-button")).toHaveLength(1);
  });

  it("removes all thread siblings from the list after a successful thread restore", async () => {
    const emails = [
      makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "thread-abc", subject: "Offer" }),
      makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "thread-abc", subject: "Re: Offer" }),
      makeRemovedEmail({ ignored_id: "ig-3", email_id: "e-3", thread_id: "thread-abc", subject: "Re: Offer" }),
    ];

    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: emails,
    });
    (window.api.transactions.restoreRemovedEmail as jest.Mock).mockResolvedValue({
      success: true,
      restoredCount: 3,
    });

    const onEmailsChanged = jest.fn().mockResolvedValue(undefined);
    const onShowSuccess = jest.fn();

    render(
      <RemovedEmailsSection
        transactionId={transactionId}
        onEmailsChanged={onEmailsChanged}
        onShowSuccess={onShowSuccess}
        onShowError={jest.fn()}
      />
    );

    // Open
    await act(async () => {
      await userEvent.click(screen.getByTestId("show-removed-emails-toggle"));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("removed-email-card")).toHaveLength(1);
    });

    // Click the single Restore button
    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-email-button"));
    });

    await waitFor(() => {
      // All cards should be gone after restore
      expect(screen.queryByTestId("removed-email-card")).not.toBeInTheDocument();
    });

    expect(onShowSuccess).toHaveBeenCalledWith("3 emails restored");
    expect(onEmailsChanged).toHaveBeenCalled();
  });
});
