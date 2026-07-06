/**
 * Tests — BACKLOG-1869: TransactionEmailsTab scroll+highlight on search navigation
 *
 * Verifies that when a highlight target (from the linked-content search) arrives:
 *   - the matching thread card is scrolled into view,
 *   - the ring highlight class is applied and removed after 2s,
 *   - onHighlightConsumed is called to clear the target after applying,
 *   - an unknown email id results in a graceful no-op,
 *   - the effect waits when loading=true (no premature scroll).
 */
import React from "react";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import type { Communication } from "../../types";
import type { HighlightTarget } from "../../types";

// Minimal auth stub so the component doesn't need a full AuthProvider.
jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

// scrollIntoView is not implemented in jsdom — mock it globally.
const scrollIntoViewMock = jest.fn();
Element.prototype.scrollIntoView = scrollIntoViewMock;

function makeEmail(id: string, threadId: string | null = null): Communication {
  return {
    id,
    user_id: "user-1",
    sender: "alice@example.com",
    subject: "Test Subject",
    sent_at: "2024-01-10T10:00:00Z",
    thread_id: threadId,
    created_at: "2024-01-10T10:00:00Z",
    has_attachments: false,
    is_false_positive: false,
  } as Communication;
}

function renderTab(
  communications: Communication[],
  highlightTarget: HighlightTarget | null,
  onHighlightConsumed: jest.Mock,
) {
  return render(
    <TransactionEmailsTab
      communications={communications}
      loading={false}
      unlinkingCommId={null}
      onViewEmail={jest.fn()}
      onShowUnlinkConfirm={jest.fn()}
      highlightTarget={highlightTarget}
      onHighlightConsumed={onHighlightConsumed}
    />,
  );
}

beforeEach(() => {
  scrollIntoViewMock.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("TransactionEmailsTab — BACKLOG-1869 highlight on search navigation", () => {
  it("scrolls to the matching thread card and calls onHighlightConsumed", () => {
    const onHighlightConsumed = jest.fn();
    // email "e-1" belongs to thread "t-abc"; processEmailThreads produces key "thread-t-abc".
    const comm = makeEmail("e-1", "t-abc");

    renderTab([comm], { type: "email", emailId: "e-1" }, onHighlightConsumed);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });

  it("applies the ring class on the matching card", () => {
    const comm = makeEmail("e-1", "t-abc");
    renderTab([comm], { type: "email", emailId: "e-1" }, jest.fn());

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();
    expect(el!.classList).toContain("ring-2");
  });

  it("removes the ring class after 2s", () => {
    const comm = makeEmail("e-1", "t-abc");
    renderTab([comm], { type: "email", emailId: "e-1" }, jest.fn());

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(el!.classList).not.toContain("ring-2");
  });

  it("no-ops gracefully when the email id is not found in any thread", () => {
    const onHighlightConsumed = jest.fn();
    const comm = makeEmail("e-1", "t-abc");

    renderTab([comm], { type: "email", emailId: "unknown-email" }, onHighlightConsumed);

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    // Target still consumed — no re-flash on re-renders.
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });

  it("does not scroll while loading is true", () => {
    const onHighlightConsumed = jest.fn();
    const comm = makeEmail("e-1", "t-abc");

    render(
      <TransactionEmailsTab
        communications={[comm]}
        loading={true}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        highlightTarget={{ type: "email", emailId: "e-1" }}
        onHighlightConsumed={onHighlightConsumed}
      />,
    );

    // Effect exits early when loading=true — target is preserved for later.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(onHighlightConsumed).not.toHaveBeenCalled();
  });
});
