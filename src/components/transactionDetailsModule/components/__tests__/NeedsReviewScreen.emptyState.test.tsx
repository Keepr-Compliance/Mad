/**
 * NeedsReviewScreen — the "everything is reviewed" empty state.
 *
 * There are TWO empty branches and they are not interchangeable:
 *   - items.length === 0    — nothing left in EITHER medium. This one gained a
 *     🎉 and a "See Transaction" button in the pre-release polish pass.
 *   - shown.length === 0    — the selected medium is empty but the other still
 *     has items. Deliberately untouched, and pinned here so it stays that way.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NeedsReviewScreen } from "../NeedsReviewScreen";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";

const noop = async () => {};

/**
 * Transcribed from the builder in reviewQueueSameSet-2791.test.tsx rather than
 * invented. A hand-made item that misses these fields does not survive
 * `groupReviewItemsByThread`, so the screen renders "0 threads need review" and
 * the third test below would pass for the wrong reason — it would be exercising
 * an empty set, not a one-medium-empty set.
 */
function textItem(id: string, threadId: string): ReviewItemDto {
  return {
    origin: "pending",
    kind: "text",
    rowId: id,
    transaction_id: "tx-1",
    email_id: null,
    thread_id: threadId,
    found_at: "2026-08-01T00:00:00.000Z",
    display: {
      title: "Subject",
      subtitle: "+15550142",
      snippet: "hello",
      occurredAt: "2026-06-01T00:00:00.000Z",
      itemCount: 1,
      threadId,
      recipients: "me@example.com",
      cc: null,
      sender: "+15550142",
      body: null,
      bodyText: null,
      hasAttachments: false,
      threadParticipants: ["+15550142"],
      threadMessages: [
        {
          id: "m-1",
          thread_id: threadId,
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
    id,
  } as unknown as ReviewItemDto;
}

describe("NeedsReviewScreen — empty states", () => {
  it("shows the celebration and a See Transaction button when nothing is left in either medium", () => {
    const onClose = jest.fn();
    render(
      <NeedsReviewScreen
        items={[]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("Everything is reviewed")).toBeInTheDocument();
    expect(screen.getByText("🎉")).toBeInTheDocument();

    const btn = screen.getByTestId("needs-review-empty-see-transaction");
    expect(btn).toHaveTextContent("See Transaction");
    // Same amber->orange gradient as this screen's header, including hovers.
    expect(btn.className).toContain("from-amber-500");
    expect(btn.className).toContain("to-orange-500");
    expect(btn.className).toContain("hover:from-amber-600");
    expect(btn.className).toContain("hover:to-orange-600");
  });

  it("closes via the existing onClose handler, not a new navigation path", () => {
    const onClose = jest.fn();
    render(
      <NeedsReviewScreen
        items={[]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("needs-review-empty-see-transaction"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the other-medium empty state alone — no celebration, no button", () => {
    render(
      <NeedsReviewScreen
        items={[textItem("pending:t1", "th-1")]}
        isLoading={false}
        onApprove={noop}
        onReject={noop}
        onClose={jest.fn()}
      />,
    );

    // Guard first that the fixture survived grouping, or "no celebration" would
    // be trivially true against an empty screen.
    expect(screen.getByTestId("needs-review-header-count")).toHaveTextContent(
      "1 thread need review",
    );

    // The screen opens on the medium that HAS items, so reach the other-medium
    // empty state the way a user does — by switching tabs.
    fireEvent.click(screen.getByTestId("needs-review-tab-email"));

    // The copy is split by a JSX expression, so match the element's own text.
    expect(screen.getByText(/Switch to .* to review the rest\./i)).toBeInTheDocument();

    expect(screen.queryByText("Everything is reviewed")).toBeNull();
    expect(screen.queryByText("🎉")).toBeNull();
    expect(screen.queryByTestId("needs-review-empty-see-transaction")).toBeNull();
  });
});
