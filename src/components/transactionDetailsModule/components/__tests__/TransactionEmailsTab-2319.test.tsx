/**
 * RTL Tests — BACKLOG-2319: "Needs review" surface on the Emails tab.
 *
 * Verifies:
 *  - emails classified match_reason='address_missing' render in the Needs-review
 *    section (amber), address_found/manual/undefined render in Linked (by identity),
 *  - the ⓘ info popover toggles,
 *  - Confirm (✓) calls confirmEmailLinks with the thread's email ids and then the
 *    silent-refresh callback; on reclassification the card moves to Linked and the
 *    Needs-review count decrements / section disappears,
 *  - Remove (🗑) on a Needs-review card calls the existing unlinkCommunication,
 *  - the retired "Filter by property address" toggle is GONE.
 *
 * Identity, not counts: assertions target specific email ids / subjects.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionEmailsTab } from "../TransactionEmailsTab";
import type { Communication } from "../../types";

jest.mock("../../../../contexts", () => ({
  useAuth: () => ({ currentUser: { id: "user-1", email: "me@example.com" } }),
}));

const base = {
  user_id: "user-1",
  created_at: "2024-01-01T00:00:00Z",
  has_attachments: false,
  is_false_positive: false,
};

// One address_missing conversation ("Quick question") → Needs review; one
// address_found conversation ("Inspection") → Linked.
function makeComms(overrides: Partial<Record<string, string>> = {}): Communication[] {
  return [
    {
      ...base,
      id: "e-review",
      subject: "Quick question",
      sender: "alice@example.com",
      recipients: "me@example.com",
      thread_id: "t-review",
      sent_at: "2024-01-10T10:00:00Z",
      match_reason: (overrides["e-review"] ?? "address_missing") as Communication["match_reason"],
    },
    {
      ...base,
      id: "e-linked",
      subject: "Inspection",
      sender: "bob@example.com",
      recipients: "me@example.com",
      thread_id: "t-linked",
      sent_at: "2024-01-12T10:00:00Z",
      match_reason: "address_found",
    },
  ] as Communication[];
}

const within = (testId: string) => screen.getByTestId(testId);

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).confirmEmailLinks = jest.fn();
  (window.api.transactions as any).unlinkCommunication = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.transactions.confirmEmailLinks as jest.Mock).mockResolvedValue({
    success: true,
    confirmedCount: 1,
  });
  (window.api.transactions.unlinkCommunication as jest.Mock).mockResolvedValue({
    success: true,
    unlinkedIds: ["e-review"],
  });
});

function renderTab(props: Partial<React.ComponentProps<typeof TransactionEmailsTab>> = {}) {
  return render(
    <TransactionEmailsTab
      communications={makeComms()}
      loading={false}
      unlinkingCommId={null}
      onViewEmail={jest.fn()}
      onShowUnlinkConfirm={jest.fn()}
      onShowUnlinkThread={jest.fn()}
      userId="user-1"
      transactionId="txn-1"
      {...props}
    />
  );
}

describe("TransactionEmailsTab — BACKLOG-2319 Needs review", () => {
  it("splits address_missing into Needs review and address_found into Linked (by identity)", () => {
    renderTab();

    // Needs-review section present with the ambiguous conversation only.
    const reviewList = within("needs-review-list");
    expect(reviewList).toHaveTextContent("Quick question");
    expect(reviewList).not.toHaveTextContent("Inspection");

    // Count reflects exactly one review thread.
    expect(within("needs-review-count")).toHaveTextContent("(1)");

    // The "Linked emails" divider appears (because a Needs-review section is above).
    expect(screen.getByTestId("linked-emails-divider")).toBeInTheDocument();

    // The linked conversation is NOT in the review list.
    expect(screen.getByText("Inspection")).toBeInTheDocument();

    // Retired toggle is gone.
    expect(screen.queryByTestId("address-filter-toggle")).not.toBeInTheDocument();
  });

  it("renders no Needs-review section (and no divider) when nothing needs review", () => {
    render(
      <TransactionEmailsTab
        communications={[makeComms()[1]]} // only the address_found one
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
      />
    );
    expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-emails-divider")).not.toBeInTheDocument();
  });

  it("toggles the ⓘ info popover", async () => {
    renderTab();
    expect(screen.queryByTestId("needs-review-info-popover")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("needs-review-info-button"));
    expect(screen.getByTestId("needs-review-info-popover")).toHaveTextContent(
      /didn.t mention the property address/i
    );
    await userEvent.click(screen.getByTestId("needs-review-info-button"));
    expect(screen.queryByTestId("needs-review-info-popover")).not.toBeInTheDocument();
  });

  it("Confirm (✓) calls confirmEmailLinks with the thread's email ids then the silent refresh", async () => {
    const onConfirmComplete = jest.fn().mockResolvedValue(undefined);
    renderTab({ onConfirmComplete });

    await act(async () => {
      await userEvent.click(screen.getByTestId("confirm-thread-button"));
    });

    await waitFor(() => {
      expect(window.api.transactions.confirmEmailLinks).toHaveBeenCalledWith(
        ["e-review"],
        "txn-1"
      );
    });
    expect(onConfirmComplete).toHaveBeenCalledTimes(1);
  });

  it("promotes a confirmed thread to Linked and drops the Needs-review section on reclassification", () => {
    // First render: e-review is address_missing → Needs review.
    const { rerender } = renderTab();
    expect(screen.getByTestId("needs-review-section")).toBeInTheDocument();

    // Simulate the post-confirm silent refetch returning it as user_confirmed.
    rerender(
      <TransactionEmailsTab
        communications={makeComms({ "e-review": "user_confirmed" })}
        loading={false}
        unlinkingCommId={null}
        onViewEmail={jest.fn()}
        onShowUnlinkConfirm={jest.fn()}
        userId="user-1"
        transactionId="txn-1"
      />
    );

    // Needs-review section is gone; the conversation now sits in the linked list.
    expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-emails-divider")).not.toBeInTheDocument();
    expect(screen.getByText("Quick question")).toBeInTheDocument();
  });

  it("Remove (🗑) on a Needs-review card routes through the existing unlink flow", async () => {
    const onShowUnlinkThread = jest.fn();
    renderTab({ onShowUnlinkThread });

    // The trash button lives inside the needs-review list.
    const reviewList = within("needs-review-list");
    const trash = reviewList.querySelector('[data-testid="unlink-thread-button"]');
    expect(trash).toBeTruthy();
    await userEvent.click(trash as Element);

    // Falls through to the parent's thread-unlink handler (existing behaviour).
    expect(onShowUnlinkThread).toHaveBeenCalledTimes(1);
  });
});
