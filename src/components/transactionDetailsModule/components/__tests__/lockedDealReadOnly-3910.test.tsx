/**
 * BACKLOG-3910 (fix-up round 2): on a locked deal the Needs Review approve and
 * reject buttons and every Removed section's restore buttons are disabled with
 * the "Read-only..." text. Open deals (no tooltip) keep them enabled.
 *
 * Each pair is an open case beside a locked case, so a button that is always
 * disabled, or never disabled, fails one of the two.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ReviewQueueSection } from "../ReviewQueueSection";
import { NeedsReviewScreen } from "../NeedsReviewScreen";
import { RemovedEmailsSection } from "../RemovedEmailsSection";
import { RemovedMessagesSection } from "../RemovedMessagesSection";
import { RemovedTransactionContactsSection } from "../RemovedTransactionContactsSection";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";
import { DEAL_LOCK_EDIT_TOOLTIP } from "../../../../utils/dealLock";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const LOCK = DEAL_LOCK_EDIT_TOOLTIP.submitted;
const noop = async () => undefined;

// Shape transcribed from reviewQueueSameSet-2791.test.tsx's item(), itself the ReviewItemDto producer output.
function item(over: Partial<ReviewItemDto> & { id: string }): ReviewItemDto {
  return {
    origin: "pending",
    kind: "email",
    rowId: over.id.split(":")[1] ?? over.id,
    transaction_id: "tx-1",
    email_id: "e-1",
    thread_id: null,
    found_at: "2026-08-01T00:00:00.000Z",
    display: {
      title: "Subject",
      subtitle: "paul@example.com",
      snippet: "hello",
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
      threadId: "thr-1",
      recipients: "me@example.com",
      cc: null,
      sender: "paul@example.com",
      body: null,
      bodyText: null,
      hasAttachments: false,
      threadParticipants: ["+15550142"],
      threadMessages: [
        {
          id: "m-1",
          thread_id: "th-1",
          body_text: "hello",
          sent_at: "2026-06-01T00:00:00.000Z",
          direction: "inbound",
          participants: null,
          thread_display_name: null,
          participants_flat: "+15550142",
          channel: "sms",
        },
      ],
    },
    ...over,
  };
}
const EMAIL_ITEM = item({ id: "pending:p1", kind: "email", email_id: "e1" });
const TEXT_ITEM = item({ id: "pending:t1", kind: "text", email_id: null, thread_id: "th-1" });

describe("Needs Review approve/reject on a locked deal", () => {
  for (const kind of ["email", "text"] as const) {
    const items = [kind === "email" ? EMAIL_ITEM : TEXT_ITEM];
    it(`${kind} cards: open = enabled, locked = disabled with the tooltip`, () => {
      const { unmount } = render(
        <ReviewQueueSection items={items} kind={kind} onApprove={noop} onReject={noop} />,
      );
      expect(screen.getByTestId("confirm-thread-button")).toBeEnabled();
      expect(screen.getByTestId("unlink-thread-button")).toBeEnabled();
      unmount();
      render(
        <ReviewQueueSection items={items} kind={kind} onApprove={noop} onReject={noop} actionsLockedTooltip={LOCK} />,
      );
      expect(screen.getByTestId("confirm-thread-button")).toBeDisabled();
      expect(screen.getByTestId("confirm-thread-button")).toHaveAttribute("title", LOCK);
      expect(screen.getByTestId("unlink-thread-button")).toBeDisabled();
      expect(screen.getByTestId("unlink-thread-button")).toHaveAttribute("title", LOCK);
    });
  }

  it("review screen: Approve all / Reject all and the cards follow the lock", () => {
    const { unmount } = render(
      <NeedsReviewScreen items={[EMAIL_ITEM]} isLoading={false} onApprove={noop} onReject={noop} onClose={jest.fn()} />,
    );
    expect(screen.getByText("Approve all")).toBeEnabled();
    expect(screen.getByText("Reject all")).toBeEnabled();
    expect(screen.getByTestId("confirm-thread-button")).toBeEnabled();
    unmount();
    render(
      <NeedsReviewScreen
        items={[EMAIL_ITEM]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={jest.fn()}
        actionsLockedTooltip={LOCK}
      />,
    );
    expect(screen.getByText("Approve all")).toBeDisabled();
    expect(screen.getByText("Reject all")).toBeDisabled();
    expect(screen.getByText("Approve all")).toHaveAttribute("title", LOCK);
    expect(screen.getByTestId("confirm-thread-button")).toBeDisabled();
    expect(screen.getByTestId("unlink-thread-button")).toBeDisabled();
  });
});

describe("Removed sections' restore buttons on a locked deal", () => {
  beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (window.api.transactions as any).getRemovedEmails = jest.fn();
    (window.api.transactions as any).getRemovedMessages = jest.fn();
    (window.api.transactions as any).getRemovedContacts = jest.fn();
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  it("emails", async () => {
    (window.api.transactions.getRemovedEmails as jest.Mock).mockResolvedValue({
      success: true,
      removedEmails: [
        {
          ignored_id: "ig-1", ic_email_id: null, reason: "Manually unlinked by user",
          ignored_at: "2024-01-10T10:00:00Z", email_id: "e-1", subject: "S", sender: "a@example.com",
          recipients: "b@example.com", cc: null, sent_at: "2024-01-01T10:00:00Z", thread_id: null,
          body_preview: null, body_plain: null, has_attachments: false, source: "gmail",
        },
      ],
    });
    const common = { transactionId: "txn-1", isOpen: true, onOpenChange: jest.fn() };
    const { unmount } = render(<RemovedEmailsSection {...common} />);
    await waitFor(() => expect(screen.getByTestId("restore-email-button")).toBeEnabled());
    expect(screen.getByTestId("select-removed-emails")).toBeInTheDocument();
    unmount();
    render(<RemovedEmailsSection {...common} restoreLockedTooltip={LOCK} />);
    await waitFor(() => expect(screen.getByTestId("restore-email-button")).toBeDisabled());
    expect(screen.getByTestId("restore-email-button")).toHaveAttribute("title", LOCK);
    expect(screen.queryByTestId("select-removed-emails")).toBeNull();
  });

  it("texts", async () => {
    (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
      success: true,
      removedMessages: [
        {
          ignored_id: "ig-1", ic_thread_id: null, reason: "Manually unlinked by user",
          ignored_at: "2024-02-01T10:00:00Z", message_id: "m-1", body: "hi", subject: null, channel: "sms",
          thread_id: "t-1", sent_at: "2024-01-15T10:00:00Z", received_at: null,
          participants: JSON.stringify({ from: "+14155550100", to: ["me"], chat_members: ["+14155550100"] }),
          participants_flat: null, direction: "inbound",
        },
      ],
    });
    const common = { transactionId: "txn-1", isOpen: true, onOpenChange: jest.fn() };
    const { unmount } = render(<RemovedMessagesSection {...common} />);
    await waitFor(() => expect(screen.getByTestId("restore-removed-message")).toBeEnabled());
    expect(screen.getByTestId("select-removed-messages")).toBeInTheDocument();
    unmount();
    render(<RemovedMessagesSection {...common} restoreLockedTooltip={LOCK} />);
    await waitFor(() => expect(screen.getByTestId("restore-removed-message")).toBeDisabled());
    expect(screen.getByTestId("restore-removed-message")).toHaveAttribute("title", LOCK);
    expect(screen.queryByTestId("select-removed-messages")).toBeNull();
  });

  it("contacts", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [
        {
          id: "tc-1", transaction_id: "txn-1", contact_id: "c-1", role: "listing_agent",
          role_category: "agent", specific_role: "listing_agent", is_primary: 1, notes: null,
          created_at: "2026-08-05 03:08:06", updated_at: "2026-08-05 03:08:06",
          removed_at: "2026-08-05 03:08:06", removed_reason: "Removed from transaction by user",
          contact_removed_at: null, contact_name: "removed-party-fixture", contact_email: "j@example.com",
          contact_phone: "+15550100", contact_company: "Example Realty", contact_title: "Broker",
          contact_source: "manual",
        },
      ],
    });
    const common = { transactionId: "txn-1", transactionType: "purchase" as const, isOpen: true, onOpenChange: jest.fn() };
    const { unmount } = render(<RemovedTransactionContactsSection {...common} />);
    await waitFor(() => expect(screen.getByTestId("restore-transaction-contact-button")).toBeEnabled());
    expect(screen.getByTestId("select-removed-transaction-contacts")).toBeInTheDocument();
    unmount();
    render(<RemovedTransactionContactsSection {...common} restoreLockedTooltip={LOCK} />);
    await waitFor(() => expect(screen.getByTestId("restore-transaction-contact-button")).toBeDisabled());
    expect(screen.getByTestId("restore-transaction-contact-button")).toHaveAttribute("title", LOCK);
    expect(screen.queryByTestId("select-removed-transaction-contacts")).toBeNull();
  });
});
