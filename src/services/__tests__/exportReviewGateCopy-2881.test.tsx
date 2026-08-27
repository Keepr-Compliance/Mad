/**
 * BACKLOG-2881 — the review-gate copy names NO action, on every route.
 *
 * THE RULING THIS PINS (founder, 2026-08-25). He pressed Export on a deal with
 * 9 communications in review and was told they had to be reviewed "before
 * completing the transaction" — while completing nothing. Export from the
 * brokerage-only header is a local-copy action. Offered three options he chose
 * the third: DROP THE ACTION FROM THE SENTENCE, because a sentence that never
 * names the action cannot name the wrong one, and one shared sentence is what
 * stops the details screen and the transactions list describing one queue two
 * different ways.
 *
 * WHY THE ABSENCE ASSERTION IS THE LOAD-BEARING ONE. A suite that only pins the
 * new sentence stays green if someone reintroduces the old one ALONGSIDE it —
 * a per-route string, a second builder, an extra clause. Asserting that the
 * stem "complet" appears in NOTHING these builders return is the assertion that
 * encodes the ruling rather than just its output.
 *
 * WHAT COUNT < 0 MEANS, AND MUST KEEP MEANING. It is the UNREADABLE queue, not
 * an empty one (`exportReviewGate.ts` rule 2). Neutralising its wording must
 * not neutralise its meaning, so the cases below assert it still says the queue
 * cannot be read and still points at Needs Review — collapsing unreadable into
 * empty would be a real defect wearing a copy fix's clothes.
 *
 * NOTHING HERE MOCKS `exportReviewGate`. The bulk case drives the REAL gate
 * through `window.api.transactions.getReviewState`; the details case renders
 * the REAL dialog. Mocking either would make the cross-route case vacuous.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { renderHook, act } from "@testing-library/react";

import {
  describeBlockedExport,
  reviewBlockedBody,
  reviewBlockedTitle,
  UNREADABLE_REVIEW_COUNT,
} from "../exportReviewGate";
import { ReviewPromptDialog } from "@/components/transactionDetailsModule/components/ReviewPromptDialog";
import { useBulkActions } from "@/components/transaction/hooks/useBulkActions";

/**
 * The sentences, as literals. Never `toContain(reviewBlockedBody(n))` for a
 * wording claim — that compares the builder with itself and would pass on any
 * wording at all, including the one the founder rejected.
 */
const HEADING = "Review needed";
const BODY_1 = "You have 1 communication that needs to be reviewed first.";
const BODY_2 = "You have 2 communications that need to be reviewed first.";
const BODY_9 = "You have 9 communications that need to be reviewed first.";
const HEADING_UNREADABLE = "Couldn't check Needs Review";
const BODY_UNREADABLE =
  "The review queue can't be read right now, so this can't go ahead. Open Needs Review to try again.";

describe("the exact strings the founder ruled on", () => {
  it("count = 1 — singular noun AND singular verb", () => {
    expect(reviewBlockedTitle(1)).toBe(HEADING);
    expect(reviewBlockedBody(1)).toBe(BODY_1);
  });

  it("count = 9 — the deal he actually hit", () => {
    expect(reviewBlockedTitle(9)).toBe(HEADING);
    expect(reviewBlockedBody(9)).toBe(BODY_9);
  });

  it("count < 0 — the unreadable queue keeps its own message", () => {
    expect(reviewBlockedTitle(UNREADABLE_REVIEW_COUNT)).toBe(HEADING_UNREADABLE);
    expect(reviewBlockedBody(UNREADABLE_REVIEW_COUNT)).toBe(BODY_UNREADABLE);
  });
});

describe("singular/plural swept at the boundary, not sampled", () => {
  // One sample per branch cannot catch an agreement bug: before BACKLOG-2881
  // only the NOUN was swapped, so count = 1 read "1 communication that need to
  // be reviewed" and every plural-count test in the repo stayed green.
  it("count = 1 says 'communication that needs'", () => {
    expect(reviewBlockedBody(1)).toBe(BODY_1);
    expect(reviewBlockedBody(1)).toContain("communication that needs");
    expect(reviewBlockedBody(1)).not.toContain("communications");
    expect(reviewBlockedBody(1)).not.toContain("that need to");
  });

  it("count = 2 says 'communications that need'", () => {
    expect(reviewBlockedBody(2)).toBe(BODY_2);
    expect(reviewBlockedBody(2)).toContain("communications that need");
    expect(reviewBlockedBody(2)).not.toContain("that needs");
  });
});

describe("THE RULING: no string these builders return names the action", () => {
  const COUNTS = [UNREADABLE_REVIEW_COUNT, 0, 1, 2, 9, 250];

  it.each(COUNTS)("heading and body at count %i name no action", (count) => {
    for (const value of [reviewBlockedTitle(count), reviewBlockedBody(count)]) {
      // The stem is the real net — it catches complete/completing/completed/
      // completion in one. The two literal words the ruling names are asserted
      // beneath it so the link back to the ruling is readable.
      expect(value).not.toMatch(/complet/i);
      expect(value.toLowerCase()).not.toContain("completing");
      expect(value.toLowerCase()).not.toContain("complete");
    }
  });

  it("the bulk refusal names no action either — lead sentence and deal list", () => {
    // Labels chosen so a hit can only come from the builders, never the
    // fixture. A mixed batch exercises both the readable lead and the
    // unreadable one plus the naming tail.
    const message = describeBlockedExport([
      { transactionId: "tx-a", label: "123 Main St", count: 7 },
      { transactionId: "tx-b", label: "45 Oak Ave", count: 2 },
      { transactionId: "tx-c", label: "9 Elm Rd", count: UNREADABLE_REVIEW_COUNT },
    ]);
    expect(message).not.toMatch(/complet/i);

    const allUnreadable = describeBlockedExport([
      { transactionId: "tx-c", label: "9 Elm Rd", count: UNREADABLE_REVIEW_COUNT },
    ]);
    expect(allUnreadable).not.toMatch(/complet/i);
  });
});

describe("count < 0 still means UNREADABLE, not empty", () => {
  it("says the queue cannot be read and points at Needs Review", () => {
    const body = reviewBlockedBody(UNREADABLE_REVIEW_COUNT);
    expect(body).toContain("review queue can't be read");
    expect(body).toContain("Needs Review");
  });

  it("is a different message from any countable queue, and claims no count", () => {
    const unreadable = reviewBlockedBody(UNREADABLE_REVIEW_COUNT);
    for (const count of [0, 1, 2, 9]) {
      expect(unreadable).not.toBe(reviewBlockedBody(count));
    }
    // Never "You have -1 communications", and never a bare "0" dressed as a
    // verified-empty queue.
    expect(unreadable).not.toMatch(/You have/);
    expect(unreadable).not.toMatch(/-?\d/);
  });
});

describe("all three routes say the SAME sentence for the same queue", () => {
  // The guarantee the founder's option preserved. Route 1 (Complete) and route
  // 2 (the brokerage-only header Export) both refuse through this dialog —
  // `TransactionDetails.exportReviewGate-2866.test.tsx` drives the real screen
  // and proves both buttons mount it, and now asserts this same literal for
  // its own counts. Route 4 (bulk) has no dialog, only the sentence.
  const EXPECTED = BODY_9;

  it("route 1/2/3 — the details refusal dialog", () => {
    render(
      <ReviewPromptDialog
        variant="blocked"
        count={9}
        onReview={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    const dialog = screen.getByTestId("review-prompt-blocked");
    expect(dialog).toHaveTextContent(EXPECTED);
    expect(dialog).toHaveTextContent(HEADING);
    expect(dialog.textContent ?? "").not.toMatch(/complet/i);
  });

  it("route 4 — the bulk-export refusal leads with the identical sentence", async () => {
    const getReviewState = window.api.transactions.getReviewState as jest.Mock;
    getReviewState.mockImplementation(async () => ({
      items: Array.from({ length: 9 }, (_, i) => ({ id: `p:${i}` })),
      count: 9,
    }));
    const showError = jest.fn();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a"]), 1, {
        onComplete: jest.fn().mockResolvedValue(undefined),
        showError,
        exitSelectionMode: jest.fn(),
        closeBulkDeleteModal: jest.fn(),
        closeBulkExportModal: jest.fn(),
        labelForTransaction: () => "123 Main St",
      }),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    const message = showError.mock.calls[0][0] as string;
    expect(message).toContain(EXPECTED);
    expect(message.startsWith(EXPECTED)).toBe(true);
    expect(message).not.toMatch(/complet/i);
  });
});
