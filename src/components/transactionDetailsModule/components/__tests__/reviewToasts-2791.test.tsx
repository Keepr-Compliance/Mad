/**
 * BACKLOG-2791 — review actions toast, in the app's existing style.
 *
 * Reject, restore and approve happened silently while every other action on
 * this screen announces itself ("2 emails restored"). These reuse the same
 * showSuccess/showError helpers and the same "N noun verbed" phrasing rather
 * than a second convention, and the reject copy says "removed" — the same word
 * the Removed section uses, because that is exactly where the item goes.
 *
 * THE NUMBER IN THE TOAST COUNTS EMAILS, NOT THREADS (Communication Lifecycle
 * Contract, rows T3/T4: "acts on: whole thread", toast "N emails linked").
 * Badges and subtitles count threads; the toast reports what actually moved. A
 * two-email thread is ONE card and ONE click that says "2 emails removed", and
 * the last test here is the one that can tell those two units apart.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewQueueSection } from "../ReviewQueueSection";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "u", email: "me@example.com" } }),
}));

const emailItem: ReviewItemDto = {
  id: "pending:e1", rowId: "e1", origin: "pending", kind: "email",
  transaction_id: "tx-1", email_id: "e1", thread_id: null,
  found_at: "2026-08-01T00:00:00.000Z",
  display: {
    title: "Quick question", subtitle: "jane@example.com", snippet: "hi",
    occurredAt: "2026-06-01T00:00:00.000Z", itemCount: 1,
    threadId: "thr-q",
    recipients: null, cc: null, sender: "jane@example.com",
    body: null, bodyText: null, hasAttachments: false, threadParticipants: [], threadMessages: [],
  },
};

/** Mirrors TransactionDetails' wrappers: act, then toast. */
function makeHandlers(showSuccess: jest.Mock, showError: jest.Mock, fail = false) {
  const noun = (ids: string[]) => (ids.length === 1 ? "email" : "emails");
  return {
    onApprove: async (ids: string[]) => {
      if (fail) { showError(`Could not link ${noun(ids)}`); return; }
      showSuccess(`${ids.length} ${noun(ids)} linked to this transaction`);
    },
    onReject: async (ids: string[]) => {
      if (fail) { showError(`Could not remove ${noun(ids)}`); return; }
      showSuccess(`${ids.length} ${noun(ids)} removed`);
    },
  };
}

/** Two emails the provider threaded together — ONE card. */
const threadedA: ReviewItemDto = {
  ...emailItem,
  id: "pending:e2", rowId: "e2", email_id: "e2",
  display: { ...emailItem.display, threadId: "thr-pair", title: "Re: Offer" },
};
const threadedB: ReviewItemDto = {
  ...emailItem,
  id: "pending:e3", rowId: "e3", email_id: "e3",
  display: { ...emailItem.display, threadId: "thr-pair", title: "Re: Offer" },
};

describe("review actions announce themselves", () => {
  it("trash toasts 'removed' — the word Show removed uses", async () => {
    const showSuccess = jest.fn();
    const h = makeHandlers(showSuccess, jest.fn());
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={h.onApprove} onReject={h.onReject} />,
    );
    fireEvent.click(screen.getByTestId("unlink-thread-button"));
    await waitFor(() => expect(showSuccess).toHaveBeenCalledWith("1 email removed"));
  });

  it("approve toasts that it linked", async () => {
    const showSuccess = jest.fn();
    const h = makeHandlers(showSuccess, jest.fn());
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={h.onApprove} onReject={h.onReject} />,
    );
    fireEvent.click(screen.getByTestId("confirm-thread-button"));
    await waitFor(() =>
      expect(showSuccess).toHaveBeenCalledWith("1 email linked to this transaction"),
    );
  });

  it("pluralises like the rest of the app", async () => {
    const showSuccess = jest.fn();
    const h = makeHandlers(showSuccess, jest.fn());
    await h.onReject(["pending:e1", "pending:e2"]);
    expect(showSuccess).toHaveBeenCalledWith("2 emails removed");
  });

  it("a FAILED action toasts an error rather than a false success", async () => {
    const showSuccess = jest.fn();
    const showError = jest.fn();
    const h = makeHandlers(showSuccess, showError, true);
    await h.onReject(["pending:e1"]);
    expect(showError).toHaveBeenCalledWith("Could not remove email");
    expect(showSuccess).not.toHaveBeenCalled();
  });
});

describe("the wiring TransactionDetails actually passes", () => {
  it("trash routes to onReject and NEVER to onApprove", async () => {
    // The founder's rule: trash = removed. A trash wired to approve would link
    // the very email the user tried to get rid of.
    const onApprove = jest.fn().mockResolvedValue(undefined);
    const onReject = jest.fn().mockResolvedValue(undefined);
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={onApprove} onReject={onReject} />,
    );
    fireEvent.click(screen.getByTestId("unlink-thread-button"));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith(["pending:e1"]));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("confirm routes to onApprove and NEVER to onReject", async () => {
    const onApprove = jest.fn().mockResolvedValue(undefined);
    const onReject = jest.fn().mockResolvedValue(undefined);
    render(
      <ReviewQueueSection items={[emailItem]} kind="email" onApprove={onApprove} onReject={onReject} />,
    );
    fireEvent.click(screen.getByTestId("confirm-thread-button"));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(["pending:e1"]));
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe("the toast counts EMAILS while the card counts as ONE thread", () => {
  it("one trash on a two-email thread toasts '2 emails removed'", async () => {
    const showSuccess = jest.fn();
    const h = makeHandlers(showSuccess, jest.fn());
    render(
      <ReviewQueueSection
        items={[threadedA, threadedB]}
        kind="email"
        onApprove={h.onApprove}
        onReject={h.onReject}
      />,
    );

    // ONE card for the two emails, and the section counts it as one thread.
    expect(screen.queryAllByTestId("email-thread-card")).toHaveLength(1);
    expect(screen.getByTestId("needs-review-count")).toHaveTextContent("(1)");

    fireEvent.click(screen.getByTestId("unlink-thread-button"));
    // The toast reports EMAILS — what actually moved — not the thread count.
    await waitFor(() => expect(showSuccess).toHaveBeenCalledWith("2 emails removed"));
  });

  it("one confirm on a two-email thread passes BOTH ids and toasts '2 emails linked'", async () => {
    const showSuccess = jest.fn();
    const onApprove = jest.fn().mockResolvedValue(undefined);
    render(
      <ReviewQueueSection
        items={[threadedA, threadedB]}
        kind="email"
        onApprove={onApprove}
        onReject={makeHandlers(showSuccess, jest.fn()).onReject}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-thread-button"));
    // ID SET, not a count — the acts-on unit is the whole thread.
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect([...onApprove.mock.calls[0][0]].sort()).toEqual(["pending:e2", "pending:e3"]);
  });
});
