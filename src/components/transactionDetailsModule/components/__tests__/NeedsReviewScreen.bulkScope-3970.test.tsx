/**
 * BACKLOG-3970 — Approve all / Reject all act on the EMAILS the selected filter shows,
 * never texts, and are hidden on the Texts tab.
 *
 * Fixture builder transcribed from reviewMatchTabs-3925.test.tsx (shaped as
 * getReviewState projects items, reviewStateService.ts). Text rows: kind "text",
 * email_id null, thread_id set, matchReason "contact" (the default every text gets).
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NeedsReviewScreen } from "../NeedsReviewScreen";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";
import type { ReviewMatchReason } from "../../../../../electron/types/ipc/reviewMatchReason";

function item(id: string, threadId: string, matchReason: ReviewMatchReason, kind: "email" | "text" = "email"): ReviewItemDto {
  return {
    id: `pending:${id}`,
    rowId: id,
    origin: "pending",
    kind,
    transaction_id: "tx-1",
    email_id: kind === "email" ? `e-${id}` : null,
    thread_id: kind === "text" ? threadId : null,
    found_at: "2026-08-01T00:00:00.000Z",
    matchReason,
    display: {
      title: `Subject ${id}`,
      subtitle: "someone@example.test",
      snippet: "Body.",
      occurredAt: "2026-03-01T00:00:00.000Z",
      itemCount: 1,
      threadId,
      recipients: "me@example.test",
      cc: null,
      sender: "someone@example.test",
      body: null,
      bodyText: "Body.",
      hasAttachments: false,
      threadParticipants: kind === "text" ? ["+12065550100"] : [],
      threadMessages: [],
    },
  };
}

const ITEMS: ReviewItemDto[] = [
  item("1", "th-1", "contact"),
  item("2", "th-2", "address"),
  item("3a", "th-3", "contact"),
  item("3b", "th-3", "address"),
  item("4", "th-4", "folder"),
  item("t1", "chat-1", "contact", "text"),
];

function renderScreen() {
  const onApprove = jest.fn().mockResolvedValue(undefined);
  const onReject = jest.fn().mockResolvedValue(undefined);
  render(<NeedsReviewScreen items={ITEMS} isLoading={false} onApprove={onApprove} onReject={onReject} onClose={jest.fn()} />);
  return { onApprove, onReject };
}

describe("BACKLOG-3970 bulk actions are emails only", () => {
  it("All with a text in the queue: Approve all sends every email id and no text id", async () => {
    const { onApprove } = renderScreen();
    fireEvent.click(screen.getByText("Approve all"));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect([...onApprove.mock.calls[0][0]].sort()).toEqual(["pending:1", "pending:2", "pending:3a", "pending:3b", "pending:4"]);
  });

  it("Texts tab: no Approve all / Reject all", () => {
    renderScreen();
    fireEvent.click(screen.getByTestId("needs-review-tab-text"));
    expect(screen.queryByText("Approve all")).toBeNull();
    expect(screen.queryByText("Reject all")).toBeNull();
  });

  it("Address filter, to Texts and back to Emails: Reject all keeps the filter and excludes texts", async () => {
    const { onReject } = renderScreen();
    fireEvent.click(screen.getByTestId("needs-review-filter-address"));
    fireEvent.click(screen.getByTestId("needs-review-tab-text"));
    fireEvent.click(screen.getByTestId("needs-review-tab-email"));
    fireEvent.click(screen.getByText("Reject all"));
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect([...onReject.mock.calls[0][0]].sort()).toEqual(["pending:2", "pending:3a", "pending:3b"]);
  });

  it("Folder / label filter: Approve all sends only the folder thread", async () => {
    const { onApprove } = renderScreen();
    fireEvent.click(screen.getByTestId("needs-review-filter-folder"));
    fireEvent.click(screen.getByText("Approve all"));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][0]).toEqual(["pending:4"]);
  });
});
