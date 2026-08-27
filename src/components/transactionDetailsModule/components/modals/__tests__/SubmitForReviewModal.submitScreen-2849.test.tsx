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
 *   5. The screen that survives says it SUCCEEDED. Founder test, same day,
 *      after §4b shipped: the confirmation had moved entirely into a toast
 *      that auto-dismisses after 5000ms, and once it cleared, a dialog still
 *      titled "Submit for Review" was all that was left — nothing on screen
 *      saying the submission worked. His three changes, verbatim: "change the
 *      check mark graphic to be green color theme like the submitted indicator
 *      looks like", "the title should say successfully submitted not submit
 *      for review", "can we add a done button next to the export pdf". §5 is
 *      the control for all three; §4b's glyph pin is rewritten to match.
 *
 * ---------------------------------------------------------------------------
 * WHY §4b's GLYPH PIN CHANGED RATHER THAN RELAXED
 * ---------------------------------------------------------------------------
 * §4b pinned the single surviving check glyph BY IDENTITY to the header's blue
 * icon. Point 5 turns that icon green on success, so the pin had to break —
 * it had encoded the old design. It is rewritten, not weakened: the count is
 * now taken over the UNION of both check paths (the idle circle-check and the
 * badge's bare check), so a returning duplicate is caught whichever glyph it
 * draws, and the survivor is still pinned by identity — green on success, blue
 * on idle. A presence check would have removed the guard that caught the
 * original duplication, and let the doubling back in.
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
 * The two check glyphs this modal can draw in its header.
 *
 * `CHECK_CIRCLE_D` is the idle header's circle-check, in a blue disc beside
 * "Submit for Review". The retired success callout drew the SAME path in green
 * directly underneath it — counting the path is how "check mark twice" is
 * asserted as a number rather than as a vibe.
 *
 * `BADGE_CHECK_D` is the bare check from the Submitted badge in
 * TransactionHeader.tsx, which point 5 adopts for the SUCCESS header so the
 * modal and the badge on the deal behind it read as one signal. It is
 * transcribed from that component, not invented here.
 */
const CHECK_CIRCLE_D = "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z";
const BADGE_CHECK_D = "M5 13l4 4L19 7";

/**
 * Every check glyph, whichever shape. The count assertions run over this union
 * on purpose: pinning only the shape that is EXPECTED in a given state would
 * let a duplicate drawn in the OTHER shape pass unseen, which is precisely the
 * hole a shape-specific count opened when the success header changed glyphs.
 *
 * Scope note: `BADGE_CHECK_D` also appears in the progress block's
 * stage-complete tick, which renders only while `isSubmitting` is true. Every
 * count below is taken on an `isSubmitting: false` state, so that tick is out
 * of frame — do not reuse this selector's exact-count form on a mid-upload
 * render.
 */
const ANY_CHECK_GLYPH = `path[d="${CHECK_CIRCLE_D}"], path[d="${BADGE_CHECK_D}"]`;

/**
 * The three header titles, quoted in full. `SUCCESS_TITLE` is the founder's
 * wording from 2026-08-24 ("the title should say successfully submitted"), in
 * sentence-style title case to match the two it sits beside.
 */
const IDLE_TITLE = "Submit for Review";
const RESUBMIT_TITLE = "Resubmit for Review";
const SUCCESS_TITLE = "Successfully Submitted";

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

  it("draws ONE check glyph on success, and the survivor is the header's", () => {
    const { container } = renderModal({
      isSubmitting: false,
      progress: SUCCESS,
    });

    // Counted over BOTH glyph shapes. The earlier version of this assertion
    // counted only the circle-check, which the point-5 header no longer draws
    // on success — a shape-specific count would now read 0 and pass while a
    // second badge-check sat on screen.
    const checks = container.querySelectorAll(ANY_CHECK_GLYPH);
    expect(checks).toHaveLength(1);

    // Identity, not just arithmetic: the one left is the HEADER's icon, so
    // this cannot pass by having removed the wrong checkmark. It was pinned to
    // the blue disc; point 5 makes the success disc green, so the pin moves to
    // the green treatment rather than dropping to a presence check.
    expect(checks[0]).toHaveAttribute("d", BADGE_CHECK_D);
    const disc = checks[0].closest("svg")?.parentElement;
    expect(disc).toHaveClass("bg-green-100");
    expect(disc).toHaveClass("text-green-700");
    expect(disc?.parentElement).toHaveTextContent(SUCCESS_TITLE);

    // The RETIRED callout's green is still gone. `text-green-600` is a
    // DIFFERENT token from the badge's `text-green-700` asserted above — which
    // is what keeps this a live guard against that callout returning, rather
    // than a claim that nothing on the screen is green.
    expect(container.querySelectorAll(".text-green-600")).toHaveLength(0);
  });

  it("still draws ONE check glyph on the IDLE screen, and it is the blue one", () => {
    // The other half of the pin. Without it, "green on success" is satisfied
    // by a component that turned the icon green EVERYWHERE — including the
    // screen that is still asking the question.
    const { container } = renderModal();

    const checks = container.querySelectorAll(ANY_CHECK_GLYPH);
    expect(checks).toHaveLength(1);

    expect(checks[0]).toHaveAttribute("d", CHECK_CIRCLE_D);
    const icon = checks[0].closest("svg");
    expect(icon).toHaveClass("text-blue-600");
    expect(icon?.parentElement).toHaveClass("bg-blue-100");
    expect(container.querySelectorAll(".bg-green-100")).toHaveLength(0);
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
    // Liveness, rewritten for point 5. This used to read
    // `getByText("Resubmit for Review")` — the resubmit branch's own title —
    // which is no longer true HERE: the success header renders one literal for
    // both branches. So the proof that the success screen rendered moves to
    // the ask and the unified title, and the proof that this FIXTURE still
    // drives the resubmit branch moves to §5, where it is observable (the idle
    // title). Neither claim was dropped; each moved to a state that can show
    // it.
    expect(screen.getByTestId("submit-review-success-ask")).toBeInTheDocument();
    expect(screen.getByText(SUCCESS_TITLE)).toBeInTheDocument();
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


describe("BACKLOG-2849 §5 — the success screen says it SUCCEEDED", () => {
  /**
   * The founder's second correction of 2026-08-24. §4b had moved the
   * confirmation out of the modal entirely, leaving it to the header and the
   * success toast — but the toast auto-dismisses after 5000ms, and what it
   * leaves behind is a dialog still headed "Submit for Review", asking a
   * question that has already been answered. His three changes:
   *
   *   1. the check graphic takes the green treatment of the Submitted badge
   *   2. the title reads "Successfully Submitted"
   *   3. a Done button beside Export PDF closes the modal
   *
   * Change 1 is asserted in §4b above, where the glyph count already lives —
   * splitting the identity pin from the count would let them drift.
   *
   * EVERY assertion here is by identity, not presence: which title, which
   * colour, which handler, in which order. Presence checks pass on the very
   * defects this ticket has already produced once (two glyphs, a wrong-branch
   * title), which is why the suite counts and names rather than merely looks.
   */

  it("titles the success screen 'Successfully Submitted'", () => {
    renderModal({ isSubmitting: false, progress: SUCCESS });

    expect(screen.getAllByText(SUCCESS_TITLE)).toHaveLength(1);
    // ZERO, not "is not the heading". The whole complaint is that a dialog
    // still carrying the words "Submit for Review" was the only thing left on
    // screen once the toast cleared — anywhere on the success screen is one
    // too many.
    expect(screen.queryAllByText(IDLE_TITLE)).toHaveLength(0);
    expect(screen.queryAllByText(RESUBMIT_TITLE)).toHaveLength(0);
  });

  it("leaves the IDLE title alone", () => {
    // Guards against retitling the wrong branch: a component that simply
    // renamed the header would pass the success case above and fail here.
    renderModal();

    expect(screen.getByText(IDLE_TITLE)).toBeInTheDocument();
    expect(screen.queryAllByText(SUCCESS_TITLE)).toHaveLength(0);
  });

  it("leaves the idle RESUBMIT title alone", () => {
    // Also the liveness proof for `resubmitTransaction` that §4b handed over:
    // this is the state where the fixture's effect is observable.
    renderModal({ transaction: resubmitTransaction });

    expect(screen.getByText(RESUBMIT_TITLE)).toBeInTheDocument();
    expect(screen.queryAllByText(SUCCESS_TITLE)).toHaveLength(0);
  });

  it("does not retitle MID-UPLOAD", () => {
    renderModal({ isSubmitting: true, progress: UPLOADING });

    expect(screen.getByText(IDLE_TITLE)).toBeInTheDocument();
    expect(screen.queryAllByText(SUCCESS_TITLE)).toHaveLength(0);
  });

  it("does not retitle when the submit FAILED", () => {
    // The boundary that matters most: a screen headed "Successfully Submitted"
    // above a "Submission Failed" panel would be a lie, not a cosmetic slip.
    renderModal({
      isSubmitting: false,
      progress: FAILED,
      error: "Network unreachable",
    });

    expect(screen.queryAllByText(SUCCESS_TITLE)).toHaveLength(0);
    expect(screen.getByText(IDLE_TITLE)).toBeInTheDocument();
    expect(screen.getByText("Submission Failed")).toBeInTheDocument();
  });

  it("uses that ONE title on the resubmit branch too", () => {
    // Disclosed consequence, pinned rather than left to drift: the founder
    // gave one string and did not mention resubmits, so a successful RESUBMIT
    // also reads "Successfully Submitted". Inventing "Successfully
    // Resubmitted" would be his wording to choose, not this suite's. If he
    // rules the other way, this test is what changes.
    renderModal({
      transaction: resubmitTransaction,
      isSubmitting: false,
      progress: SUCCESS,
    });

    expect(screen.getAllByText(SUCCESS_TITLE)).toHaveLength(1);
    expect(screen.queryAllByText(RESUBMIT_TITLE)).toHaveLength(0);
  });

  it("offers Done on the success screen, and clicking it CLOSES the modal", () => {
    const { onCancel, onSubmit } = renderModal({
      isSubmitting: false,
      progress: SUCCESS,
    });

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    // The close handler fired — `onCancel` is what TransactionDetails wires to
    // `setShowSubmitModal(false)` + `resetSubmit()`.
    expect(onCancel).toHaveBeenCalledTimes(1);
    // And it did NOT submit. A Done wired to `onSubmit` would look identical
    // on screen and would send an already-submitted deal a second time — the
    // duplicate-submission hazard filed as BACKLOG-2853.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers no Done BEFORE the submit", () => {
    // He asked for Done on the success screen. On the idle screen it would sit
    // beside Submit reading like a way to accept the dialog, next to the
    // button that actually does.
    renderModal();

    expect(screen.queryByTestId("submit-review-done")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Done" }),
    ).not.toBeInTheDocument();
  });

  it("offers no Done MID-UPLOAD", () => {
    renderModal({ isSubmitting: true, progress: UPLOADING });

    expect(screen.queryByTestId("submit-review-done")).not.toBeInTheDocument();
  });

  it("offers no Done after a FAILURE", () => {
    // "Done" over a failed submit would read as an outcome. The X still gets
    // the user out.
    renderModal({
      isSubmitting: false,
      progress: FAILED,
      error: "Network unreachable",
    });

    expect(screen.queryByTestId("submit-review-done")).not.toBeInTheDocument();
  });

  it("puts Done LAST in the actions row, after Export PDF", () => {
    // "next to the export pdf" — and last, because it is the action that ends
    // the flow. In this `justify-end` row last means rightmost, the slot
    // Submit occupies on the idle screen.
    renderModal({ isSubmitting: false, progress: SUCCESS });

    const exportButton = screen.getByRole("button", { name: "Export PDF" });
    const done = screen.getByRole("button", { name: "Done" });

    expect(
      exportButton.compareDocumentPosition(done) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // "next to", not merely "somewhere later on the screen".
    expect(done.parentElement).toBe(exportButton.parentElement);
  });

  it("leaves Export PDF exactly as it was — same place, same styling, same handler", () => {
    // Adding Done must not disturb the control the founder confirmed working.
    const { onExport, onSubmit, onCancel } = renderModal({
      isSubmitting: false,
      progress: SUCCESS,
    });

    const sentence = screen.getByTestId("submit-review-success-ask");
    const exportButton = screen.getByRole("button", { name: "Export PDF" });

    // Still after the sentence that points at it ("...the export pdf button
    // below").
    expect(
      sentence.compareDocumentPosition(exportButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Still the filled treatment it carried when it was the only action here.
    // Whether it should step back to the outlined secondary now that Done sits
    // beside it is a visual-weight question raised for the founder; until he
    // rules, "unchanged" is the assertion, and this is what would go red if
    // someone changed it quietly.
    expect(exportButton).toHaveClass("bg-blue-600", "text-white");

    // Still its own handler — Done did not steal the click, and Export PDF
    // neither closes nor submits.
    fireEvent.click(exportButton);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
