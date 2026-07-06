/**
 * Tests — BACKLOG-1869: TransactionEmailsTab scroll+highlight on search navigation
 *
 * Verifies that when a highlight target (from the linked-content search) arrives:
 *   - the matching thread card is scrolled into view,
 *   - the ring highlight class is applied,
 *   - the ring is removed after 2s in a production-equivalent flow where
 *     onHighlightConsumed actually nulls the target (stateful wrapper test),
 *   - onHighlightConsumed is called after ring removal (inside the 2s timer),
 *   - an unknown email id results in a graceful no-op (with immediate consume),
 *   - the effect waits when loading=true (no premature scroll).
 */
import React, { useState } from "react";
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

/**
 * Stateful wrapper that mirrors how TransactionDetails passes highlightTarget —
 * onHighlightConsumed calls setHighlightTarget(null) triggering a real re-render.
 * This is the exact flow that exposed the timer-cancel bug (SR-review item #1):
 * calling onHighlightConsumed before the timer caused the effect cleanup to fire
 * and clearTimeout the 2s ring-removal timer before it could run.
 */
function StatefulEmailsTab({ communications }: { communications: Communication[] }) {
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>({
    type: "email",
    emailId: "e-1",
  });
  return (
    <TransactionEmailsTab
      communications={communications}
      loading={false}
      unlinkingCommId={null}
      onViewEmail={jest.fn()}
      onShowUnlinkConfirm={jest.fn()}
      highlightTarget={highlightTarget}
      onHighlightConsumed={() => setHighlightTarget(null)}
    />
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
  it("scrolls to the matching thread card", () => {
    // email "e-1" belongs to thread "t-abc"; processEmailThreads produces key "thread-t-abc".
    const comm = makeEmail("e-1", "t-abc");
    render(<StatefulEmailsTab communications={[comm]} />);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("applies the ring class on the matching card", () => {
    const comm = makeEmail("e-1", "t-abc");
    render(<StatefulEmailsTab communications={[comm]} />);

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();
    expect(el!.classList).toContain("ring-2");
  });

  /**
   * KEY TEST (SR review item #1): ring must be gone after 2s when the parent
   * uses real state for onHighlightConsumed. With the old (buggy) code:
   *   onHighlightConsumed() was called BEFORE the timer → setHighlightTarget(null)
   *   → React re-render → effect cleanup → clearTimeout → ring never removed.
   * With the fix: onHighlightConsumed is called INSIDE the timer callback so
   * the state update can't cancel its own cleanup.
   */
  it("ring is removed after 2s when parent state actually nulls the target (production flow)", () => {
    const comm = makeEmail("e-1", "t-abc");
    render(<StatefulEmailsTab communications={[comm]} />);

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();
    expect(el!.classList).toContain("ring-2");

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(el!.classList).not.toContain("ring-2");
  });

  it("calls onHighlightConsumed after 2s (inside the timer, not before)", () => {
    const onHighlightConsumed = jest.fn();
    const comm = makeEmail("e-1", "t-abc");
    render(
      <TransactionEmailsTab
        communications={[comm]}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        highlightTarget={{ type: "email", emailId: "e-1" }}
        onHighlightConsumed={onHighlightConsumed}
      />,
    );

    // Not yet — consume only fires after ring removal
    expect(onHighlightConsumed).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });

  it("no-ops gracefully when the email id is not found (immediately consumes target)", () => {
    const onHighlightConsumed = jest.fn();
    const comm = makeEmail("e-1", "t-abc");

    render(
      <TransactionEmailsTab
        communications={[comm]}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        highlightTarget={{ type: "email", emailId: "unknown-email" }}
        onHighlightConsumed={onHighlightConsumed}
      />,
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    // Unknown target consumed immediately so parent can clear stale state.
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
