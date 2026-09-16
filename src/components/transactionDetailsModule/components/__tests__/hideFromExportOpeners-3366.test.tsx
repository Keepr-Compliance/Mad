/**
 * BACKLOG-3366 U1 — the Hide / Unhide control appears ONLY in a conversation
 * opened from a transaction's linked list.
 *
 * `ConversationViewModal` has four openers. Only the first may pass the
 * control:
 *   1. TransactionMessagesTab's linked conversations       -> control
 *   2. the "Show removed" list inside that same tab        -> none
 *   3. the Needs-review queue inside that same tab         -> none
 *   4. the contact card (useContactCommViewers)            -> none
 *
 * 2 and 3 sit INSIDE the tab, where `transactionId` is in scope, so the likely
 * leak is one prop added at their mount. That is why this suite renders the
 * REAL openers — the real tab with its real removed section and real review
 * section, and the real contact-card hook — rather than a card without the
 * callback, which could not see either leak.
 *
 * The entitlement hook is wrapped so each test chooses. By DEFAULT it runs the
 * SHIPPED stand-in, and the stand-in test at the end turns red if it is ever
 * flipped to "allowed".
 */
import React from "react";
import { render as rtlRender, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../../../contexts/NotificationContext";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import { ReviewQueueSection } from "../ReviewQueueSection";
import { useContactCommViewers } from "../../../../hooks/useContactCommViewers";
import type { Communication } from "../../types";
import type { ContactMessageThread } from "@/types";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";
import type { HideFromExportState } from "../../../../hooks/useHideFromExportState";

const mockHideState = jest.fn<HideFromExportState, []>();
jest.mock("../../../../hooks/useHideFromExportState", () => ({
  useHideFromExportState: () => mockHideState(),
}));
const SHIPPED_STAND_IN = jest.requireActual("../../../../hooks/useHideFromExportState") as {
  useHideFromExportState: () => HideFromExportState;
};

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: NotificationProvider });

const TXN = "txn-3366-openers";

/** Rows in the shape the shared conversation read returns (marker 0/1). */
function linkedRow(id: string, body: string, hidden: 0 | 1, sentAt: string): Communication {
  return {
    id,
    communication_id: `comm-${id}`,
    user_id: "user-3366",
    transaction_id: TXN,
    message_id: id,
    email_id: null,
    channel: "imessage",
    communication_type: "imessage",
    body_text: body,
    body_plain: body,
    body: null,
    subject: null,
    sender: "+15550100",
    recipients: "me",
    sent_at: sentAt,
    received_at: null,
    has_attachments: 0,
    thread_id: "macos-chat-linked",
    participants: JSON.stringify({ from: "+15550100", to: ["me"] }),
    thread_display_name: null,
    direction: "inbound",
    external_id: `guid-${id}`,
    associated_message_type: null,
    associated_message_guid: null,
    hidden_from_export: hidden,
  } as unknown as Communication;
}

const LINKED = [
  linkedRow("m-visible", "linked visible text", 0, "2026-01-02T10:00:00Z"),
  linkedRow("m-hidden", "linked hidden text", 1, "2026-01-03T10:00:00Z"),
];

// Transcribed from reviewCardParity-2791's text item.
const REVIEW_TEXT: ReviewItemDto = {
  id: "pending:t-3366",
  rowId: "t-3366",
  origin: "pending",
  kind: "text",
  transaction_id: TXN,
  email_id: null,
  thread_id: "th-review",
  found_at: "2026-08-01T00:00:00.000Z",
  display: {
    title: "+15555550142",
    subtitle: "+15555550142",
    snippet: "review queue text",
    occurredAt: "2026-01-04T00:00:00.000Z",
    itemCount: 1,
    threadId: "th-review",
    recipients: null,
    cc: null,
    sender: "+15555550142",
    body: null,
    bodyText: null,
    hasAttachments: false,
    threadParticipants: ["+15555550142"],
    threadMessages: [
      {
        id: "m-review",
        thread_id: "th-review",
        body_text: "review queue text",
        sent_at: "2026-01-04T00:00:00.000Z",
        direction: "inbound",
        participants: null,
        thread_display_name: null,
        participants_flat: "+15555550142",
        channel: "sms",
      },
    ],
  },
} as ReviewItemDto;

// Transcribed from RemovedMessagesSection-1793's removed-message fixture.
const REMOVED_MESSAGE = {
  ignored_id: "ig-3366",
  ic_thread_id: null,
  reason: "Manually unlinked by user",
  ignored_at: "2026-02-01T10:00:00Z",
  message_id: "m-removed",
  body: "removed conversation text",
  subject: null,
  channel: "sms",
  thread_id: "t-removed",
  sent_at: "2026-01-05T10:00:00Z",
  received_at: null,
  participants: JSON.stringify({ from: "+14155550100", to: ["me"], chat_members: ["+14155550100"] }),
  participants_flat: null,
  direction: "inbound",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockHideState.mockImplementation(() => SHIPPED_STAND_IN.useHideFromExportState());
  (window.api.transactions.getRemovedMessages as jest.Mock).mockResolvedValue({
    success: true,
    removedMessages: [REMOVED_MESSAGE],
  });
});

const controls = (): HTMLElement[] => screen.queryAllByTestId(/^hide-from-export-/);

function renderTab(): void {
  render(
    <TransactionMessagesTab
      messages={LINKED}
      loading={false}
      error={null}
      userId="user-3366"
      transactionId={TXN}
      hasReviewItems
      reviewSection={
        <ReviewQueueSection
          items={[REVIEW_TEXT]}
          kind="text"
          onApprove={jest.fn().mockResolvedValue(undefined)}
          onReject={jest.fn().mockResolvedValue(undefined)}
        />
      }
    />,
  );
}

/** Open the conversation behind `card`, return the control count, close it. */
async function controlsInConversationOf(card: HTMLElement): Promise<number> {
  expect(controls()).toHaveLength(0);
  fireEvent.click(within(card).getByTestId("toggle-thread-button"));
  const close = await screen.findByRole("button", { name: "Close" });
  const count = controls().length;
  fireEvent.click(close);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument());
  return count;
}

describe("BACKLOG-3366 U1 — hiding is offered only on the transaction's linked conversations", () => {
  it("linked conversation: controls present; removed list and review queue in the SAME tab: none", async () => {
    mockHideState.mockReturnValue("allowed");
    renderTab();

    // 1. Linked.
    const linkedCard = within(screen.getByTestId("message-thread-list")).getByTestId("message-thread-card");
    expect(await controlsInConversationOf(linkedCard)).toBe(2);

    // 3. Review queue.
    const reviewCard = screen.getByTestId("review-item");
    expect(await controlsInConversationOf(reviewCard)).toBe(0);

    // 2. Removed list, expanded.
    fireEvent.click(screen.getByTestId("show-removed-messages-toggle"));
    const removedCard = await screen.findByTestId("removed-thread-card");
    expect(await controlsInConversationOf(removedCard)).toBe(0);
  });

  it("contact card viewer: none, even for a hidden-marked text with hiding allowed", async () => {
    mockHideState.mockReturnValue("allowed");
    let open: ((thread: ContactMessageThread) => void) | null = null;
    function ContactCardHarness(): React.ReactElement {
      const { openThread, viewers } = useContactCommViewers({ userId: "user-3366" });
      open = openThread;
      return viewers;
    }
    render(<ContactCardHarness />);

    act(() => {
      open!({
        thread_id: "macos-chat-linked",
        phoneNumber: "+15550100",
        transaction_id: TXN,
        messages: LINKED as unknown as ContactMessageThread["messages"],
      });
    });
    await screen.findByRole("button", { name: "Close" });
    expect(screen.getByText("linked hidden text")).toBeInTheDocument();
    expect(controls()).toHaveLength(0);
  });
});

describe("BACKLOG-3366 — the SHIPPED stand-in", () => {
  it("offers no Hide from export on a linked conversation, but still offers Unhide", async () => {
    renderTab();

    const linkedCard = within(screen.getByTestId("message-thread-list")).getByTestId("message-thread-card");
    fireEvent.click(within(linkedCard).getByTestId("toggle-thread-button"));
    await screen.findByRole("button", { name: "Close" });

    expect(screen.queryByRole("button", { name: "Hide from export" })).not.toBeInTheDocument();
    expect(screen.getByTestId("hide-from-export-m-hidden")).toHaveAccessibleName("Unhide");
    expect(controls()).toHaveLength(1);
  });
});
