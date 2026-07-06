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

  /**
   * FRESH-MOUNT RACE (the defect confirmed by founder testing):
   *
   * Cross-tab navigation: the tab mounts fresh with highlightTarget already set.
   * The highlight useEffect fires before React has committed the thread card elements
   * to the DOM, so querySelector returns null. The OLD code bailed immediately,
   * consuming the target with no ring. The NEW code retries for up to ~500 ms.
   *
   * We simulate this by patching document.querySelector to return null on the first
   * data-thread-id lookup, then the real element on subsequent calls.
   */
  it("applies highlight after fresh-mount delay — retry finds card on next frame (cross-tab race fix)", () => {
    const onHighlightConsumed = jest.fn();
    const comm = makeEmail("e-1", "t-abc");

    // Patch querySelector: first data-thread-id query returns null (DOM not yet painted),
    // subsequent queries return the real element.
    const originalQS = document.querySelector.bind(document);
    let firstDataThreadIdQuery = true;
    const qsPatch = (sel: string): Element | null => {
      if (sel.startsWith("[data-thread-id") && firstDataThreadIdQuery) {
        firstDataThreadIdQuery = false;
        return null;
      }
      return originalQS(sel);
    };
    document.querySelector = qsPatch as typeof document.querySelector;

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

    // Initial effect ran: querySelector returned null → retry timer scheduled.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(onHighlightConsumed).not.toHaveBeenCalled();

    // Advance one retry frame (16 ms) — card is now findable in the DOM.
    act(() => {
      jest.advanceTimersByTime(16);
    });

    // Retry found the card — inset ring and background flash applied.
    const el = originalQS("[data-thread-id]") as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.classList).toContain("ring-2");
    expect(el!.classList).toContain("ring-inset");
    expect(el!.classList).toContain("bg-blue-50");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });

    // Consume fires after 2s ring timer, not before.
    expect(onHighlightConsumed).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
    // Ring and flash removed after 2s.
    expect(el!.classList).not.toContain("ring-2");
    expect(el!.classList).not.toContain("bg-blue-50");

    document.querySelector = originalQS as typeof document.querySelector;
  });

  /**
   * REACT-STATE REMOUNT REGRESSION (BACKLOG-1869 proven root cause):
   *
   * Both EmailsTab and MessagesTab use an early `if (loading) { return <spinner> }`,
   * so the card list unmounts when loading=true and remounts when loading=false.
   *
   * Old DOM-mutation approach: element destroyed on remount → ring gone forever.
   * New React-state approach: new card renders with isHighlighted=true from parent
   *   state → ring classes re-asserted in className automatically → 2s timer removes.
   *
   * The `el` variable must be re-queried after loading=false because the DOM element
   * is replaced (old detached element would show a stale classList snapshot).
   */
  it("ring re-appears after card remount caused by loading flip (state-driven, remount-proof)", () => {
    const onHighlightConsumed = jest.fn();
    const comm = makeEmail("e-1", "t-abc");
    const baseProps = {
      communications: [comm],
      loading: false,
      unlinkingCommId: null,
      onViewEmail: jest.fn(),
      onShowUnlinkConfirm: jest.fn(),
      highlightTarget: { type: "email" as const, emailId: "e-1" },
      onHighlightConsumed,
    };

    const { rerender } = render(<TransactionEmailsTab {...baseProps} />);

    // Initial: card present and highlighted
    expect(document.querySelector("[data-thread-id]")).not.toBeNull();
    expect(document.querySelector("[data-thread-id]")!.classList).toContain("ring-2");

    // Loading flip: EmailsTab renders spinner only — card list unmounts completely.
    rerender(<TransactionEmailsTab {...baseProps} loading={true} />);
    expect(document.querySelector("[data-thread-id]")).toBeNull(); // card gone during load

    // Loading done: card remounts. isHighlighted=true (highlightedThreadId still set in
    // parent state) → ring re-asserted by React render, not classList manipulation.
    rerender(<TransactionEmailsTab {...baseProps} loading={false} />);
    const remountedEl = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(remountedEl).not.toBeNull();
    expect(remountedEl!.classList).toContain("ring-2"); // ring re-asserted on remount

    // onHighlightConsumed must not fire until the 2s ring timer fires
    expect(onHighlightConsumed).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // Timer fired: setHighlightedThreadId(null) → isHighlighted=false → no ring classes
    expect(remountedEl!.classList).not.toContain("ring-2");
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });
});
