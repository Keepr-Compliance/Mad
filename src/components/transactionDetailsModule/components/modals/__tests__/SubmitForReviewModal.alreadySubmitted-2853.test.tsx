/**
 * BACKLOG-2853 — THE MODAL MUST NOT OFFER A FRESH "SUBMIT" ON A DEAL WHOSE
 * SUBMISSION IS ALREADY WITH THE BROKER.
 *
 * The state under test is the RE-ENTRY state the founder's report names, and
 * it is reachable in one click: BACKLOG-2792 made Complete the single entry
 * point, `openSubmitFlow` refreshes the transaction and opens this modal, and
 * `onCancel` runs `resetSubmit()` which nulls `progress`. So a user who has
 * already submitted and presses Complete again lands exactly here.
 *
 * FIXTURE PROVENANCE. `submission_status` is the ONLY input the component
 * reads for this branch — `SubmitForReviewModal.tsx` derives both
 * `submissionIsWithBroker` and `isResubmit` from it and from nothing else —
 * and its permitted values are the `SubmissionStatus` union in
 * electron/types/models.ts:57-64, transcribed below in full. `progress: null`
 * is what `useSubmitForReview.reset()` sets (`setProgress(null)`), not a
 * guess at an idle shape.
 *
 * The measurement the item was filed on, taken on this component before the
 * fix, at `submission_status: "submitted"` with `progress: null`:
 *   {"submitButtonLive":true,"submitDisabled":false,
 *    "readsResubmit":false,"warnsAboutExisting":false}
 *
 * CONTROL C4 (run manually, result on BACKLOG-2853): revert
 * `submissionIsWithBroker` to `false` in the component → the "does not read
 * Submit", "is disabled" and "warns about the existing submission"
 * expectations below all go red together, reproducing that measurement.
 *
 * RUNNER: npx jest src/components/transactionDetailsModule/components/modals/__tests__/SubmitForReviewModal.alreadySubmitted-2853.test.tsx
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SubmitForReviewModal } from "../SubmitForReviewModal";
import type { Transaction } from "@/types";

const baseTransaction = {
  id: "txn-2853",
  user_id: "user-2853",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  status: "active",
} as unknown as Transaction;

function renderAt(submissionStatus?: string) {
  return render(
    <SubmitForReviewModal
      transaction={
        (submissionStatus === undefined
          ? baseTransaction
          : { ...baseTransaction, submission_status: submissionStatus }) as Transaction
      }
      emailCount={4}
      textThreadCount={2}
      attachmentCount={3}
      emailAttachmentCount={1}
      totalSizeBytes={2048}
      isSubmitting={false}
      // The exact re-entry state: `resetSubmit()` nulls progress.
      progress={null}
      error={null}
      onCancel={jest.fn()}
      onSubmit={jest.fn()}
      onExport={jest.fn()}
    />
  );
}

/** The action button, found by testid so its LABEL can be asserted freely. */
const action = () => screen.getByTestId("submit-review-submit");

describe("BACKLOG-2853 — the action on a deal already with the broker", () => {
  test("at 'submitted' the action does NOT read 'Submit', and is disabled", () => {
    renderAt("submitted");

    expect(action()).not.toHaveTextContent(/^Submit$/);
    expect(action()).toHaveTextContent("Already Submitted");
    expect(action()).toBeDisabled();

    // The measurement's `submitButtonLive` half, stated as a query rather
    // than by label: no enabled control named "Submit" exists on this screen.
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });

  test("at 'submitted' the screen SAYS a submission already exists — `warnsAboutExisting` was false when this was filed", () => {
    renderAt("submitted");

    expect(
      screen.getByText(/already been submitted and is with your broker/i)
    ).toBeInTheDocument();
    // And it does not keep promising to send data it will not send.
    expect(
      screen.queryByText(/The following data will be sent to your broker/i)
    ).not.toBeInTheDocument();
    // The title asked a question about an act the service refuses.
    expect(screen.queryByText("Submit for Review")).not.toBeInTheDocument();
    // Heading, specifically — the button carries the same words, and asserting
    // on the text alone would pass on either one.
    expect(
      screen.getByRole("heading", { name: "Already Submitted" })
    ).toBeInTheDocument();
  });

  test("Export PDF stays available, so the dialog is not a dead end", () => {
    renderAt("submitted");
    expect(screen.getByTestId("submit-review-export")).toBeEnabled();
    expect(screen.getByTestId("submit-review-close")).toBeInTheDocument();
  });

  /**
   * The whole `SubmissionStatus` union, transcribed from
   * electron/types/models.ts:57-64. Derived by EXECUTION: the label and the
   * enabled/disabled state are read off a real render of each status rather
   * than asserted against a list copied out of the component.
   */
  test.each([
    ["not_submitted", "Submit", false],
    ["submitted", "Already Submitted", true],
    ["under_review", "Already Submitted", true],
    ["needs_changes", "Resubmit", false],
    ["resubmitted", "Resubmit", false],
    ["approved", "Already Submitted", true],
    ["rejected", "Already Submitted", true],
  ])("status %s → label %s, disabled=%s", (status, label, disabled) => {
    renderAt(status as string);
    expect(action()).toHaveTextContent(label as string);
    if (disabled) {
      expect(action()).toBeDisabled();
    } else {
      expect(action()).toBeEnabled();
    }
  });

  test("a transaction with NO submission_status is untouched — this is the first-submit screen", () => {
    renderAt(undefined);
    expect(action()).toHaveTextContent("Submit");
    expect(action()).toBeEnabled();
    expect(
      screen.getByRole("heading", { name: "Submit for Review" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The following data will be sent to your broker/i)
    ).toBeInTheDocument();
  });

  /**
   * The disabled set is exactly the four statuses `submissionService`'s
   * `blockedStatuses` refuses. The two lists live in different files because
   * the main/renderer boundary forbids a shared value import, so this pins the
   * renderer's half as a SET; the service's half is pinned by execution in
   * electron/services/__tests__/submissionResubmitGuard-2853.test.ts. A change
   * to either without the other turns one of the two red.
   */
  test("the disabled SET matches the service's blockedStatuses SET", () => {
    const disabled = new Set<string>();
    for (const status of [
      "not_submitted",
      "submitted",
      "under_review",
      "needs_changes",
      "resubmitted",
      "approved",
      "rejected",
    ]) {
      const { unmount } = renderAt(status);
      if ((action() as HTMLButtonElement).disabled) disabled.add(status);
      unmount();
    }
    expect(disabled).toEqual(
      new Set(["submitted", "under_review", "approved", "rejected"])
    );
  });
});
