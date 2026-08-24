/**
 * BACKLOG-2838 — the transaction card's counters went stale and only an app
 * restart fixed them.
 *
 * Founder, 2026-08-23: "closing keepr and reopening it fixed the count."
 *
 * THE DEFECT. `useTransactionList` fetched the rows once per mount, and the
 * details screen is a MODAL rendered by the list — so the list never unmounts
 * while the user approves, links or unlinks inside a deal, and the array it
 * renders from was never re-read. `email_count` and `text_thread_count` ride in
 * on those rows, so the card kept showing whatever was true at app start. The
 * number matched neither the emails nor the threads on the details screen
 * because it was a count of an earlier state, which matches nothing current.
 *
 * WHAT THESE TESTS PIN, and why they are shaped this way. A mount-time
 * assertion — render with 5, see 5 — is exactly what let this ship: it passes
 * identically with and without a subscription. So every test here renders ONCE
 * and asserts that the SAME DOM NODE's text changes. Node identity is the proof
 * of "without a remount": React updates the text of an existing node in place,
 * whereas a remount would replace the node object, and `toBe` separates those
 * two cases where a text assertion alone cannot.
 *
 * Controls run against these (see the PR body): removing either subscription
 * from useTransactionList reds the matching test, and they red independently.
 *
 * WHY THIS SUITE DRIVES TransactionList AND NOT Transactions. The fix lives in
 * the shared `useTransactionList` hook, so either screen would exercise it
 * today — but `Transactions.tsx` has no import anywhere outside tests, and
 * `TransactionList` is the screen the founder actually reaches
 * (`appCore/AppModals.tsx:131`). Pinning the fix through the dead screen would
 * repeat the exact mistake this PR reports: a defect guarded by code no user
 * runs. It would also stay green if TransactionList ever stopped using the
 * hook, which is the one regression this suite exists to catch. Retargeted
 * rather than duplicated — the hook is shared, so a second suite on the dead
 * screen would add maintenance and no signal.
 */

import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionList from "../TransactionList";
import type { Transaction } from "../../../electron/types/models";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

jest.mock("../../contexts/NetworkContext", () => ({
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

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 100,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

// TASK-2159: LicenseGate reads through useFeatureGate; the existing
// TransactionList suites mock it via the "@/" alias, matched here.
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------

type ReviewQueueChanged = {
  transactionId: string;
  added: number;
  linked: number;
  outstanding: number;
  reason: "open" | "background" | "contact-change";
};
type AutoSyncComplete = { transactionId: string; reason: string; ran: boolean };

const USER_ID = "user-2838";

/**
 * One deal only. The counters render as BARE NUMBERS beside an icon, so a
 * second row would make "which 5 is this" ambiguous; the test ids added in
 * TransactionMobileCard resolve the counter, and a single row resolves the deal.
 */
const rowWith = (emailCount: number, textThreadCount: number): Transaction[] =>
  [
    {
      id: "txn-2838",
      user_id: USER_ID,
      property_address: "18 Bellweather Lane",
      transaction_type: "purchase",
      status: "active",
      detection_status: "confirmed",
      sale_price: 615000,
      closed_at: null,
      email_count: emailCount,
      text_thread_count: textThreadCount,
      extraction_confidence: 91,
      // Cast: a deliberately partial row carrying only what the list renders.
      // Filling in the rest would change the data the component receives.
    },
  ] as unknown as Transaction[];

describe("BACKLOG-2838: the card's counters refresh in place", () => {
  let reviewCallback: ((data: ReviewQueueChanged) => void) | null;
  let autoSyncCallback: ((data: AutoSyncComplete) => void) | null;
  let unsubscribeReview: jest.Mock;
  let unsubscribeAutoSync: jest.Mock;

  const api = () =>
    window.api as unknown as {
      transactions: Record<string, jest.Mock>;
      onTransactionAutoSyncComplete: jest.Mock;
    };

  beforeEach(() => {
    jest.clearAllMocks();
    reviewCallback = null;
    autoSyncCallback = null;
    unsubscribeReview = jest.fn();
    unsubscribeAutoSync = jest.fn();

    // `onReviewQueueChanged` is not part of the shared window.api mock, so it is
    // defined here rather than in tests/setup.js — no other suite's behaviour
    // changes as a result.
    api().transactions.onReviewQueueChanged = jest.fn(
      (cb: (data: ReviewQueueChanged) => void) => {
        reviewCallback = cb;
        return unsubscribeReview;
      },
    );
    api().onTransactionAutoSyncComplete.mockImplementation(
      (cb: (data: AutoSyncComplete) => void) => {
        autoSyncCallback = cb;
        return unsubscribeAutoSync;
      },
    );
    jest.mocked(window.api.onTransactionScanProgress).mockReturnValue(jest.fn());
  });

  const renderList = () =>
    render(
      <TransactionList userId={USER_ID} provider="google" onClose={jest.fn()} />,
    );

  /** Renders with 3 emails / 7 text threads, then serves 5 / 9 on every reread. */
  const serveThenChange = (): void => {
    api()
      .transactions.getAll.mockResolvedValueOnce({
        success: true,
        transactions: rowWith(3, 7),
      })
      .mockResolvedValue({ success: true, transactions: rowWith(5, 9) });
  };

  it("a review-queue change updates the SAME card node — approve/reject/restore/sweep", async () => {
    serveThenChange();
    renderList();

    await waitFor(() => {
      expect(screen.getByText("18 Bellweather Lane")).toBeInTheDocument();
    });

    // Capture the exact nodes rendered at mount. Both must survive the update.
    const emailNode = screen.getByTestId("tx-card-email-count");
    const textNode = screen.getByTestId("tx-card-text-count");
    expect(emailNode).toHaveTextContent("3");
    expect(textNode).toHaveTextContent("7");
    expect(api().transactions.getAll).toHaveBeenCalledTimes(1);

    expect(reviewCallback).not.toBeNull();
    await act(async () => {
      reviewCallback?.({
        transactionId: "txn-2838",
        added: 0,
        linked: 0,
        outstanding: 0,
        reason: "background",
      });
    });

    await waitFor(() => expect(emailNode).toHaveTextContent("5"));
    expect(textNode).toHaveTextContent("9");

    // THE no-remount claim, asserted rather than assumed: the nodes the card is
    // rendering now are the same objects captured before the update. A remount
    // would have replaced them, and the text assertions above would not notice.
    expect(screen.getByTestId("tx-card-email-count")).toBe(emailNode);
    expect(screen.getByTestId("tx-card-text-count")).toBe(textNode);

    expect(api().transactions.getAll).toHaveBeenCalledTimes(2);
  });

  it("a completed auto-sync updates the same card node; a skipped one does not refetch", async () => {
    serveThenChange();
    renderList();

    await waitFor(() => {
      expect(screen.getByText("18 Bellweather Lane")).toBeInTheDocument();
    });
    const emailNode = screen.getByTestId("tx-card-email-count");
    expect(emailNode).toHaveTextContent("3");

    // ran:false — throttled or skipped, nothing was fetched, so nothing the card
    // counts can have changed. It must NOT cost a query.
    await act(async () => {
      autoSyncCallback?.({ transactionId: "txn-2838", reason: "open", ran: false });
    });
    expect(api().transactions.getAll).toHaveBeenCalledTimes(1);
    expect(emailNode).toHaveTextContent("3");

    await act(async () => {
      autoSyncCallback?.({ transactionId: "txn-2838", reason: "open", ran: true });
    });

    await waitFor(() => expect(emailNode).toHaveTextContent("5"));
    expect(screen.getByTestId("tx-card-email-count")).toBe(emailNode);
    expect(api().transactions.getAll).toHaveBeenCalledTimes(2);
  });

  it("refreshes for a deal other than the one that changed", async () => {
    // The list renders EVERY deal, and a sweep or an auto-sync fires for one
    // transaction at a time — including deals the user is not looking at. A
    // transactionId filter here would leave every other card stale, so there
    // deliberately is none.
    serveThenChange();
    renderList();
    await waitFor(() => {
      expect(screen.getByText("18 Bellweather Lane")).toBeInTheDocument();
    });
    const emailNode = screen.getByTestId("tx-card-email-count");

    await act(async () => {
      reviewCallback?.({
        transactionId: "some-other-deal",
        added: 0,
        linked: 0,
        outstanding: 2,
        reason: "background",
      });
    });

    await waitFor(() => expect(emailNode).toHaveTextContent("5"));
  });

  it("the background refresh never shows a spinner and never blanks the list", async () => {
    api()
      .transactions.getAll.mockResolvedValueOnce({
        success: true,
        transactions: rowWith(3, 7),
      })
      .mockRejectedValue(new Error("db locked"));
    renderList();

    await waitFor(() => {
      expect(screen.getByText("18 Bellweather Lane")).toBeInTheDocument();
    });
    const emailNode = screen.getByTestId("tx-card-email-count");

    await act(async () => {
      reviewCallback?.({
        transactionId: "txn-2838",
        added: 0,
        linked: 0,
        outstanding: 0,
        reason: "background",
      });
    });

    // The reread was ATTEMPTED and threw — asserted, because without this the
    // test passes just as well with no subscription at all (nothing changes
    // either way), and a green that cannot tell those apart proves nothing.
    await waitFor(() => expect(api().transactions.getAll).toHaveBeenCalledTimes(2));

    // A failed background reread leaves the rows the user is looking at exactly
    // as they were: no spinner over a valid list, no error banner, no blanking.
    expect(screen.queryByText(/loading transactions/i)).not.toBeInTheDocument();
    expect(screen.getByText("18 Bellweather Lane")).toBeInTheDocument();
    expect(emailNode).toHaveTextContent("3");
  });

  it("subscribes to both signals on mount and releases both on unmount", async () => {
    serveThenChange();
    const { unmount } = renderList();

    await waitFor(() => {
      expect(screen.getByText("18 Bellweather Lane")).toBeInTheDocument();
    });
    expect(api().transactions.onReviewQueueChanged).toHaveBeenCalled();
    expect(api().onTransactionAutoSyncComplete).toHaveBeenCalled();

    unmount();
    expect(unsubscribeReview).toHaveBeenCalled();
    expect(unsubscribeAutoSync).toHaveBeenCalled();
  });
});
