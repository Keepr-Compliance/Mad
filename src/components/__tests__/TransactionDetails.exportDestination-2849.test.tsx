/**
 * BACKLOG-2849 — "the export flow it brings up should be just like the
 * individual user export" (founder, 2026-08-23).
 *
 * The risk this file exists to remove is DRIFT, not wiring. Both routes reach
 * ExportModal today; nothing stops a later change from giving the brokerage
 * button its own trimmed export — a PDF-only path, a different default format,
 * a variant that skips the date-verification step — and no existing test would
 * notice, because each route would still "open an export".
 *
 * So the assertion is IDENTITY, not behaviour: the two entry points must reach
 * the SAME component with the SAME props.
 *
 *   individual → Complete ─────────────────────┐
 *                                              ├─→ ExportModal(transaction, userId)
 *   brokerage  → Complete → submit modal → Export ┘
 *
 * Props are compared as a whole object, so a route that reached ExportModal
 * with a different transaction, a different user, or an extra "brokerage mode"
 * flag fails here rather than shipping two export experiences for one feature.
 *
 * WHY STUBS. TransactionHeader and SubmitForReviewModal are stubbed down to
 * bare buttons on purpose: their own suites
 * (TransactionHeader.exportAndSubmittedState-2849, SubmitForReviewModal
 * .submitScreen-2849) already pin what they render. This file owns exactly one
 * question — where the two routes LAND — and stubbing keeps a change in either
 * component's markup from turning this red for the wrong reason.
 */
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";

type ExportProps = { transactionId: string; userId: string };

/** Every mount of the export destination, in order, with the props it got. */
const exportMounts: ExportProps[] = [];
/** The `showExport` value TransactionDetails handed the header, per render. */
let capturedShowExport: boolean | undefined;

const mockLicense = {
  value: {
    licenseType: "individual" as string,
    hasAIAddon: false,
    organizationId: null as string | null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: false,
    isLoading: false,
    refresh: jest.fn(),
  },
};

jest.mock("../ExportModal", () => ({
  __esModule: true,
  default: (props: { transaction: { id: string }; userId: string }) => {
    exportMounts.push({ transactionId: props.transaction.id, userId: props.userId });
    return <div data-testid="export-destination" />;
  },
}));

jest.mock("../transactionDetailsModule", () => {
  const actual = jest.requireActual<typeof import("../transactionDetailsModule")>(
    "../transactionDetailsModule",
  );
  return {
    ...actual,
    TransactionHeader: (props: {
      onComplete?: () => void;
      onShowExportModal: () => void;
      showExport?: boolean;
    }) => {
      capturedShowExport = props.showExport;
      return (
        <div>
          <button data-testid="hdr-complete" onClick={() => props.onComplete?.()} />
          <button data-testid="hdr-export" onClick={props.onShowExportModal} />
        </div>
      );
    },
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
  SubmitForReviewModal: (props: { onExport?: () => void }) => (
    <div data-testid="submit-modal">
      <button data-testid="modal-export" onClick={() => props.onExport?.()} />
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
  useAuth: () => ({ currentUser: { id: "user-2849", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-2849", email: "t@t.com" }),
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

const baseTransaction = {
  id: "txn-2849",
  user_id: "user-2849",
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
};

function setLicense(kind: "individual" | "brokerage") {
  mockLicense.value = {
    ...mockLicense.value,
    licenseType: kind === "individual" ? "individual" : "team",
    organizationId: kind === "individual" ? null : "org-2849",
    canExport: kind === "individual",
    canSubmit: kind === "brokerage",
  };
}

beforeEach(() => {
  exportMounts.length = 0;
  capturedShowExport = undefined;
  setLicense("individual");

  window.api.transactions.getDetails = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getOverview = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, contact_assignments: [] },
  });
  (window.api.transactions as any).getCommunications = jest.fn().mockResolvedValue({
    success: true,
    transaction: { communications: [], contact_assignments: [] },
  });
  (window.api.transactions as any).isAutoSyncInFlight = jest.fn().mockResolvedValue({ inFlight: false });
  // The Complete gate re-reads this AT CLICK TIME and blocks on anything above
  // zero, so an empty queue is what lets either route through to its branch.
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

const renderDetails = () =>
  render(
    <TransactionDetails transaction={baseTransaction as never} onClose={jest.fn()} />,
    { wrapper: NotificationProvider },
  );

/** Drives the individual route: Complete branches straight to export. */
async function exportAsIndividual(): Promise<ExportProps> {
  setLicense("individual");
  renderDetails();
  // The screen loads details before it renders the header at all.
  await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("hdr-complete"));
  await waitFor(() => expect(screen.getByTestId("export-destination")).toBeInTheDocument());
  return exportMounts[exportMounts.length - 1];
}

/** Drives the brokerage route: Complete → submit modal → its Export button. */
async function exportAsBrokerage(): Promise<ExportProps> {
  setLicense("brokerage");
  renderDetails();
  await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("hdr-complete"));
  await waitFor(() => expect(screen.getByTestId("submit-modal")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("modal-export"));
  await waitFor(() => expect(screen.getByTestId("export-destination")).toBeInTheDocument());
  return exportMounts[exportMounts.length - 1];
}

describe("BACKLOG-2849 — both export entry points land on the same flow", () => {
  it("routes an individual's Complete to the export destination", async () => {
    const props = await exportAsIndividual();

    expect(props).toEqual({ transactionId: "txn-2849", userId: "user-2849" });
    // The branch really did go to export, not to the submit confirmation.
    expect(screen.queryByTestId("submit-modal")).not.toBeInTheDocument();
  });

  it("routes a brokerage user's modal Export to the SAME destination, with the SAME props", async () => {
    const individual = await exportAsIndividual();
    cleanup();
    exportMounts.length = 0;

    const brokerage = await exportAsBrokerage();

    // Whole-object comparison. A brokerage-specific export — a different
    // component, a trimmed PDF-only path, an extra mode flag — fails here.
    expect(brokerage).toEqual(individual);
  });

  it("routes the brokerage HEADER Export button to that same destination too", async () => {
    // The third entry point, added by this ticket. Three routes, one flow.
    setLicense("brokerage");
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-export")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("hdr-export"));

    await waitFor(() => expect(screen.getByTestId("export-destination")).toBeInTheDocument());
    expect(exportMounts[exportMounts.length - 1]).toEqual({
      transactionId: "txn-2849",
      userId: "user-2849",
    });
  });

  it("mounts exactly ONE export destination, never a parallel one", async () => {
    await exportAsBrokerage();

    expect(screen.getAllByTestId("export-destination")).toHaveLength(1);
    expect(exportMounts).toHaveLength(1);
  });
});

describe("BACKLOG-2849 — the header Export button is wired to the licence branch", () => {
  it("is offered to a brokerage user", async () => {
    setLicense("brokerage");
    renderDetails();

    await waitFor(() => expect(capturedShowExport).toBe(true));
  });

  it("is NOT offered to an individual, whose Complete already exports", async () => {
    setLicense("individual");
    renderDetails();

    await waitFor(() => expect(capturedShowExport).toBe(false));
  });
});
