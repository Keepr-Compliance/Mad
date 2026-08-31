/**
 * BACKLOG-2880 — what the Sync button TELLS the user once it stops linking.
 *
 * Founder ruling, 2026-08-26:
 *   "maybe say 'sync completed'. the needs review popup anyway shows up on
 *    adding contact or changing range which triggers a sync"
 *
 * Neutral toast, popup carries the count. His premise did not hold on THIS path
 * — the Sync button never broadcast on the review channel, so the popup was
 * silent here — which `emailSyncHandlers.reviewAnnounce-2880` fixes and pins at
 * the emitting end.
 *
 * THE FAILURE BEING PREVENTED. Once the button queues instead of linking, the
 * founder's exact case (mailbox cached, 9 queued, 0 linked) fell through
 * `TransactionDetails.tsx:998-1006` to "Checked 63 emails - all already in
 * database" or "No new communications found" — telling him nothing happened,
 * moments after nine emails landed in his review queue. That is the
 * "0 linked successfully" shape that was SR blocker 6 on BACKLOG-2791.
 *
 * WHERE THE BROADCAST IN THESE TESTS COMES FROM. The renderer half of the chain
 * (event -> lastAdded/lastLinked -> lastFound -> popup gate) is already pinned by
 * `reviewLiveRefresh-2791`. The EMITTING half is pinned by
 * `emailSyncHandlers.reviewAnnounce-2880`, which asserts the handler calls
 * `notifyReviewDiscovery(txnId, { added, linked })` with the run's own counts.
 * The mocked sync below delivers exactly that payload, so this suite tests the
 * seam between two pinned halves rather than inventing a message shape.
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";

type QueueChangedHandler = (data: {
  transactionId: string;
  added: number;
  linked: number;
  outstanding: number;
  reason: string;
}) => void;

let queueSubscriber: QueueChangedHandler | null = null;

const mockLicense = {
  value: {
    licenseType: "team" as string,
    hasAIAddon: false,
    organizationId: "org-2880" as string | null,
    canExport: false,
    canSubmit: true,
    canAutoDetect: false,
    isLoading: false,
    isLicenseResolved: true,
    refresh: jest.fn(),
  },
};

jest.mock("../ExportModal", () => ({ __esModule: true, default: () => null }));

jest.mock("../transactionDetailsModule", () => {
  const actual = jest.requireActual<typeof import("../transactionDetailsModule")>(
    "../transactionDetailsModule",
  );
  return {
    ...actual,
    // ReviewPromptDialog is deliberately NOT stubbed — whether it MOUNTS is
    // half of what this suite measures.
    TransactionHeader: () => null,
    TransactionEmailsTab: (props: { onSyncCommunications?: () => void }) => (
      <button data-testid="sync-emails" onClick={() => props.onSyncCommunications?.()} />
    ),
    TransactionMessagesTab: () => null,
    TransactionAttachmentsTab: () => null,
    // The overview tab is the default mount and carries the SAME
    // `onSyncCommunications` handler (TransactionDetails.tsx:1161) as the Emails
    // tab (:1201). Driving it here means the suite exercises the shipped default
    // surface rather than a tab it had to navigate to first.
    TransactionDetailsTab: (props: { onSyncCommunications?: () => void }) => (
      <button data-testid="sync-emails" onClick={() => props.onSyncCommunications?.()} />
    ),
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
  SubmitForReviewModal: () => null,
}));
jest.mock("../transactionDetailsModule/components/ReviewNotesPanel", () => ({
  ReviewNotesPanel: () => null,
}));
jest.mock("../../contexts/LicenseContext", () => ({ useLicense: () => mockLicense.value }));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-2880", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-2880", email: "t@t.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../../contexts/NetworkContext", () => ({ useNetwork: () => ({ isOnline: true }) }));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../common/ResponsiveModal", () => ({
  ResponsiveModal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MODAL_PANEL: { lg: "" },
}));
jest.mock("../common/OfflineNotice", () => ({ OfflineNotice: () => null }));

import TransactionDetails from "../TransactionDetails";

const TXN = "txn-2880";

const baseTransaction = {
  id: TXN,
  user_id: "user-2880",
  property_address: "884 Dale Dr SE",
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

interface SyncResult {
  success: boolean;
  emailsFetched?: number;
  emailsStored?: number;
  totalEmailsLinked?: number;
  totalMessagesLinked?: number;
  totalAlreadyLinked?: number;
  totalQueuedForReview?: number;
}

/**
 * Stand in for the main process: run the sync, then announce it on the review
 * channel exactly as `emailSyncHandlers` does (payload shape pinned by
 * `emailSyncHandlers.reviewAnnounce-2880`).
 */
function armSync(result: SyncResult): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).syncAndFetchEmails = jest.fn().mockImplementation(async () => {
    if (result.success) {
      queueSubscriber?.({
        transactionId: TXN,
        added: result.totalQueuedForReview ?? 0,
        linked: result.totalEmailsLinked ?? 0,
        outstanding: result.totalQueuedForReview ?? 0,
        reason: "background",
      });
    }
    return result;
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

beforeEach(() => {
  queueSubscriber = null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  window.api.transactions.getDetails = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  });
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
  (window.api.transactions as any).getReviewState = jest
    .fn()
    .mockResolvedValue({ count: 0, items: [] });
  (window.api.transactions as any).syncReviewQueue = jest
    .fn()
    .mockResolvedValue({ success: true, added: 0, linked: 0, found: 0 });
  (window.api.transactions as any).onReviewQueueChanged = jest
    .fn()
    .mockImplementation((cb: QueueChangedHandler) => {
      queueSubscriber = cb;
      return () => {
        queueSubscriber = null;
      };
    });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  window.api.contacts.getAll = jest.fn().mockResolvedValue({ success: true, contacts: [] });
});

const renderDetails = () =>
  render(<TransactionDetails transaction={baseTransaction as never} onClose={jest.fn()} />, {
    wrapper: NotificationProvider,
  });

const clickSync = async () => {
  renderDetails();
  await waitFor(() => expect(screen.getByTestId("sync-emails")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("sync-emails"));
};

describe("BACKLOG-2880 — the Sync toast after the button stopped linking", () => {
  it("THE FOUNDER'S CASE — 9 queued, 0 linked: says 'Sync completed', never that nothing happened", async () => {
    armSync({
      success: true,
      emailsFetched: 63,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 9,
    });

    await clickSync();

    expect(await screen.findByText("Sync completed")).toBeInTheDocument();
    // The two lies this replaces, asserted by their literal text.
    expect(screen.queryByText("No new communications found")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Checked 63 emails - all already in database"),
    ).not.toBeInTheDocument();
  });

  it("THE FOUNDER'S CASE — the Needs Review popup carries the count, as his ruling assumes", async () => {
    armSync({
      success: true,
      emailsFetched: 63,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 9,
    });

    await clickSync();

    const dialog = await screen.findByTestId("review-prompt-found");
    expect(dialog).toHaveTextContent("9");
  });

  it("a Sync that found NOTHING raises no popup — the gate still gates", async () => {
    // Without this, the popup block above could be satisfied by a dialog that
    // renders unconditionally, and mutating the `lastFound > 0` gate would go
    // unnoticed.
    armSync({
      success: true,
      emailsFetched: 0,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 0,
    });

    await clickSync();

    await screen.findByText("No new communications found");
    expect(screen.queryByTestId("review-prompt-found")).not.toBeInTheDocument();
  });

  it("a run that genuinely fetched and linked keeps its ACCURATE toast", async () => {
    // The neutral message must not swallow the informative ones. Without this,
    // "always say Sync completed" would satisfy the case above.
    armSync({
      success: true,
      emailsFetched: 3,
      emailsStored: 3,
      totalEmailsLinked: 2,
      totalMessagesLinked: 0,
      totalQueuedForReview: 0,
    });

    await clickSync();

    expect(await screen.findByText("3 new emails fetched, 2 emails linked")).toBeInTheDocument();
    expect(screen.queryByText("Sync completed")).not.toBeInTheDocument();
  });

  it("a run that found NOTHING still says so — 'Sync completed' is not a blanket", async () => {
    // The negative that gives the founder's case its meaning: the neutral
    // message is reserved for a run that DID something unlinked, not for every
    // run. Nothing fetched, nothing linked, nothing queued.
    armSync({
      success: true,
      emailsFetched: 0,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 0,
    });

    await clickSync();

    expect(await screen.findByText("No new communications found")).toBeInTheDocument();
    expect(screen.queryByText("Sync completed")).not.toBeInTheDocument();
  });

  it("nothing queued and nothing new, but mail was already there — the existing message stands", async () => {
    armSync({
      success: true,
      emailsFetched: 63,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 0,
    });

    await clickSync();

    expect(
      await screen.findByText("Checked 63 emails - all already in database"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sync completed")).not.toBeInTheDocument();
  });
});
