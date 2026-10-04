/**
 * BACKLOG-3594: the agent is told when a submission comes back.
 *
 * Renders the REAL AppModals (the host App.tsx mounts on every licensed
 * screen) inside the real NotificationProvider, so removing the hook call from
 * AppModals turns these red — the defect was a subscriber whose host nothing
 * rendered.
 *
 * Payload fixture transcribed from the producer,
 * electron/services/submissionSyncService.ts `emitStatusChange` (title from
 * `getNotificationTitle`, message from `getNotificationMessage`), sent on
 * `submission-status-changed` and typed by the preload bridge
 * (electron/preload/transactionBridge.ts `onSubmissionStatusChanged`).
 */

import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppModals } from "../AppModals";
import { NotificationProvider } from "../../contexts/NotificationContext";
import type { AppStateMachine } from "../state/types";
import type { SubmissionStatusChangedEvent } from "../hooks/useSubmissionStatusNotice";

jest.mock("../../components/TransactionList", () => {
  const MockTransactionList = ({ initialTransactionId }: { initialTransactionId?: string | null }) => (
    <div data-testid="transactions-modal" data-initial-id={initialTransactionId ?? ""} />
  );
  return { __esModule: true, default: MockTransactionList };
});
jest.mock("../../components/Profile", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/Settings", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/Contacts", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/WelcomeTerms", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/AuditTransactionModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/MoveAppPrompt", () => ({ __esModule: true, default: () => null }));
jest.mock("../modals/IPhoneSyncModal", () => ({ IPhoneSyncModal: () => null }));
jest.mock("../modals/AndroidSyncModal", () => ({ AndroidSyncModal: () => null }));
jest.mock("../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));

// ---- producer-shaped payloads ----------------------------------------------
function statusEvent(
  newStatus: string,
  overrides: Partial<SubmissionStatusChangedEvent> = {},
): SubmissionStatusChangedEvent {
  const propertyAddress = overrides.propertyAddress ?? "123 Main St";
  const reviewNotes = "Please add the signed addendum.";
  const titles: Record<string, string> = {
    under_review: "Submission Under Review",
    needs_changes: "Changes Requested",
    approved: "Submission Approved!",
    rejected: "Submission Rejected",
    submitted: "Submission Received",
    resubmitted: "Resubmission Received",
  };
  const messages: Record<string, string> = {
    under_review: `${propertyAddress} is now being reviewed by your broker.`,
    needs_changes: `${propertyAddress}: ${reviewNotes}`,
    approved: `${propertyAddress} has been approved by your broker.`,
    rejected: `${propertyAddress}: ${reviewNotes}`,
  };
  return {
    transactionId: "txn-1",
    propertyAddress,
    oldStatus: "submitted",
    newStatus,
    reviewNotes,
    title: titles[newStatus] ?? "Submission Status Updated",
    message: messages[newStatus] ?? `${propertyAddress} status has been updated.`,
    ...overrides,
  };
}

// ---- fan-out bridge mock: unsubscribe removes only its own callback --------
type Listener = (data: SubmissionStatusChangedEvent) => void;
let listeners: Set<Listener>;
const transactionsApi = (window as unknown as {
  api: { transactions: { onSubmissionStatusChanged: unknown } };
}).api.transactions;
const originalSubscribe = transactionsApi.onSubmissionStatusChanged;

function emit(data: SubmissionStatusChangedEvent) {
  act(() => {
    Array.from(listeners).forEach((cb) => cb(data));
  });
}

// ---- host harness ------------------------------------------------------------
const closeContacts = jest.fn();
const openTransactionsSpy = jest.fn();

function Host() {
  const [showTransactions, setShowTransactions] = useState(false);
  const app = {
    modalState: {
      showProfile: false,
      showSettings: false,
      showTransactions,
      showContacts: false,
      showAuditTransaction: false,
      showVersion: false,
      showMoveAppPrompt: false,
      showTermsModal: false,
      showIPhoneSync: false,
      showAndroidSync: false,
    },
    currentUser: { id: "user-1", email: "a@example.com" },
    authProvider: "google",
    subscription: undefined,
    isDatabaseInitialized: true,
    pendingOAuthData: null,
    needsTermsAcceptance: false,
    appPath: "/Applications/Keepr.app",
    closeProfile: jest.fn(),
    closeSettings: jest.fn(),
    closeTransactions: () => setShowTransactions(false),
    closeContacts,
    closeAuditTransaction: jest.fn(),
    openSettings: jest.fn(),
    openTransactions: () => {
      openTransactionsSpy();
      setShowTransactions(true);
    },
    openAndroidSync: jest.fn(),
    handleLogout: jest.fn(),
    handleAcceptTerms: jest.fn(),
    handleDeclineTerms: jest.fn(),
    handleDismissMovePrompt: jest.fn(),
    handleNotNowMovePrompt: jest.fn(),
    closeIPhoneSync: jest.fn(),
    closeAndroidSync: jest.fn(),
  } as unknown as AppStateMachine;
  return <AppModals app={app} />;
}

function renderHost(strict = false) {
  const tree = (
    <NotificationProvider>
      <Host />
    </NotificationProvider>
  );
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
}

const notices = () => screen.queryAllByRole("alert");

beforeEach(() => {
  jest.clearAllMocks();
  listeners = new Set();
  transactionsApi.onSubmissionStatusChanged = jest.fn((cb: Listener) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  });
});

afterAll(() => {
  transactionsApi.onSubmissionStatusChanged = originalSubscribe;
});

describe("BACKLOG-3594 submission came back notice (host: AppModals)", () => {
  it("subscribes on mount, with no Transactions view open", () => {
    renderHost();
    expect(listeners.size).toBe(1);
    expect(screen.queryByTestId("transactions-modal")).not.toBeInTheDocument();
  });

  it("shows one notice naming the transaction when the broker requests changes", () => {
    renderHost();
    emit(statusEvent("needs_changes"));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toHaveTextContent("Your broker requested changes on 123 Main St");
    expect(screen.getByTestId("notification-action")).toHaveTextContent("Open");
  });

  it("says rejected and approved in their own words", () => {
    renderHost();
    emit(statusEvent("rejected", { transactionId: "txn-r", propertyAddress: "9 Oak Ave" }));
    emit(statusEvent("approved", { transactionId: "txn-a", propertyAddress: "77 Elm Rd" }));
    const texts = notices().map((n) => n.textContent);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Your broker rejected 9 Oak Ave");
    expect(texts[1]).toContain("Your broker approved 77 Elm Rd");
  });

  it("stays up (persistent) instead of auto-dismissing after 5 s", () => {
    jest.useFakeTimers();
    try {
      renderHost();
      emit(statusEvent("needs_changes"));
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(notices()).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("raises nothing for statuses that are not the submission coming back", () => {
    renderHost();
    emit(statusEvent("under_review", { transactionId: "t1" }));
    emit(statusEvent("submitted", { transactionId: "t2" }));
    emit(statusEvent("resubmitted", { transactionId: "t3" }));
    expect(notices()).toHaveLength(0);
  });

  it("does not repeat the notice when the same change arrives twice", () => {
    renderHost();
    emit(statusEvent("needs_changes"));
    emit(statusEvent("needs_changes"));
    expect(notices()).toHaveLength(1);
  });

  it("notices a later, different change on the same transaction", () => {
    renderHost();
    emit(statusEvent("needs_changes"));
    emit(statusEvent("resubmitted", { oldStatus: "needs_changes" }));
    emit(statusEvent("needs_changes", { oldStatus: "resubmitted" }));
    expect(notices()).toHaveLength(2);
  });

  it("keeps exactly one subscription across StrictMode and re-renders", () => {
    const { rerender } = renderHost(true);
    for (let i = 0; i < 3; i++) {
      rerender(
        <React.StrictMode>
          <NotificationProvider>
            <Host />
          </NotificationProvider>
        </React.StrictMode>,
      );
    }
    expect(listeners.size).toBe(1);
    emit(statusEvent("needs_changes"));
    expect(notices()).toHaveLength(1);
  });

  it("keeps one subscription when the host re-renders itself (Transactions view opened)", () => {
    renderHost();
    emit(statusEvent("needs_changes"));
    fireEvent.click(screen.getByTestId("notification-action"));
    expect(listeners.size).toBe(1);
  });

  it("Open opens that transaction in the Transactions view and closes the notice", () => {
    renderHost();
    emit(statusEvent("needs_changes", { transactionId: "txn-42" }));
    fireEvent.click(screen.getByTestId("notification-action"));
    expect(closeContacts).toHaveBeenCalledTimes(1);
    expect(openTransactionsSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("transactions-modal")).toHaveAttribute("data-initial-id", "txn-42");
    expect(notices()).toHaveLength(0);
  });

  it("releases the subscription on unmount", () => {
    const { unmount } = renderHost();
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
