/**
 * Tests — BACKLOG-1869: TransactionMessagesTab scroll+highlight on search navigation
 *
 * Verifies that when a highlight target (from the linked-content search) arrives:
 *   - the matching conversation card is scrolled into view,
 *   - the ring highlight class is applied,
 *   - the ring is removed after 2s in a production-equivalent flow where
 *     onHighlightConsumed actually nulls the target (stateful wrapper test),
 *   - onHighlightConsumed is called after ring removal (inside the 2s timer),
 *   - an unknown communicationId results in a graceful no-op (with immediate consume),
 *   - the effect waits when loading=true.
 */
import React, { useState } from "react";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";
import type { HighlightTarget } from "../../types";

// scrollIntoView is not implemented in jsdom — mock it globally.
const scrollIntoViewMock = jest.fn();
Element.prototype.scrollIntoView = scrollIntoViewMock;

// Stub window.api.contacts.resolveHandles so the contact-name lookup useEffect
// in the component doesn't throw when window.api is undefined.
beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    contacts: {
      resolveHandles: jest.fn().mockResolvedValue({ success: true, names: {} }),
    },
  };
});

function makeMessage(id: string, threadId: string): Communication {
  return {
    id,
    user_id: "user-1",
    sender: "+15551234567",
    thread_id: threadId,
    channel: "sms",
    communication_type: "text",
    sent_at: "2024-01-10T10:00:00Z",
    created_at: "2024-01-10T10:00:00Z",
    has_attachments: false,
    is_false_positive: false,
    participants: JSON.stringify({ chat_members: ["+15551234567"] }),
  } as unknown as Communication;
}

/**
 * Stateful wrapper that mirrors how TransactionDetails passes highlightTarget —
 * onHighlightConsumed calls setHighlightTarget(null) triggering a real re-render.
 * This is the exact flow that exposed the timer-cancel bug (SR-review item #1):
 * calling onHighlightConsumed before the timer caused the effect cleanup to fire
 * and clearTimeout the 2s ring-removal timer before it could run.
 */
function StatefulMessagesTab({ messages }: { messages: Communication[] }) {
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>({
    type: "text",
    communicationId: "m-1",
  });
  return (
    <TransactionMessagesTab
      messages={messages}
      loading={false}
      error={null}
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

describe("TransactionMessagesTab — BACKLOG-1869 highlight on search navigation", () => {
  it("scrolls to the matching thread card", () => {
    const msg = makeMessage("m-1", "thread-xyz");
    render(<StatefulMessagesTab messages={[msg]} />);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("applies the ring class on the matching card", () => {
    const msg = makeMessage("m-1", "thread-xyz");
    render(<StatefulMessagesTab messages={[msg]} />);

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
    const msg = makeMessage("m-1", "thread-xyz");
    render(<StatefulMessagesTab messages={[msg]} />);

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
    const msg = makeMessage("m-1", "thread-xyz");

    render(
      <TransactionMessagesTab
        messages={[msg]}
        loading={false}
        error={null}
        highlightTarget={{ type: "text", communicationId: "m-1" }}
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

  it("no-ops gracefully when the communicationId is not found (immediately consumes target)", () => {
    const onHighlightConsumed = jest.fn();
    const msg = makeMessage("m-1", "thread-xyz");

    render(
      <TransactionMessagesTab
        messages={[msg]}
        loading={false}
        error={null}
        highlightTarget={{ type: "text", communicationId: "unknown-comm" }}
        onHighlightConsumed={onHighlightConsumed}
      />,
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    // Unknown target consumed immediately so parent can clear stale state.
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });

  it("does not scroll while loading is true", () => {
    const onHighlightConsumed = jest.fn();
    const msg = makeMessage("m-1", "thread-xyz");

    render(
      <TransactionMessagesTab
        messages={[msg]}
        loading={true}
        error={null}
        highlightTarget={{ type: "text", communicationId: "m-1" }}
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
    const msg = makeMessage("m-1", "thread-xyz");

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
      <TransactionMessagesTab
        messages={[msg]}
        loading={false}
        error={null}
        highlightTarget={{ type: "text", communicationId: "m-1" }}
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
   * STRUCTURAL FIX REGRESSION (BACKLOG-1869 root cause confirmed by debug trace):
   *
   * handleNavigateToTab fires when loading=true; the subsequent loading flip
   * (false → true → false) triggered effect cleanup which stripped the ring and
   * cancelled the timer; the guard then blocked re-application forever.
   *
   * With the structural fix (animation state in refs, per-run cleanup only cancels
   * retry loop, primitive dep `communicationId`), a loading flip during the 2s
   * animation window must NOT kill the live ring.
   */
  it("ring survives a loading flip during the 2s animation window (proven root cause)", () => {
    const onHighlightConsumed = jest.fn();
    const msg = makeMessage("m-1", "thread-xyz");
    const baseProps = {
      messages: [msg],
      loading: false,
      error: null,
      highlightTarget: { type: "text" as const, communicationId: "m-1" },
      onHighlightConsumed,
    };

    const { rerender } = render(<TransactionMessagesTab {...baseProps} />);

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();
    expect(el!.classList).toContain("ring-2"); // ring applied on initial render

    // Simulate loading flip (the proven trigger from the debug trace)
    rerender(<TransactionMessagesTab {...baseProps} loading={true} />);
    expect(el!.classList).toContain("ring-2"); // ring must survive cleanup

    rerender(<TransactionMessagesTab {...baseProps} loading={false} />);
    expect(el!.classList).toContain("ring-2"); // still present after second flip

    // onHighlightConsumed must not fire until the 2s ring timer fires
    expect(onHighlightConsumed).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(el!.classList).not.toContain("ring-2"); // ring removed by its own timer
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });
});
