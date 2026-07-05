/**
 * RTL Tests — BACKLOG-1719: bulk RESTORE in the removed sections
 *
 * Verifies multi-select bulk restore for BOTH the removed Emails and removed
 * Messages sections (shared useRemovedSection machinery):
 *  - restore is called sequentially once per selected group,
 *  - a SINGLE silent parent refresh (onRestoreComplete) at the end + one toast,
 *  - the section stays open and the scroll container's scrollTop is NEVER
 *    written (no loading cycle → no scroll jump — the BACKLOG-1780/1793 invariant
 *    now extended to the bulk path).
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedEmailsSection } from "../RemovedEmailsSection";
import { RemovedMessagesSection } from "../RemovedMessagesSection";

const first = (testId: string) => screen.getAllByTestId(testId)[0];

function makeRemovedEmail(o: { ignored_id: string; email_id: string; thread_id?: string | null; subject?: string }) {
  return {
    ignored_id: o.ignored_id, ic_email_id: null, reason: "Manually unlinked",
    ignored_at: "2024-02-01T10:00:00Z", email_id: o.email_id, subject: o.subject ?? "Test",
    sender: "alice@example.com", recipients: "bob@example.com", cc: null,
    sent_at: "2024-01-15T10:00:00Z", thread_id: o.thread_id ?? null,
    body_preview: null, body_plain: null, has_attachments: false, source: "gmail",
  };
}

function makeRemovedMessage(o: { ignored_id: string; message_id: string; thread_id?: string }) {
  return {
    ignored_id: o.ignored_id, ic_thread_id: o.thread_id ?? null, reason: "Manually unlinked",
    ignored_at: "2024-02-01T10:00:00Z", message_id: o.message_id, body: "hello",
    subject: null, channel: "sms", thread_id: o.thread_id ?? null,
    sent_at: "2024-01-15T10:00:00Z", received_at: null,
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    participants_flat: "+14155550100", direction: "inbound",
  };
}

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getRemovedEmails = jest.fn();
  (window.api.transactions as any).restoreRemovedEmail = jest.fn();
  (window.api.transactions as any).getRemovedMessages = jest.fn();
  (window.api.transactions as any).restoreRemovedMessage = jest.fn();
  (window.api.contacts as any).resolveHandles = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
  jest.spyOn(window, "scrollTo").mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.contacts.resolveHandles as jest.Mock).mockResolvedValue({ success: true, names: {} });
});

describe("RemovedEmailsSection — BACKLOG-1719 bulk restore", () => {
  it("restores every selected group, one silent refresh + toast, no scroll write", async () => {
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: [
        makeRemovedEmail({ ignored_id: "ig-1", email_id: "e-1", thread_id: "t-aaa", subject: "Offer" }),
        makeRemovedEmail({ ignored_id: "ig-2", email_id: "e-2", thread_id: "t-bbb", subject: "Counter" }),
      ],
    });
    (window.api.transactions.restoreRemovedEmail as jest.Mock).mockResolvedValue({ success: true, restoredCount: 1 });

    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);
    const onShowSuccess = jest.fn();

    // Track scrollTop writes on the render container.
    const container = document.createElement("div");
    let scrollTopValue = 640;
    let scrollTopWrites = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTopValue,
      set: (v: number) => { scrollTopValue = v; scrollTopWrites++; },
      configurable: true,
    });
    document.body.appendChild(container);

    render(
      <RemovedEmailsSection
        transactionId="txn-1"
        isOpen={true}
        onOpenChange={jest.fn()}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={onShowSuccess}
        onShowError={jest.fn()}
      />,
      { container }
    );

    await waitFor(() => expect(screen.getAllByTestId("removed-email-card")).toHaveLength(2));

    // Enter selection mode, select both groups.
    await userEvent.click(screen.getByTestId("select-removed-emails"));
    const checks = screen.getAllByTestId("removed-group-select");
    expect(checks).toHaveLength(2);
    for (const c of checks) await userEvent.click(c);

    // Bulk restore.
    await act(async () => {
      await userEvent.click(first("removed-emails-section-bulk-restore"));
    });

    await waitFor(() => {
      expect(window.api.transactions.restoreRemovedEmail).toHaveBeenCalledTimes(2);
    });

    // One silent refresh + one toast reflecting the 2 restored emails.
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
    expect(onShowSuccess).toHaveBeenCalledWith("2 emails restored");

    // Both cards gone, section still open, scroll untouched.
    await waitFor(() => expect(screen.queryByTestId("removed-email-card")).not.toBeInTheDocument());
    expect(screen.getByTestId("removed-emails-section")).toBeInTheDocument();
    expect(scrollTopWrites).toBe(0);
    expect(scrollTopValue).toBe(640);

    document.body.removeChild(container);
  });
});

describe("RemovedMessagesSection — BACKLOG-1719 bulk restore", () => {
  it("restores every selected conversation, one silent refresh + toast, no scroll write", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [
        makeRemovedMessage({ ignored_id: "ig-1", message_id: "m-1", thread_id: "t-1" }),
        makeRemovedMessage({ ignored_id: "ig-2", message_id: "m-2", thread_id: "t-2" }),
      ],
    });
    (window.api.transactions.restoreRemovedMessage as jest.Mock).mockResolvedValue({ success: true, restoredCount: 1 });

    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);
    const onShowSuccess = jest.fn();

    const container = document.createElement("div");
    let scrollTopValue = 500;
    let scrollTopWrites = 0;
    Object.defineProperty(container, "scrollTop", {
      get: () => scrollTopValue,
      set: (v: number) => { scrollTopValue = v; scrollTopWrites++; },
      configurable: true,
    });
    document.body.appendChild(container);

    render(
      <RemovedMessagesSection
        transactionId="txn-1"
        isOpen={true}
        onOpenChange={jest.fn()}
        onRestoreComplete={onRestoreComplete}
        onShowSuccess={onShowSuccess}
        onShowError={jest.fn()}
      />,
      { container }
    );

    await waitFor(() => expect(screen.getAllByTestId("removed-thread-card")).toHaveLength(2));

    await userEvent.click(screen.getByTestId("select-removed-messages"));
    const checks = screen.getAllByTestId("removed-group-select");
    expect(checks).toHaveLength(2);
    for (const c of checks) await userEvent.click(c);

    await act(async () => {
      await userEvent.click(first("removed-messages-section-bulk-restore"));
    });

    await waitFor(() => {
      expect(window.api.transactions.restoreRemovedMessage).toHaveBeenCalledTimes(2);
    });

    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
    expect(onShowSuccess).toHaveBeenCalledWith("2 conversations restored");

    await waitFor(() => expect(screen.queryByTestId("removed-thread-card")).not.toBeInTheDocument());
    expect(screen.getByTestId("removed-messages-section")).toBeInTheDocument();
    expect(scrollTopWrites).toBe(0);
    expect(scrollTopValue).toBe(500);

    document.body.removeChild(container);
  });
});
