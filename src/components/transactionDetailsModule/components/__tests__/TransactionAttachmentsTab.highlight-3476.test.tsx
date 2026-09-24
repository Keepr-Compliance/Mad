/**
 * BACKLOG-3476 — "Open in Attachments" from a checklist chip (control C-Q).
 *
 * Wrong implementations this suite is here to catch:
 *   - the jump lands on a card a filter is hiding (nothing visible happens);
 *   - the highlight never lets go (the target is never consumed);
 *   - a highlight meant for another tab (email/text) is taken here.
 * Attachments are the producer-generated fixture.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionAttachmentsTab } from "../TransactionAttachmentsTab";
import { fixtureAttachments } from "../checklist/__tests__/checklistFixture";
import type { HighlightTarget } from "../../types";

jest.mock("../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));

function Harness({ target, onConsumed }: { target: HighlightTarget | null; onConsumed: () => void }) {
  return (
    <TransactionAttachmentsTab
      attachments={fixtureAttachments()}
      loading={false}
      error={null}
      highlightTarget={target}
      onHighlightConsumed={onConsumed}
    />
  );
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("TransactionAttachmentsTab highlight (BACKLOG-3476)", () => {
  it("clears a Source filter that hides the card, rings it, then lets go", () => {
    const onConsumed = jest.fn();
    const { rerender } = render(<Harness target={null} onConsumed={onConsumed} />);

    // Filter to texts only: the email attachment att-1 is hidden.
    fireEvent.click(screen.getByTestId("source-filter-trigger"));
    fireEvent.click(screen.getByTestId("source-filter-checkbox-text"));
    expect(screen.queryByTestId("attachment-card-att-1")).not.toBeInTheDocument();

    rerender(<Harness target={{ type: "attachment", attachmentId: "att-1" }} onConsumed={onConsumed} />);
    act(() => {
      jest.advanceTimersByTime(0);
    });
    const card = screen.getByTestId("attachment-card-att-1");
    expect(card).toHaveAttribute("data-highlighted", "true");
    expect(card.className).toContain("ring-blue-600");
    expect(onConsumed).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("attachment-card-att-1")).not.toHaveAttribute("data-highlighted");
  });

  it("an attachment no longer on the transaction is consumed at once", () => {
    const onConsumed = jest.fn();
    render(<Harness target={{ type: "attachment", attachmentId: "gone" }} onConsumed={onConsumed} />);
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("an email highlight is not this tab's", () => {
    const onConsumed = jest.fn();
    render(<Harness target={{ type: "email", emailId: "e-solo-1" }} onConsumed={onConsumed} />);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(onConsumed).not.toHaveBeenCalled();
    expect(document.querySelector("[data-highlighted]")).toBeNull();
  });
});
