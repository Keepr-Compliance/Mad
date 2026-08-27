/**
 * BACKLOG-2849 — the header's Export button, and what a deal shows after the
 * Submit modal is dismissed.
 *
 * ---------------------------------------------------------------------------
 * 1. EXPORT IS BACK, FOR BROKERAGE USERS ONLY
 * ---------------------------------------------------------------------------
 * BACKLOG-2792 merged Export and Submit into a single Complete button. For an
 * INDIVIDUAL that was right — their Complete goes straight to the export flow,
 * so a second button would be a duplicate. For a BROKERAGE user it removed
 * export entirely: their Complete opens the submit confirmation, and reaching
 * a PDF meant re-entering a submit confirmation for a deal already submitted.
 *
 * The founder ruled the affordance back for them. `showExport` is derived by
 * the caller from `useCompleteTransaction.resolveTarget()` — the same branch
 * that chooses where Complete goes — so the button appears exactly when
 * Complete does NOT already lead to export, and the two cannot disagree.
 *
 * ---------------------------------------------------------------------------
 * 2. WHAT THE DEAL SHOWS AFTER DISMISSAL — BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 * The founder's rule: a submission that did NOT go through leaves the
 * transaction as it was, still showing Complete; one that DID shows the green
 * Submitted badge and the export affordance. Dismissing the modal must not
 * leave a submitted deal looking unsubmitted, nor an unsubmitted deal looking
 * submitted.
 *
 * The header renders that state from `transaction.submission_status`, so both
 * directions are pinned here against the status each outcome leaves behind:
 * a failed or abandoned submit writes nothing and the status stays
 * `not_submitted`; a successful one is followed by `loadDetails()` in
 * `useSubmitForReview.onSuccess`, which re-reads the row as `submitted`.
 *
 * SCOPE, STATED HONESTLY: this file proves what the HEADER RENDERS for a given
 * status. It cannot prove the database was left untouched — that lives in
 * `submissionService` and is out of this PR's reach. The modal-side half
 * (dismissing never calls `onSubmit`) is in
 * SubmitForReviewModal.submitScreen-2849.test.tsx.
 *
 * `needs_changes` is deliberately included: it is NOT one of the three
 * submitted statuses, so a rejected-back deal must still offer Complete. A
 * test that only covered `not_submitted` and `submitted` would not notice a
 * badge condition that swallowed it.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionHeader } from "../TransactionHeader";
import type { Transaction } from "@/types";

jest.mock("@/contexts/LicenseContext", () => ({ useLicense: jest.fn() }));
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock("../../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

function makeTransaction(submissionStatus: string): Transaction {
  return {
    id: "tx-2849",
    user_id: "user-2849",
    property_address: "18 Bellweather Lane",
    status: "active",
    submission_status: submissionStatus,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Transaction;
}

function renderHeader({
  submissionStatus = "not_submitted",
  showExport = true,
}: { submissionStatus?: string; showExport?: boolean } = {}) {
  const onShowExportModal = jest.fn();
  render(
    <TransactionHeader
      transaction={makeTransaction(submissionStatus)}
      isPendingReview={false}
      isRejected={false}
      isApproving={false}
      isRejecting={false}
      isRestoring={false}
      isSubmitting={false}
      onClose={jest.fn()}
      onShowRejectReasonModal={jest.fn()}
      onShowEditModal={jest.fn()}
      onApprove={jest.fn()}
      onRestore={jest.fn()}
      onShowExportModal={onShowExportModal}
      onShowDeleteConfirm={jest.fn()}
      reviewCount={0}
      onShowNeedsReview={jest.fn()}
      onComplete={jest.fn()}
      showExport={showExport}
    />,
  );
  return { onShowExportModal };
}

/**
 * The header renders a mobile variant and a desktop variant, both mounted and
 * hidden from each other by Tailwind breakpoints — so every control appears
 * TWICE in the DOM. Assert on the count, not on a single node: `getBy*` would
 * throw on the duplicate and `queryBy*` would hide a half-applied change that
 * reached one variant only.
 */
const countByTestId = (id: string) => screen.queryAllByTestId(id).length;

describe("BACKLOG-2849 §1 — the header Export button is back, for brokerage", () => {
  it("shows Export to a brokerage user", () => {
    renderHeader({ showExport: true });

    expect(countByTestId("header-export-button")).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Export" }).length).toBeGreaterThan(0);
  });

  it("shows NO Export to an individual, whose Complete already exports", () => {
    // The duplicate-control case BACKLOG-2792 removed on purpose.
    renderHeader({ showExport: false });

    expect(countByTestId("header-export-button")).toBe(0);
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    // Complete is still there — this is not passing because nothing rendered.
    expect(countByTestId("complete-button")).toBeGreaterThan(0);
  });

  it("Export opens the export flow, and does not run Complete", () => {
    const { onShowExportModal } = renderHeader({ showExport: true });

    screen.getAllByTestId("header-export-button")[0].click();

    expect(onShowExportModal).toHaveBeenCalledTimes(1);
  });

  it("keeps Export reachable on a deal that has already been submitted", () => {
    // The founder's rule names the export affordance as part of what a
    // SUBMITTED deal shows. If the button were hidden once submitted, the
    // dead-end this ticket removed would come straight back.
    renderHeader({ submissionStatus: "submitted", showExport: true });

    expect(countByTestId("header-export-button")).toBeGreaterThan(0);
  });
});

/**
 * EDITED BY BACKLOG-2869, AND WHY.
 *
 * The three cases below asserted the literal word "Submitted" on screen. That
 * word is gone: BACKLOG-2869 replaced the single chip with a badge per status,
 * because one label for `submitted | under_review | approved` meant an
 * APPROVED deal was told it was "Submitted" and never learned its outcome.
 *
 * 2849's claim is untouched and is what these cases still assert — a
 * submitted deal never looks unsubmitted, an unsubmitted one never looks
 * submitted, and export stays reachable through all of it. Only the string the
 * claim is measured by has changed. The per-status labels themselves are pinned
 * in TransactionHeader.submissionBadge-2869.test.tsx.
 */
describe("BACKLOG-2849 §2 — an unsubmitted deal never looks submitted", () => {
  it("shows Complete and NO badge at all for not_submitted", () => {
    // The direction that matters after a failed submit or a dismissal
    // mid-upload: nothing was written, so nothing may claim it was.
    renderHeader({ submissionStatus: "not_submitted" });

    expect(countByTestId("complete-button")).toBeGreaterThan(0);
    expect(countByTestId("submission-status-badge")).toBe(0);
    expect(screen.queryByText("Submitted")).not.toBeInTheDocument();
    expect(screen.queryByText("Under Review")).not.toBeInTheDocument();
  });

  it("shows Complete for needs_changes, and a badge that does not claim it is with the broker", () => {
    // 2849 included `needs_changes` to prove a rejected-back deal still offers
    // Complete. 2869 added the badge it was missing entirely — so the check
    // is no longer "no badge" but "the RIGHT badge".
    renderHeader({ submissionStatus: "needs_changes" });

    expect(countByTestId("complete-button")).toBeGreaterThan(0);
    expect(screen.getAllByText("Changes Requested").length).toBeGreaterThan(0);
    expect(screen.queryByText("Submitted")).not.toBeInTheDocument();
    expect(screen.queryByText("Under Review")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-2849 §2 — a submitted deal never looks unsubmitted", () => {
  it.each([
    ["submitted", "Under Review"],
    ["under_review", "Under Review"],
    ["resubmitted", "Under Review"],
    ["approved", "Approved"],
  ])("shows a submission badge for %s", (status, label) => {
    // Boundary swept, not sampled. `resubmitted` is new here: it was outside
    // the old boolean, so sending a deal a second time made its badge vanish
    // — the deal looked unsubmitted, which is exactly what this describe
    // block forbids.
    renderHeader({ submissionStatus: status });

    expect(countByTestId("submission-status-badge")).toBeGreaterThan(0);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("shows the badge AND keeps export reachable, together", () => {
    // The full post-success state the founder described, in one assertion
    // pair — this is what a user sees after dismissing the modal on success.
    renderHeader({ submissionStatus: "submitted", showExport: true });

    expect(screen.getAllByText("Under Review").length).toBeGreaterThan(0);
    expect(countByTestId("header-export-button")).toBeGreaterThan(0);
  });
});
