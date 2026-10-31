/**
 * BACKLOG-3965 PR-4a: open a deal on a named tab through AppModals.
 *
 * Renders the REAL AppModals and the real openTransactionRequest store. The
 * TransactionList mock exposes the two props AppModals hands it (id + tab) and
 * a close button that calls AppModals' onClose. Contacts is mocked to a button
 * that calls AppModals' onOpenTransaction (the Contacts-card path).
 *
 * "Dashboard open" stands in for the PR-4b caller: write the request, then open
 * the Transactions view — the two calls a Todo row will make.
 */
import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppModals } from "../AppModals";
import { NotificationProvider } from "../../contexts/NotificationContext";
import type { AppStateMachine } from "../state/types";
import {
  clearOpenTransactionRequest,
  getOpenTransactionRequest,
  makeOpenTransactionAt,
  requestOpenTransaction,
  subscribeTransactionsViewClosed,
} from "../openTransactionRequest";

jest.mock("../../components/TransactionList", () => {
  const MockTransactionList = ({
    initialTransactionId,
    initialTransactionTab,
    onClose,
  }: {
    initialTransactionId?: string | null;
    initialTransactionTab?: string;
    onClose: () => void;
  }) => (
    <div
      data-testid="transactions-modal"
      data-initial-id={initialTransactionId ?? ""}
      data-initial-tab={initialTransactionTab ?? ""}
    >
      <button data-testid="transactions-close" onClick={onClose}>
        close
      </button>
    </div>
  );
  return { __esModule: true, default: MockTransactionList };
});
jest.mock("../../components/Contacts", () => ({
  __esModule: true,
  default: ({ onOpenTransaction }: { onOpenTransaction: (id: string) => void }) => (
    <button data-testid="contact-open-txn" onClick={() => onOpenTransaction("txn-contact")}>
      open from contact
    </button>
  ),
}));
jest.mock("../../components/WelcomeTerms", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/AuditTransactionModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/MoveAppPrompt", () => ({ __esModule: true, default: () => null }));
jest.mock("../modals/IPhoneSyncModal", () => ({ IPhoneSyncModal: () => null }));
jest.mock("../modals/AndroidSyncModal", () => ({ AndroidSyncModal: () => null }));
jest.mock("../hooks/useSubmissionStatusNotice", () => ({ useSubmissionStatusNotice: () => undefined }));
jest.mock("../../hooks/useGoogleMessagesSyncStatus", () => ({ useGoogleMessagesSyncStatus: () => undefined }));
jest.mock("../../hooks/useExtensionFolderRefresh", () => ({ useExtensionFolderRefresh: () => undefined }));

function Host() {
  const [showTransactions, setShowTransactions] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const openTransactions = () => setShowTransactions(true);
  const app = {
    modalState: {
      showTransactions,
      showContacts,
      showAuditTransaction: false,
      showMoveAppPrompt: false,
      showTermsModal: false,
      showIPhoneSync: false,
      showAndroidSync: false,
    },
    currentUser: { id: "user-1", email: "a@example.com" },
    authProvider: "google",
    isDatabaseInitialized: true,
    pendingOAuthData: null,
    needsTermsAcceptance: false,
    appPath: "/Applications/Keepr.app",
    closeTransactions: () => setShowTransactions(false),
    closeContacts: () => setShowContacts(false),
    closeAuditTransaction: jest.fn(),
    openSettings: jest.fn(),
    openTransactions,
    handleAcceptTerms: jest.fn(),
    handleDeclineTerms: jest.fn(),
    handleDismissMovePrompt: jest.fn(),
    handleNotNowMovePrompt: jest.fn(),
    closeIPhoneSync: jest.fn(),
    closeAndroidSync: jest.fn(),
  } as unknown as AppStateMachine;
  return (
    <>
      <button
        data-testid="dashboard-open-checklist"
        // BACKLOG-3965 PR-4b: the real helper AppRouter passes to Dashboard.
        onClick={() => makeOpenTransactionAt(openTransactions)("txn-todo", "checklist")}
      >
        todo row
      </button>
      <button data-testid="show-contacts" onClick={() => setShowContacts(true)}>
        contacts
      </button>
      <AppModals app={app} />
    </>
  );
}

function renderHost() {
  return render(
    <NotificationProvider>
      <Host />
    </NotificationProvider>,
  );
}

const modal = () => screen.getByTestId("transactions-modal");

beforeEach(() => {
  act(() => clearOpenTransactionRequest());
});

describe("BACKLOG-3965 open a deal on a named tab (host: AppModals)", () => {
  it("a Dashboard request opens the deal on the Checklist tab", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("dashboard-open-checklist"));
    expect(modal()).toHaveAttribute("data-initial-id", "txn-todo");
    expect(modal()).toHaveAttribute("data-initial-tab", "checklist");
  });

  it("the Contacts card still opens on the overview tab", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("show-contacts"));
    fireEvent.click(screen.getByTestId("contact-open-txn"));
    expect(modal()).toHaveAttribute("data-initial-id", "txn-contact");
    expect(modal()).toHaveAttribute("data-initial-tab", "overview");
  });

  it("closing the Transactions view clears the request", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("dashboard-open-checklist"));
    fireEvent.click(screen.getByTestId("transactions-close"));
    expect(screen.queryByTestId("transactions-modal")).not.toBeInTheDocument();
    expect(getOpenTransactionRequest()).toBeNull();
  });

  it("closing the Transactions view tells the Dashboard panels to read again (PR-4b)", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeTransactionsViewClosed(listener);
    renderHost();
    fireEvent.click(screen.getByTestId("dashboard-open-checklist"));
    expect(listener).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("transactions-close"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a checklist request does not carry over to the next Contacts-card open", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("dashboard-open-checklist"));
    expect(modal()).toHaveAttribute("data-initial-tab", "checklist");
    fireEvent.click(screen.getByTestId("transactions-close"));

    fireEvent.click(screen.getByTestId("show-contacts"));
    fireEvent.click(screen.getByTestId("contact-open-txn"));
    expect(modal()).toHaveAttribute("data-initial-id", "txn-contact");
    expect(modal()).toHaveAttribute("data-initial-tab", "overview");
  });

  it("a request written while the view is open still reaches TransactionList without a remount", () => {
    renderHost();
    fireEvent.click(screen.getByTestId("dashboard-open-checklist"));
    act(() => requestOpenTransaction("txn-2", "emails"));
    expect(modal()).toHaveAttribute("data-initial-id", "txn-2");
    expect(modal()).toHaveAttribute("data-initial-tab", "emails");
  });
});
