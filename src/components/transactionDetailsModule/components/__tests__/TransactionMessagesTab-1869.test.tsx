/**
 * Tests — BACKLOG-1869: TransactionMessagesTab scroll+highlight on search navigation
 *
 * Verifies that when a highlight target (from the linked-content search) arrives:
 *   - the matching conversation card is scrolled into view,
 *   - the ring highlight class is applied and removed after 2s,
 *   - onHighlightConsumed is called to clear the target,
 *   - an unknown communicationId results in a graceful no-op,
 *   - the effect waits when loading=true.
 */
import React from "react";
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

function renderTab(
  messages: Communication[],
  highlightTarget: HighlightTarget | null,
  onHighlightConsumed: jest.Mock,
) {
  return render(
    <TransactionMessagesTab
      messages={messages}
      loading={false}
      error={null}
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

describe("TransactionMessagesTab — BACKLOG-1869 highlight on search navigation", () => {
  it("scrolls to the matching thread card and calls onHighlightConsumed", () => {
    const onHighlightConsumed = jest.fn();
    const msg = makeMessage("m-1", "thread-xyz");

    renderTab([msg], { type: "text", communicationId: "m-1" }, onHighlightConsumed);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(onHighlightConsumed).toHaveBeenCalledTimes(1);
  });

  it("applies the ring class on the matching card", () => {
    const msg = makeMessage("m-1", "thread-xyz");
    renderTab([msg], { type: "text", communicationId: "m-1" }, jest.fn());

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();
    expect(el!.classList).toContain("ring-2");
  });

  it("removes the ring class after 2s", () => {
    const msg = makeMessage("m-1", "thread-xyz");
    renderTab([msg], { type: "text", communicationId: "m-1" }, jest.fn());

    const el = document.querySelector<HTMLElement>("[data-thread-id]");
    expect(el).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(el!.classList).not.toContain("ring-2");
  });

  it("no-ops gracefully when the communicationId is not found in any thread", () => {
    const onHighlightConsumed = jest.fn();
    const msg = makeMessage("m-1", "thread-xyz");

    renderTab([msg], { type: "text", communicationId: "unknown-comm" }, onHighlightConsumed);

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    // Target still consumed — no re-flash on re-renders.
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
});
