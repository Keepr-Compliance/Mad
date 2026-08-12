/**
 * Tests for TransactionHeader component
 * Verifies action button visibility based on license type (BACKLOG-459)
 * TASK-2159: Migrated from useLicense to useFeatureGate for LicenseGate
 */

import React from "react";
import { render, screen } from "@testing-library/react";
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

  describe("BACKLOG-459: Team License Export After Submission", () => {
    it("should show both Submit and Export buttons for team license users", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("team", false, false));
      setFeatureGateForLicense("team");
      const transaction = createMockTransaction({ submission_status: "not_submitted" });

      render(<TransactionHeader {...defaultProps} transaction={transaction} />);

      // Team should see Submit button (appears in both mobile and desktop layouts)
      expect(screen.getAllByRole("button", { name: /submit for review/i })[0]).toBeInTheDocument();
      // Team should also see Export button (BACKLOG-459)
      expect(screen.getAllByRole("button", { name: /export/i })[0]).toBeInTheDocument();
      // Note: Edit and Delete buttons are now in the Overview tab, not the header
    });

    it("should show only Export button for individual license users (no Submit)", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("individual", false, false));
      setFeatureGateForLicense("individual");
      const transaction = createMockTransaction();

      render(<TransactionHeader {...defaultProps} transaction={transaction} />);

      // Individual should NOT see Submit button
      expect(screen.queryByRole("button", { name: /submit for review/i })).not.toBeInTheDocument();
      // Individual should see Export button (appears in both mobile and desktop layouts)
      expect(screen.getAllByRole("button", { name: /export/i })[0]).toBeInTheDocument();
      // Note: Edit and Delete buttons are now in the Overview tab, not the header
    });

    it("should show Export button for team users even after submission", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("team", false, false));
      setFeatureGateForLicense("team");
      const transaction = createMockTransaction({ submission_status: "submitted" });

      render(<TransactionHeader {...defaultProps} transaction={transaction} />);

      // Team should see Submitted badge instead of Submit button
      expect(screen.queryByRole("button", { name: /submit for review/i })).not.toBeInTheDocument();
      expect(screen.getAllByText(/submitted/i)[0]).toBeInTheDocument();
      // Team should still see Export button (BACKLOG-459: available after submission)
      expect(screen.getAllByRole("button", { name: /export/i })[0]).toBeInTheDocument();
    });

    it("should show Resubmit button for team users when needs_changes", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("team", false, false));
      setFeatureGateForLicense("team");
      const transaction = createMockTransaction({ submission_status: "needs_changes" });

      render(<TransactionHeader {...defaultProps} transaction={transaction} />);

      // Team should see Resubmit button (appears in both mobile and desktop layouts)
      expect(screen.getAllByRole("button", { name: /resubmit/i })[0]).toBeInTheDocument();
      // Team should also see Export button
      expect(screen.getAllByRole("button", { name: /export/i })[0]).toBeInTheDocument();
    });

    it("should show both Submit and Export for enterprise license users", () => {
      mockUseLicense.mockReturnValue(createMockLicenseContext("enterprise", false, false));
      setFeatureGateForLicense("enterprise");
      const transaction = createMockTransaction({ submission_status: "not_submitted" });

      render(<TransactionHeader {...defaultProps} transaction={transaction} />);

      // Enterprise should see Submit button (same as team, appears in both mobile and desktop layouts)
      expect(screen.getAllByRole("button", { name: /submit for review/i })[0]).toBeInTheDocument();
      // Enterprise should also see Export button
      expect(screen.getAllByRole("button", { name: /export/i })[0]).toBeInTheDocument();
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
