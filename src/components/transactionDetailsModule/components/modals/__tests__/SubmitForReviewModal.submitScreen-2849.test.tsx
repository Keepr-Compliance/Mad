/**
 * BACKLOG-2849 — the Submit for Review screen, as the founder redictated it.
 *
 * Four changes, and this suite is one control per change:
 *
 *   1. The Cancel button is gone; dismissal is an X at the top right.
 *   2. A brokerage user gets TWO actions: Submit and Export PDF.
 *   3. The pre-submit export SECTION is gone — the copy "Want to keep a local
 *      copy first?" and the "Export to folder before submitting" control.
 *   4. After a SUCCESSFUL submit the modal points the user at the Export PDF
 *      action, and does so with ONE plain sentence.
 *
 * Point 4 shipped first as a blue callout carrying its own green check-circle
 * and its own "Submitted to your broker." headline. The founder tested it on
 * 2026-08-24: "we don't need the same text and check mark twice, keep the top
 * one, remove this", pasting that callout. So the success screen now confirms
 * ONCE — above this block — and this block is one sentence pointing down at
 * the button. §4b below is the control for that correction.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ABSENCE ASSERTIONS NAME THE FULL OLD LITERALS
 * ---------------------------------------------------------------------------
 * Three strings share the prefix "Want to keep a local copy": the retired
 * pre-submit callout ("...first?"), the retired post-submit ask ("...copy?")
 * and the sentence that shipped in its place ("...copy, click the export pdf
 * button below"). A substring matcher (`toContain("Want to keep a local
 * copy")`) is satisfied by all three, so it can tell none of them apart.
 *
 * Testing Library's default string matcher normalises whitespace and matches
 * the full trimmed text, not a fragment — so every assertion below quotes its
 * string IN FULL, absences and presences alike. A rewording that left the old
 * copy in place under a shorter name would otherwise pass.
 *
 * ---------------------------------------------------------------------------
 * WHO REACHES THIS MODAL
 * ---------------------------------------------------------------------------
 * Only a brokerage user. `useCompleteTransaction.resolveTarget()` returns
 * "submit" only for `canSubmit && !!organizationId` and fails CLOSED to
 * export otherwise, and `openSubmitFlow` is the single caller of
 * `setShowSubmitModal(true)` (the header's `onShowSubmitModal` prop has been
 * deprecated with zero production call sites since BACKLOG-2792). So rendering
 * this component at all IS the brokerage case; there is no licence prop to
 * vary, and a test that varied one would be testing a state the app cannot
 * produce.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SubmitForReviewModal } from "../SubmitForReviewModal";
import type { Transaction } from "@/types";
import type { SubmitProgress } from "../SubmitForReviewModal";

const transaction = {
  id: "txn-2849",
  user_id: "user-2849",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
} as unknown as Transaction;

/**
 * The same deal, in the state that makes the modal take its RESUBMIT branch.
 * `submission_status: "needs_changes"` is the only input the component reads
 * for it (`const isResubmit = transaction.submission_status === ...`), so this
 * is the real producer's shape, not a stand-in.
 */
const resubmitTransaction = {
  ...transaction,
  submission_status: "needs_changes",
} as unknown as Transaction;

/** The exact strings BACKLOG-2849 retires. Quoted in full, on purpose. */
const RETIRED_PRE_SUBMIT_COPY = "Want to keep a local copy first?";
const RETIRED_PRE_SUBMIT_ACTION = "Export to folder before submitting";

/**
 * The exact sentence shown only after success, in the founder's own wording
 * from 2026-08-24 — lowercase "export pdf", comma splice, no full stop. It is
 * quoted here verbatim on purpose: copyediting his words is his call, not one
 * to take on his behalf, and this constant is what pins it.
 */
const POST_SUBMIT_ASK =
  "Want to keep a local copy, click the export pdf button below";

/** The ask as it read BEFORE the 2026-08-24 correction. Retired. */
const RETIRED_POST_SUBMIT_ASK = "Want to keep a local copy?";

/**
 * The success headlines the correction retires. The modal no longer confirms
 * the submission itself — that is the job of what renders ABOVE this block —
 * so BOTH variants must be absent, the resubmit one included. Nothing else in
 * the suite (or the repo) asserted either string.
 */
const RETIRED_SUCCESS_HEADLINE = "Submitted to your broker.";
const RETIRED_RESUBMIT_HEADLINE = "Resubmitted to your broker.";

/**
 * The check-circle glyph. The header draws it in a blue disc beside "Submit
 * for Review"; the retired success callout drew the SAME path in green right
 * underneath. Counting the path is how "check mark twice" is asserted as a
 * number rather than as a vibe.
 */
const CHECK_CIRCLE_D = "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z";

const SUCCESS: SubmitProgress = {
  stage: "complete",
  stageProgress: 100,
  overallProgress: 100,
  currentItem: "Submission complete!",
};

const FAILED: SubmitProgress = {
  stage: "failed",
  stageProgress: 0,
  overallProgress: 0,
  currentItem: "Submission failed",
};

const UPLOADING: SubmitProgress = {
  stage: "attachments",
  stageProgress: 40,
  overallProgress: 30,
  currentItem: "contract.pdf",
};

function renderModal(
  overrides: Partial<React.ComponentProps<typeof SubmitForReviewModal>> = {},
) {
  const onCancel = jest.fn();
  const onSubmit = jest.fn();
  const onExport = jest.fn();
  const { container } = render(
    <SubmitForReviewModal
      transaction={transaction}
      emailCount={99}
      textThreadCount={4}
      attachmentCount={12}
      emailAttachmentCount={9}
      totalSizeBytes={1024}
      isSubmitting={false}
      progress={null}
      error={null}
      onCancel={onCancel}
      onSubmit={onSubmit}
      onExport={onExport}
      {...overrides}
    />,
  );
  return { onCancel, onSubmit, onExport, container };
}

describe("BACKLOG-2849 §1 — dismissal is an X, not a Cancel button", () => {
  it("offers no Cancel button anywhere on the idle screen", () => {
    renderModal();

    // Exact-text role query. "Cancel Anyway" (the mid-upload confirm, which
    // stays) does not satisfy it, so this names the button that was removed
    // and not the one that survived.
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
  });

  it("dismisses via the X WITHOUT submitting", () => {
    const { onCancel, onSubmit } = renderModal();

    fireEvent.click(screen.getByTestId("submit-review-close"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    // The half that matters: an X that also fired the submit would look
    // identical in a screenshot and would send the deal to the broker.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("the BACKDROP lands in the same state as the X, mid-upload", () => {
    // BACKLOG-2849 follow-up. The backdrop used to be wired straight to
    // `onCancel` while the X went through `handleCancelClick`, so the two ways
    // out of this modal disagreed about whether a running upload gets a
    // warning. Under the founder's rule — a deal that did not submit must not
    // look submitted — an inconsistent dismiss is a correctness question.
    //
    // Clicking the overlay element itself is what ResponsiveModal treats as a
    // backdrop click (`e.target === e.currentTarget`); clicking the panel does
    // not close.
    const { onCancel } = renderModal({ isSubmitting: true, progress: UPLOADING });

    fireEvent.click(screen.getByTestId("submit-review-modal"));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Submission in progress")).toBeInTheDocument();
  });

  it("the X raises the confirm mid-upload instead of aborting silently", () => {
    // The Cancel button used to be the only thing routed through
    // `handleCancelClick`. Wiring the X straight to `onCancel` would drop a
    // running submission with no warning — the exact regression this asserts
    // against, by requiring the confirm to appear and `onCancel` NOT to fire.
    const { onCancel } = renderModal({
      isSubmitting: true,
      progress: UPLOADING,
    });

    fireEvent.click(screen.getByTestId("submit-review-close"));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Submission in progress")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel Anyway" }),
    ).toBeInTheDocument();
  });
});

describe("BACKLOG-2849 §2 — a brokerage user gets Submit and Export PDF", () => {
  it("shows both actions on the idle screen", () => {
    renderModal();

    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Export PDF" }),
    ).toBeInTheDocument();
  });

  it("Export PDF calls the export handler and does not submit", () => {
    const { onExport, onSubmit } = renderModal();

    fireEvent.click(screen.getByTestId("submit-review-export"));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("hides Export PDF while an upload is actually running", () => {
    // Leaving for the export modal mid-upload would abort the submission.
    renderModal({ isSubmitting: true, progress: UPLOADING });

    expect(screen.queryByTestId("submit-review-export")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2849 §3 — the pre-submit export section is gone", () => {
  it("shows neither the retired copy nor the retired control", () => {
    renderModal();

    expect(screen.queryByText(RETIRED_PRE_SUBMIT_COPY)).not.toBeInTheDocument();
    expect(
      screen.queryByText(RETIRED_PRE_SUBMIT_ACTION),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RETIRED_PRE_SUBMIT_ACTION }),
    ).not.toBeInTheDocument();
  });

  it("does not ask the question before the submit decision", () => {
    // The NEW ask, asserted absent on the idle screen. Point 4 moved it after
    // the submit; a component that merely reworded the old callout in place
    // would pass §3's first case and fail this one.
    renderModal();

    expect(screen.queryByText(POST_SUBMIT_ASK)).not.toBeInTheDocument();
    // ...and the summary the user is deciding on IS still there, so this is
    // not passing because nothing rendered.
    expect(screen.getByText("Submission Summary")).toBeInTheDocument();
  });
});

describe("BACKLOG-2849 §4 — the ask appears only after a SUCCESSFUL submit", () => {
  it("asks, and offers Export PDF, on success", () => {
    // The realistic post-success prop shape: `isSubmitting` is back to false
    // (the hook resets it in `finally`) while progress holds "complete".
    const { onExport } = renderModal({ isSubmitting: false, progress: SUCCESS });

    expect(screen.getByTestId("submit-review-success-ask")).toBeInTheDocument();
    // Exact count, not presence: presence is also satisfied by two copies,
    // which is the defect §4b exists to keep out.
    expect(screen.getAllByText(POST_SUBMIT_ASK)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("replaces the summary rather than stacking under it", () => {
    // `isSubmitting` false + `error` null is ALSO the idle state, which is how
    // the summary block was gated before this ticket. Without the explicit
    // success flag the ask renders beneath a re-shown "Submission Summary".
    renderModal({ isSubmitting: false, progress: SUCCESS });

    expect(screen.queryByText("Submission Summary")).not.toBeInTheDocument();
  });

  it("does not ask when the submit FAILED", () => {
    renderModal({
      isSubmitting: false,
      progress: FAILED,
      error: "Network unreachable",
    });

    expect(
      screen.queryByTestId("submit-review-success-ask"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(POST_SUBMIT_ASK)).not.toBeInTheDocument();
    // Present, so the failure state really did render.
    expect(screen.getByText("Submission Failed")).toBeInTheDocument();
  });

  it("does not ask when a stale 'complete' sits behind an error", () => {
    // Boundary between the two halves of `isSuccess`. Stage alone would offer
    // a keep-a-copy prompt for a submission that did not happen.
    renderModal({
      isSubmitting: false,
      progress: SUCCESS,
      error: "Upload rejected by broker",
    });

    expect(
      screen.queryByTestId("submit-review-success-ask"),
    ).not.toBeInTheDocument();
  });

  it("does not ask mid-upload", () => {
    renderModal({ isSubmitting: true, progress: UPLOADING });

    expect(
      screen.queryByTestId("submit-review-success-ask"),
    ).not.toBeInTheDocument();
  });

  it("offers no Submit button once the submit has succeeded", () => {
    // A second Submit on an already-submitted deal is a duplicate submission.
    renderModal({ isSubmitting: false, progress: SUCCESS });

    expect(
      screen.queryByRole("button", { name: "Submit" }),
    ).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2849 §4b — the success screen confirms ONCE", () => {
  /**
   * The founder's correction of 2026-08-24, after testing the screen §4 built:
   * "we don't need the same text and check mark twice, keep the top one,
   * remove this" — "this" being the blue callout that carried a second
   * check-circle and a second confirmation line directly under the header's.
   *
   * WHY THESE ARE COUNTS AND NOT PRESENCE CHECKS
   * A presence check (`toBeInTheDocument`) passes with two copies on screen.
   * Two copies IS the bug. So the check-circle glyph and the sentence are both
   * asserted as exact numbers, and the survivor is pinned by identity — which
   * one is left, not merely how many.
   *
   * WHAT IS *NOT* ASSERTED HERE, AND WHY
   * The obvious phrasing — "'Submitted to your broker.' appears exactly ONCE"
   * — cannot go red. That string was in this modal exactly once BEFORE the
   * correction too (the second confirmation the founder saw was the header's
   * check-circle and the success toast, not a second copy of the sentence), so
   * a `toHaveLength(1)` on it passes on the unfixed component and survives the
   * revert control. The count that does discriminate is the glyph count: 2
   * before, 1 after. The string is asserted at zero instead — the modal has
   * stopped confirming the submission at all, which is the actual change.
   */

  it("draws the check-circle ONCE, and the survivor is the header's", () => {
    const { container } = renderModal({
      isSubmitting: false,
      progress: SUCCESS,
    });

    const checks = container.querySelectorAll(`path[d="${CHECK_CIRCLE_D}"]`);
    expect(checks).toHaveLength(1);

    // Identity, not just arithmetic: the one left is the header's blue disc
    // icon, so this cannot pass by having removed the wrong checkmark.
    const survivingIcon = checks[0].closest("svg");
    expect(survivingIcon).toHaveClass("text-blue-600");
    expect(survivingIcon?.closest("div")?.parentElement).toHaveTextContent(
      "Submit for Review",
    );

    // The green one is gone outright — no icon of that colour anywhere.
    expect(container.querySelectorAll(".text-green-600")).toHaveLength(0);
  });

  it("no longer confirms the submission in its own words", () => {
    renderModal({ isSubmitting: false, progress: SUCCESS });

    // queryAll, not getAll: getAllByText THROWS on zero matches, and zero is
    // the expected number.
    expect(screen.queryAllByText(RETIRED_SUCCESS_HEADLINE)).toHaveLength(0);
    // Present, so this is not passing because the success screen never
    // rendered.
    expect(screen.getByTestId("submit-review-success-ask")).toBeInTheDocument();
  });

  it("no longer confirms it on the RESUBMIT branch either", () => {
    renderModal({
      transaction: resubmitTransaction,
      isSubmitting: false,
      progress: SUCCESS,
    });

    expect(screen.queryAllByText(RETIRED_RESUBMIT_HEADLINE)).toHaveLength(0);
    expect(screen.queryAllByText(RETIRED_SUCCESS_HEADLINE)).toHaveLength(0);
    // The resubmit branch really is the one that rendered.
    expect(screen.getByText("Resubmit for Review")).toBeInTheDocument();
  });

  it("says the founder's sentence once, and says nothing else", () => {
    renderModal({ isSubmitting: false, progress: SUCCESS });

    expect(screen.getAllByText(POST_SUBMIT_ASK)).toHaveLength(1);

    // The block IS the sentence — no headline above it, no wrapper copy. An
    // exact textContent match fails if any of the removed lines came back
    // inside it.
    expect(screen.getByTestId("submit-review-success-ask")).toHaveTextContent(
      new RegExp(`^${POST_SUBMIT_ASK}$`),
    );

    // The shorter wording it replaced is gone, not merely reworded around.
    expect(screen.queryAllByText(RETIRED_POST_SUBMIT_ASK)).toHaveLength(0);
  });

  it("puts the Export PDF button BELOW the sentence, as the sentence claims", () => {
    renderModal({ isSubmitting: false, progress: SUCCESS });

    const sentence = screen.getByTestId("submit-review-success-ask");
    const exportButton = screen.getByRole("button", { name: "Export PDF" });

    // The copy tells the user to click "the export pdf button below". DOM
    // order is what makes that sentence true.
    expect(
      sentence.compareDocumentPosition(exportButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
