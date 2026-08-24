/**
 * BACKLOG-2849 — the Submit for Review screen, as the founder redictated it.
 *
 * Four changes, and this suite is one control per change:
 *
 *   1. The Cancel button is gone; dismissal is an X at the top right.
 *   2. A brokerage user gets TWO actions: Submit and Export PDF.
 *   3. The pre-submit export SECTION is gone — the copy "Want to keep a local
 *      copy first?" and the "Export to folder before submitting" control.
 *   4. After a SUCCESSFUL submit the modal asks "Want to keep a local copy?"
 *      with an Export PDF action.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ABSENCE ASSERTIONS NAME THE FULL OLD LITERALS
 * ---------------------------------------------------------------------------
 * The retired copy "Want to keep a local copy first?" CONTAINS the new ask
 * "Want to keep a local copy?" only up to the word "first" — but a substring
 * matcher run the other way (`toContain("Want to keep a local copy")`) is
 * satisfied by both, and Testing Library's default string matcher normalises
 * whitespace and matches the full trimmed text, not a fragment. So the
 * absence assertions below quote the OLD strings in full and the presence
 * assertions quote the NEW one exactly. A rename that shortened the old copy
 * to the new one would otherwise pass on both halves.
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

/** The exact strings BACKLOG-2849 retires. Quoted in full, on purpose. */
const RETIRED_PRE_SUBMIT_COPY = "Want to keep a local copy first?";
const RETIRED_PRE_SUBMIT_ACTION = "Export to folder before submitting";

/** The exact string BACKLOG-2849 introduces, asked only after success. */
const POST_SUBMIT_ASK = "Want to keep a local copy?";

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
  render(
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
  return { onCancel, onSubmit, onExport };
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
    expect(screen.getByText(POST_SUBMIT_ASK)).toBeInTheDocument();

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
