/**
 * BACKLOG-3498 — after the submit dialog SAVES the confirmed dates,
 * TransactionDetails re-reads the row, whatever the submit then does.
 *
 * Why on the save and not on submit success: the Edit form prefills all three
 * dates from TransactionDetails' `transaction` (editTransaction={transaction},
 * useAuditAddressForm.ts:215-223). If the save lands and the submit fails, a
 * row that was only re-read on success stays stale, and a later Edit writes
 * the OLD dates back over the confirmed ones.
 *
 * Why this is not "getDetails was called": openSubmitFlow already calls it when
 * the dialog opens, so that assertion passes with no re-read at all. Instead
 * the "database" returns the pre-save row until the stubbed dialog saves, then
 * the post-save row — and the test asserts the RENDERED value changed.
 * `loadDetails()` also calls getDetails but only reloads communications and
 * contacts (useTransactionDetails.ts:97-113), so it cannot satisfy this test.
 *
 * WHY STUBS: SubmitForReviewModal's own suites pin what it renders and when it
 * saves. This file owns one question — what TransactionDetails does with
 * `onDatesSaved` — so the dialog is a stub that does what the real one does on
 * a successful save: `onDatesSaved()`, then `onSubmit()`. The submit is made to
 * FAIL. TransactionDetailsTab is stubbed to print the dates it is handed.
 *
 * Harness copied from TransactionDetails.exportDestination-2849.test.tsx.
 */
import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";

const mockLicense = {
  value: {
    licenseType: "team" as string,
    hasAIAddon: false,
    organizationId: "org-3498" as string | null,
    canExport: false,
    canSubmit: true,
    canAutoDetect: false,
    isLoading: false,
    isLicenseResolved: true,
    refresh: jest.fn(),
  },
};

jest.mock("../ExportModal", () => ({
  __esModule: true,
  default: () => <div data-testid="export-destination" />,
}));

jest.mock("../transactionDetailsModule", () => {
  const actual = jest.requireActual<typeof import("../transactionDetailsModule")>(
    "../transactionDetailsModule",
  );
  return {
    ...actual,
    TransactionHeader: (props: { onComplete?: () => void }) => (
      <button data-testid="hdr-complete" onClick={() => props.onComplete?.()} />
    ),
    TransactionEmailsTab: () => null,
    TransactionMessagesTab: () => null,
    TransactionAttachmentsTab: () => null,
    TransactionDetailsTab: (props: { transaction: { started_at?: string; closed_at?: string } }) => (
      <div data-testid="details-dates">
        {props.transaction.started_at} → {props.transaction.closed_at}
      </div>
    ),
    TransactionTabs: () => null,
    ReviewNotesPanel: () => null,
    DeleteConfirmModal: () => null,
    UnlinkEmailModal: () => null,
    EmailViewModal: () => null,
    RejectReasonModal: () => null,
    EditContactsModal: () => null,
  };
});

/** The row the stubbed IPC returns. The dialog stub flips it when it "saves". */
const mockDb: { row: Record<string, unknown> } = { row: {} };

jest.mock("../transactionDetailsModule/components/modals/SubmitForReviewModal", () => ({
  SubmitForReviewModal: (props: {
    onDatesSaved?: () => void;
    onSubmit: () => void;
    error: string | null;
  }) => (
    <div data-testid="submit-modal">
      <span data-testid="submit-error">{props.error}</span>
      <button
        data-testid="modal-save-then-submit"
        onClick={() => {
          mockDb.row = { ...mockDb.row, ...mockPostSaveColumns };
          props.onDatesSaved?.();
          props.onSubmit();
        }}
      />
    </div>
  ),
}));

jest.mock("../transactionDetailsModule/components/ReviewNotesPanel", () => ({
  ReviewNotesPanel: () => null,
}));
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => mockLicense.value,
}));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3498", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-3498", email: "t@t.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../common/ResponsiveModal", () => ({
  ResponsiveModal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MODAL_PANEL: { lg: "" },
}));
jest.mock("../common/OfflineNotice", () => ({ OfflineNotice: () => null }));

import TransactionDetails from "../TransactionDetails";

/**
 * Pre-save: date-only start (wizard) and ISO-timestamp end (detection path,
 * electron transactionService.ts:958). Post-save: what
 * saveConfirmedTransactionDates writes for typed dates — updateTransactionSync
 * stores the columns as given.
 */
const preSaveRow = {
  id: "txn-3498",
  user_id: "user-3498",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase" as const,
  status: "active" as const,
  submission_status: "not_submitted",
  message_count: 0,
  attachment_count: 0,
  export_status: "not_exported" as const,
  export_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-05",
  closed_at: "2026-03-14T18:22:05.000Z",
};
const mockPostSaveColumns = {
  started_at: "2026-02-02",
  closing_deadline: "2026-04-20",
  closed_at: "2026-04-25",
  closing_date_verified: 1,
};

beforeEach(() => {
  mockDb.row = { ...preSaveRow };

  window.api.transactions.getDetails = jest.fn().mockImplementation(async () => ({
    success: true,
    transaction: { ...mockDb.row, communications: [], contact_assignments: [] },
  }));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getOverview = jest.fn().mockImplementation(async () => ({
    success: true,
    transaction: { ...mockDb.row, contact_assignments: [] },
  }));
  (window.api.transactions as any).getCommunications = jest.fn().mockResolvedValue({
    success: true,
    transaction: { communications: [], contact_assignments: [] },
  });
  (window.api.transactions as any).isAutoSyncInFlight = jest.fn().mockResolvedValue({ inFlight: false });
  (window.api.transactions as any).getReviewState = jest.fn().mockResolvedValue({
    count: 0,
    items: [],
    threadCount: 0,
  });
  (window.api.transactions as any).syncReviewQueue = jest.fn().mockResolvedValue({
    success: true, added: 0, linked: 0, found: 0,
  });
  // The submit FAILS — the case where a success-only re-read leaves the row stale.
  (window.api.transactions as any).submit = jest
    .fn()
    .mockResolvedValue({ success: false, error: "Network unreachable" });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  window.api.contacts.getAll = jest.fn().mockResolvedValue({ success: true, contacts: [] });
});

it("re-reads the row when the dates are saved, even though the submit then fails", async () => {
  render(
    <TransactionDetails transaction={preSaveRow as never} onClose={jest.fn()} />,
    { wrapper: NotificationProvider },
  );
  await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());
  expect(screen.getByTestId("details-dates")).toHaveTextContent(
    "2026-01-05 → 2026-03-14T18:22:05.000Z",
  );

  fireEvent.click(screen.getByTestId("hdr-complete"));
  await waitFor(() => expect(screen.getByTestId("submit-modal")).toBeInTheDocument());

  await act(async () => {
    fireEvent.click(screen.getByTestId("modal-save-then-submit"));
  });

  // The submit ran and failed, and the dialog is still up showing it.
  await waitFor(() =>
    expect(screen.getByTestId("submit-error")).toHaveTextContent("Network unreachable"),
  );
  // ...and the details now show the SAVED dates.
  await waitFor(() =>
    expect(screen.getByTestId("details-dates")).toHaveTextContent("2026-02-02 → 2026-04-25"),
  );
});
