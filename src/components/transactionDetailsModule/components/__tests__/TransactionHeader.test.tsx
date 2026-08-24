/**
 * Tests for TransactionHeader component
 * Verifies action button visibility based on license type (BACKLOG-459)
 * TASK-2159: Migrated from useLicense to useFeatureGate for LicenseGate
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionHeader } from "../TransactionHeader";
import type { Transaction } from "@/types";

// Mock the useLicense hook (still used by some sub-components)
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: jest.fn(),
}));

// TASK-2159: Mock the useFeatureGate hook (LicenseGate now uses this)
const mockIsAllowed = jest.fn();
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    refresh: jest.fn(),
  }),
}));

import { useLicense } from "@/contexts/LicenseContext";

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

const mockUseLicense = useLicense as jest.MockedFunction<typeof useLicense>;

// Helper to create mock license context value.
// Deliberately partial: LicenseContextValue also requires hasInitialized,
// validationStatus, isValid, blockReason, trialDaysRemaining, transactionCount,
// transactionLimit and canCreateTransaction. Supplying them would change what the
// header's LicenseGate sub-components see, so the shape these tests were written
// against is preserved and only the static type is asserted.
function createMockLicenseContext(licenseType: "individual" | "team" | "enterprise", hasAIAddon = false, isLoading = false) {
  return {
    licenseType,
    hasAIAddon,
    organizationId: licenseType === "individual" ? null : "org-123",
    canExport: licenseType === "individual",
    canSubmit: licenseType === "team" || licenseType === "enterprise",
    canAutoDetect: hasAIAddon,
    isLoading,
    refresh: jest.fn(),
    // `unknown` hop is required because `refresh: jest.fn()` is a jest.Mock, not
    // the plain `() => Promise<void>` the context declares.
  } as unknown as ReturnType<typeof useLicense>;
}

/**
 * Helper to configure useFeatureGate mock based on license type.
 * Maps license types to feature flags that LicenseGate checks:
 *   - individual: text_export=true, broker_submission=false
 *   - team/enterprise: text_export=true, broker_submission=true
 */
function setFeatureGateForLicense(licenseType: "individual" | "team" | "enterprise") {
  const featureMap: Record<string, boolean> = {
    text_export: true,
    email_export: true,
  };
  if (licenseType === "team" || licenseType === "enterprise") {
    featureMap.broker_submission = true;
  }
  mockIsAllowed.mockImplementation((key: string) => !!featureMap[key]);
}

// Create mock transaction
function createMockTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-123",
    user_id: "user-123",
    property_address: "123 Main St",
    status: "active",
    export_status: "not_exported",
    export_count: 0,
    message_count: 5,
    attachment_count: 2,
    submission_status: "not_submitted",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Default props for TransactionHeader
const defaultProps = {
  isPendingReview: false,
  isRejected: false,
  isApproving: false,
  isRejecting: false,
  isRestoring: false,
  isSubmitting: false,
  onClose: jest.fn(),
  onShowRejectReasonModal: jest.fn(),
  onShowEditModal: jest.fn(),
  onApprove: jest.fn(),
  onRestore: jest.fn(),
  onShowExportModal: jest.fn(),
  onShowDeleteConfirm: jest.fn(),
  onShowSubmitModal: jest.fn(),
};

describe("TransactionHeader", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * BACKLOG-2792 — Export and Submit for Review are MERGED into one "Complete"
   * button, so the old per-license button matrix no longer applies at the
   * header: the header shows the SAME two buttons to everyone (Needs Review,
   * Complete) and the license branch happens inside Complete's handler, after
   * the completeness gate. The branch itself is covered by
   * useCompleteTransaction.licenseBranch-2792.test.ts.
   *
   * Note both layouts render the action set (mobile `sm:hidden` + desktop), so
   * every query here uses getAllBy*()[0] — asserting a single match would fail
   * on the duplicate that has always been there.
   */
  describe("BACKLOG-2792: one Complete button replaces Export + Submit", () => {
    it("shows Complete and Needs Review, and NEITHER a bare Export nor a Submit button, for an individual license", () => {
      setFeatureGateForLicense("individual");
      // reviewCount > 0 so Needs Review is on screen at all — it is hidden when
      // the queue is empty (founder ruling). What this test is about is that
      // Export and Submit are GONE, replaced by Complete.
      render(
        <TransactionHeader
          {...defaultProps}
          transaction={createMockTransaction()}
          reviewCount={2}
        />,
      );

      expect(screen.getAllByTestId("complete-button")[0]).toBeInTheDocument();
      expect(screen.getAllByTestId("needs-review-button")[0]).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^export$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /submit for review/i })).not.toBeInTheDocument();
    });

    it("shows the SAME two buttons for a team license — the header no longer branches", () => {
      setFeatureGateForLicense("team");
      // reviewCount > 0 so Needs Review is on screen at all — it is hidden when
      // the queue is empty (founder ruling). What this test is about is that
      // Export and Submit are GONE, replaced by Complete.
      render(
        <TransactionHeader
          {...defaultProps}
          transaction={createMockTransaction()}
          reviewCount={2}
        />,
      );

      expect(screen.getAllByTestId("complete-button")[0]).toBeInTheDocument();
      expect(screen.getAllByTestId("needs-review-button")[0]).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^export$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /submit for review/i })).not.toBeInTheDocument();
    });

    it("still shows Complete after submission, so an export remains reachable (BACKLOG-459's actual requirement)", () => {
      setFeatureGateForLicense("team");
      render(
        <TransactionHeader
          {...defaultProps}
          transaction={createMockTransaction({ submission_status: "submitted" })}
        />,
      );

      expect(screen.getAllByTestId("complete-button")[0]).toBeInTheDocument();
      expect(screen.getAllByText(/submitted/i)[0]).toBeInTheDocument();
    });

    it("clicking Complete calls onComplete, NOT onShowExportModal — the gate must run first", () => {
      setFeatureGateForLicense("individual");
      const onComplete = jest.fn();
      const onShowExportModal = jest.fn();
      render(
        <TransactionHeader
          {...defaultProps}
          transaction={createMockTransaction()}
          onComplete={onComplete}
          onShowExportModal={onShowExportModal}
        />,
      );

      fireEvent.click(screen.getAllByTestId("complete-button")[0]);

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onShowExportModal).not.toHaveBeenCalled();
    });
  });

  describe("BACKLOG-2791: the Needs Review button and its live badge", () => {
    it("hides the whole BUTTON at zero and shows it with the exact count above zero", () => {
      // Founder ruling 2026-08-22, superseding "always visible": a button that
      // opens an empty screen is a dead control. Complete stays visible either
      // way — asserted below so the two are not confused.
      setFeatureGateForLicense("individual");
      const { rerender } = render(
        <TransactionHeader {...defaultProps} transaction={createMockTransaction()} reviewCount={0} />,
      );
      expect(screen.queryByTestId("needs-review-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("needs-review-badge")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("complete-button")[0]).toBeInTheDocument();

      rerender(
        <TransactionHeader {...defaultProps} transaction={createMockTransaction()} reviewCount={7} />,
      );
      expect(screen.getAllByTestId("needs-review-button")[0]).toBeInTheDocument();
      expect(screen.getAllByTestId("needs-review-badge")[0]).toHaveTextContent("7");
    });

    it("opens the review screen when clicked", () => {
      setFeatureGateForLicense("individual");
      const onShowNeedsReview = jest.fn();
      render(
        <TransactionHeader
          {...defaultProps}
          transaction={createMockTransaction()}
          reviewCount={3}
          onShowNeedsReview={onShowNeedsReview}
        />,
      );

      fireEvent.click(screen.getAllByTestId("needs-review-button")[0]);
      expect(onShowNeedsReview).toHaveBeenCalledTimes(1);
    });
  });

  describe("Pending Review Mode", () => {
    it("should show Approve/Reject/Edit buttons in pending review mode", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("team", false, false));
      setFeatureGateForLicense("team");
      const transaction = createMockTransaction();

      render(
        <TransactionHeader
          {...defaultProps}
          transaction={transaction}
          isPendingReview={true}
        />
      );

      // Pending review should show Approve, Reject, Edit (appear in both mobile and desktop layouts)
      expect(screen.getAllByRole("button", { name: /approve/i })[0]).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /reject/i })[0]).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /edit/i })[0]).toBeInTheDocument();
      // Should NOT show Export/Submit/Delete in pending review mode
      expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /submit/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    });
  });

  describe("Rejected Mode", () => {
    it("should show Restore/Delete buttons in rejected mode", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("team", false, false));
      setFeatureGateForLicense("team");
      const transaction = createMockTransaction();

      render(
        <TransactionHeader
          {...defaultProps}
          transaction={transaction}
          isRejected={true}
        />
      );

      // Rejected should show Restore and Delete (appear in both mobile and desktop layouts)
      expect(screen.getAllByRole("button", { name: /restore/i })[0]).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /delete/i })[0]).toBeInTheDocument();
      // Should NOT show Export/Submit/Edit in rejected mode
      expect(screen.queryByRole("button", { name: /export/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /submit/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    });
  });
});
