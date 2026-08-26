/**
 * BACKLOG-2866 — the details screen's export routes are WIRED to the gate.
 *
 * The sibling suite `useCompleteTransaction.exportGate-2866` proves the gate
 * decides correctly. This one proves the buttons actually call it — the part
 * that was broken. `TransactionDetails.tsx:1095` read:
 *
 *     onShowExportModal={() => setShowExportModal(true)}
 *
 * which opened the export modal without consulting review state at all. A hook
 * test can never catch that, because the hook was never invoked. So this file
 * drives the REAL TransactionDetails and asserts on whether an export
 * destination MOUNTS — not on whether a callback fired.
 *
 * Deliberately built on the BACKLOG-2849 harness (same stubs, same shape) so the
 * two files stay comparable: 2849 asks WHERE the routes land, 2866 asks WHETHER
 * they are allowed to leave.
 *
 * NOTHING HERE MOCKS `exportReviewGate`. The real gate runs, reading the real
 * `getReviewState` IPC surface. Mocking it would make the mutate-once control
 * pass vacuously.
 *
 * CONTROLS RUN (measured counts in the PR):
 *   - revert route 2's wiring (back to `setShowExportModal(true)`) → only this
 *     suite reddens, and only its route-2 cases.
 *   - revert route 3's wiring → only its route-3 case.
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";

type ExportProps = { transactionId: string; userId: string };

const exportMounts: ExportProps[] = [];

/** The live queue depth. Read fresh on every IPC call, so a test can fill the
 *  queue mid-flow exactly as a background sync would. */
let queueCount = 0;

const mockLicense = {
  value: {
    licenseType: "team" as string,
    hasAIAddon: false,
    organizationId: "org-2866" as string | null,
    canExport: false,
    canSubmit: true,
    canAutoDetect: false,
    isLoading: false,
    // BACKLOG-2885 — the provider ALWAYS sets this, so a fixture without it
    // describes a state the app cannot emit: it would read as "license not yet
    // known", where Complete refuses to act and the header renders a disabled
    // Export. Every scenario in this file is a license that HAS been read.
    // The unknown state has its own suite, TransactionDetails.licensePending-2885.
    isLicenseResolved: true,
    refresh: jest.fn(),
  },
};

jest.mock("../ExportModal", () => ({
  __esModule: true,
  default: (props: { transaction: { id: string }; userId: string }) => {
    // Counts MOUNTS, not renders — which is what the assertions below say they
    // measure. BACKLOG-2866 made the export routes re-read review state at
    // click time, and that read refreshes the badge, so the screen legitimately
    // re-renders after an export opens. A push-on-render mock counted those as
    // extra export destinations.
    const { useEffect } = require("react") as typeof import("react");
    useEffect(() => {
      exportMounts.push({ transactionId: props.transaction.id, userId: props.userId });
    }, []);
    return <div data-testid="export-destination" />;
  },
}));

jest.mock("../transactionDetailsModule", () => {
  const actual = jest.requireActual<typeof import("../transactionDetailsModule")>(
    "../transactionDetailsModule",
  );
  return {
    ...actual,
    // NOTE: ReviewPromptDialog is deliberately NOT stubbed — the P3 block is
    // what this suite asserts fired.
    TransactionHeader: (props: {
      onComplete?: () => void;
      onShowExportModal: () => void;
      showExport?: boolean;
    }) => (
      <div>
        <button data-testid="hdr-complete" onClick={() => props.onComplete?.()} />
        {props.showExport && (
          <button data-testid="hdr-export" onClick={props.onShowExportModal} />
        )}
      </div>
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
    NeedsReviewScreen: () => <div data-testid="needs-review-screen" />,
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
  useAuth: () => ({ currentUser: { id: "user-2866", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-2866", email: "t@t.com" }),
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
  id: "txn-2866",
  user_id: "user-2866",
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

beforeEach(() => {
  exportMounts.length = 0;
  queueCount = 0;

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
  (window.api.transactions as any).isAutoSyncInFlight = jest
    .fn()
    .mockResolvedValue({ inFlight: false });
  // Read fresh every call — this is the REAL gate's input.
  (window.api.transactions as any).getReviewState = jest.fn().mockImplementation(async () => ({
    count: queueCount,
    items: Array.from({ length: queueCount }, (_, i) => ({
      id: `pending:${i}`,
      transaction_id: "txn-2866",
    })),
    threadCount: queueCount,
  }));
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

/** The gate's refusal, rendered. */
const blockDialog = () => screen.queryByTestId("review-prompt-blocked");

describe("ROUTE 2 — the brokerage header Export button consults the gate", () => {
  it("BLOCKS a non-empty queue: no export destination mounts, the P3 refusal shows", async () => {
    queueCount = 3;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-export")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("hdr-export"));

    // The block FIRED — the user is shown the refusal, not a silent no-op.
    await waitFor(() => expect(blockDialog()).toBeInTheDocument());
    expect(blockDialog()).toHaveTextContent(
      "You have 3 communications that need to be reviewed before completing the transaction.",
    );
    // And no export was ever started.
    expect(screen.queryByTestId("export-destination")).not.toBeInTheDocument();
    expect(exportMounts).toHaveLength(0);
  });

  it("PROCEEDS on an empty queue — still a gate, not a wall", async () => {
    queueCount = 0;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-export")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("hdr-export"));

    await waitFor(() =>
      expect(screen.getByTestId("export-destination")).toBeInTheDocument(),
    );
    expect(exportMounts[exportMounts.length - 1]).toEqual({
      transactionId: "txn-2866",
      userId: "user-2866",
    });
    expect(blockDialog()).not.toBeInTheDocument();
  });

  it("re-reads AT CLICK TIME: a queue that fills after mount blocks the next click", async () => {
    // The founder's own mechanism, applied to the export button. A gate reading
    // a render-stale prop would open the export modal here.
    queueCount = 0;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-export")).toBeInTheDocument());

    // A background sync queues two items while the screen sits open.
    queueCount = 2;
    fireEvent.click(screen.getByTestId("hdr-export"));

    await waitFor(() => expect(blockDialog()).toBeInTheDocument());
    expect(screen.queryByTestId("export-destination")).not.toBeInTheDocument();
  });

  it("the refusal's Review action opens Needs Review — the only affirmative way out", async () => {
    queueCount = 1;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-export")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("hdr-export"));
    await waitFor(() => expect(blockDialog()).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /review/i }));

    await waitFor(() =>
      expect(screen.getByTestId("needs-review-screen")).toBeInTheDocument(),
    );
    // There is NO bypass: still no export.
    expect(exportMounts).toHaveLength(0);
  });
});

describe("ROUTE 3 — the submit modal's Export offer re-consults the gate", () => {
  it("BLOCKS when the queue filled while the submit modal sat open", async () => {
    queueCount = 0;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());

    // Complete passes the gate and opens the submit confirmation.
    fireEvent.click(screen.getByTestId("hdr-complete"));
    await waitFor(() => expect(screen.getByTestId("submit-modal")).toBeInTheDocument());

    // A background sync queues items while it is open.
    queueCount = 4;
    fireEvent.click(screen.getByTestId("modal-export"));

    await waitFor(() => expect(blockDialog()).toBeInTheDocument());
    expect(screen.queryByTestId("export-destination")).not.toBeInTheDocument();
    expect(exportMounts).toHaveLength(0);
  });

  it("PROCEEDS when the queue is still empty", async () => {
    queueCount = 0;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("hdr-complete"));
    await waitFor(() => expect(screen.getByTestId("submit-modal")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("modal-export"));

    await waitFor(() =>
      expect(screen.getByTestId("export-destination")).toBeInTheDocument(),
    );
    expect(exportMounts).toHaveLength(1);
  });
});

describe("ROUTE 1 — Complete is still gated, by the same read", () => {
  it("blocks Complete on a non-empty queue, reaching neither submit nor export", async () => {
    queueCount = 2;
    renderDetails();
    await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("hdr-complete"));

    await waitFor(() => expect(blockDialog()).toBeInTheDocument());
    expect(screen.queryByTestId("submit-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("export-destination")).not.toBeInTheDocument();
  });
});
