/**
 * RTL Tests — the Emails tab's relationship to needs-review.
 *
 * BACKLOG-2319 built a needs-review section INSIDE this tab that classified for
 * itself (`threadMatchReason(t) === "needs_review"`). BACKLOG-2791 DELETED it:
 * needs-review is now owned by ReviewQueueSection, mounted above this tab by
 * TransactionDetails and fed from getReviewState — one source of trust.
 *
 * The tests that pinned the old section are gone with it. What survives from
 * 2319, and is pinned here, is the part still true:
 *  - an address_missing thread must NOT appear in this tab's Linked list (it is
 *    in the review section instead, so leaving it here showed it TWICE),
 *  - address_found / manual / undefined DO appear in Linked, by identity,
 *  - this tab renders NO needs-review section of its own — the duplicate-render
 *    regression is structurally impossible,
 *  - the "Linked emails" divider is driven by the `hasReviewItems` PROP, not by
 *    the tab re-deriving review state,
 *  - the retired "Filter by property address" toggle is still gone.
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

describe("TransactionEmailsTab — needs-review is NOT rendered here (BACKLOG-2791)", () => {
  it("keeps an address_missing thread OUT of the Linked list, and renders no review section of its own", () => {
    renderTab();

    // The old in-tab section is GONE — not hidden, not empty: absent.
    expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-review-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-review-count")).not.toBeInTheDocument();
    expect(screen.queryByTestId("confirm-thread-button")).not.toBeInTheDocument();

    // The ambiguous conversation is not in Linked either — it belongs to the
    // shared review section above. Rendering it here as well was the duplicate.
    expect(screen.queryByText("Quick question")).not.toBeInTheDocument();

    // The unambiguous one IS linked, by identity.
    expect(screen.getByText("Inspection")).toBeInTheDocument();

    // Retired toggle stays retired.
    expect(screen.queryByTestId("address-filter-toggle")).not.toBeInTheDocument();
  });

  it("shows the Linked divider from the hasReviewItems PROP, never from self-classification", () => {
    // Same data that used to switch the divider on via the tab's own
    // classification. With the prop false it must stay off — that is the proof
    // the tab is no longer deriving review state.
    renderTab({ hasReviewItems: false });
    expect(screen.queryByTestId("linked-emails-divider")).not.toBeInTheDocument();
  });

  it("shows the divider when the shared section reports items above", () => {
    renderTab({ hasReviewItems: true });
    expect(screen.getByTestId("linked-emails-divider")).toBeInTheDocument();
  });

  it("a reclassified (user_confirmed) thread returns to the Linked list", () => {
    render(
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
    expect(screen.getByText("Quick question")).toBeInTheDocument();
    expect(screen.queryByTestId("needs-review-section")).not.toBeInTheDocument();
  });
});
