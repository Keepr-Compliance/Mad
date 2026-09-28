/**
 * BACKLOG-3477 PR E — TransactionDetails turns the pre-submit checklist
 * warning on ONLY when the plan allows checklists.
 *
 * For every other gate value the Checklist tab is read-only
 * (TransactionChecklistTab.tsx `readOnly = gate !== "allowed"`), so a warning
 * would name items the agent cannot tick. The modal's own suite
 * (SubmitForReviewModal.checklistWarning-3477) pins what the warning does; this
 * file owns one question — what TransactionDetails passes it.
 *
 * The gate values are the `StrictFeatureStateOrPending` union
 * (electron/types/featureGate.ts). Harness copied from
 * TransactionDetails.submitDatesReread-3498.test.tsx.
 */
import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import type { StrictFeatureStateOrPending } from "../../../electron/types/featureGate";

const mockGate: { value: StrictFeatureStateOrPending } = { value: "allowed" };

jest.mock("../../contexts/StrictFeatureContext", () => ({
  useSessionStrictFeatureState: () => mockGate.value,
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team",
    hasAIAddon: false,
    organizationId: "org-3477",
    canExport: false,
    canSubmit: true,
    canAutoDetect: false,
    isLoading: false,
    isLicenseResolved: true,
    refresh: jest.fn(),
  }),
}));

jest.mock("../ExportModal", () => ({
  __esModule: true,
  default: () => null,
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
    TransactionDetailsTab: () => null,
    TransactionTabs: () => null,
    ReviewNotesPanel: () => null,
    DeleteConfirmModal: () => null,
    UnlinkEmailModal: () => null,
    EmailViewModal: () => null,
    RejectReasonModal: () => null,
    EditContactsModal: () => null,
  };
});

jest.mock("../transactionDetailsModule/components/modals/SubmitForReviewModal", () => ({
  SubmitForReviewModal: (props: { checklistsEnabled?: boolean }) => (
    <div data-testid="submit-modal">
      <span data-testid="checklists-enabled">{String(props.checklistsEnabled)}</span>
    </div>
  ),
}));

jest.mock("../transactionDetailsModule/components/ReviewNotesPanel", () => ({
  ReviewNotesPanel: () => null,
}));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3477", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-3477", email: "t@t.com" }),
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

const row = {
  id: "txn-3477",
  user_id: "user-3477",
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
  closed_at: "2026-03-14",
};

beforeEach(() => {
  window.api.transactions.getDetails = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...row, communications: [], contact_assignments: [] },
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getOverview = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...row, contact_assignments: [] },
  });
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
  /* eslint-enable @typescript-eslint/no-explicit-any */
  window.api.contacts.getAll = jest.fn().mockResolvedValue({ success: true, contacts: [] });
});

async function openSubmit(): Promise<string | null> {
  render(<TransactionDetails transaction={row as never} onClose={jest.fn()} />, {
    wrapper: NotificationProvider,
  });
  await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByTestId("hdr-complete"));
  });
  await waitFor(() => expect(screen.getByTestId("submit-modal")).toBeInTheDocument());
  return screen.getByTestId("checklists-enabled").textContent;
}

it.each<[StrictFeatureStateOrPending, string]>([
  ["allowed", "true"],
  ["blocked", "false"],
  ["unknown", "false"],
  ["pending", "false"],
])("gate %s → checklistsEnabled %s", async (gate, expected) => {
  mockGate.value = gate;
  expect(await openSubmit()).toBe(expected);
});
