import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from "react";
import Joyride from "react-joyride";
import { useTour } from "../hooks/useTour";
import { usePendingTransactionCount } from "../hooks/usePendingTransactionCount";
import { useSyncOrchestrator } from "../hooks/useSyncOrchestrator";
import { SyncStatusIndicator } from "./dashboard/index";
import { DashboardActionCard } from "./dashboard/DashboardActionCard";
import { DashboardSecondaryRow } from "./dashboard/DashboardSecondaryRow";
import { DashboardPanels } from "./dashboard/panels/DashboardPanels";
import type { TransactionTab } from "./transactionDetailsModule/types";
import StartNewAuditModal from "./StartNewAuditModal";
import { FeatureGate } from "./common/FeatureGate";
import { AlertBanner, AlertIcons } from "./common/AlertBanner";
import { TransactionLimitModal } from "./common/TransactionLimitModal";
import { TourTooltip, TourTooltipContext } from "./common/TourTooltip";
import { useLicense } from "../contexts/LicenseContext";
import { useFeatureGate } from "../hooks/useFeatureGate";
import {
  getDashboardTourSteps,
  JOYRIDE_STYLES,
  JOYRIDE_LOCALE,
} from "../config/tourSteps";
import type { Transaction } from "../types";
import { useReconnectionSummary } from "../hooks/useReconnectionSummary";
import AuthContext from "../contexts/AuthContext";
import billingService from "../services/billingService";

/** Tile icons (24px outline paths, unchanged from the inline tiles). */
function TileIcon({ d }: { d: string }) {
  return (
    <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}
const CheckCircleIcon = () => <TileIcon d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />;
const DocumentIcon = () => (
  <TileIcon d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
);
interface DashboardActionProps {
  onAuditNew: () => void;
  onViewTransactions: () => void;
  onManageContacts: () => void;
  onSyncPhone?: () => void; // Only available for Windows + iPhone users
  /** Opens the Android companion sync wizard. Only set when the user's import
   *  source is the Android companion (BACKLOG-2320). Mirrors onSyncPhone. */
  onSyncAndroid?: () => void;
  onTourStateChange?: (isActive: boolean) => void;
  showSetupPrompt?: boolean;
  onContinueSetup?: () => void;
  onDismissSetupPrompt?: () => void;
  /** Callback to trigger a manual sync refresh */
  onTriggerRefresh?: () => void;
  /** Callback when user selects a pending transaction to review */
  onSelectPendingTransaction?: (transaction: Transaction) => void;
  /** Callback to open Settings modal. Pass a scrollTarget to scroll to a specific section. */
  onOpenSettings?: (scrollTarget?: string) => void;
  /**
   * BACKLOG-3965 PR-4b: open a deal on a tab from a Recent or Todo row. The
   * ONE helper AppRouter builds (makeOpenTransactionAt): it writes the open
   * request and opens the Transactions view together.
   */
  onOpenTransaction?: (transactionId: string, tab: TransactionTab) => void;
  /** Current user info for personalized greeting (and the panels' reads) */
  user?: {
    id?: string;
    display_name?: string;
    email?: string;
  };
}

/**
 * Dashboard Component
 * Main landing screen after login
 * Provides three primary actions: Start New Audit, Browse Transactions, and Manage Contacts
 */
function Dashboard({
  onAuditNew,
  onViewTransactions,
  onManageContacts,
  onSyncPhone,
  onSyncAndroid,
  onTourStateChange,
  showSetupPrompt,
  onContinueSetup,
  onDismissSetupPrompt,
  onTriggerRefresh,
  onSelectPendingTransaction,
  onOpenSettings,
  onOpenTransaction,
  user,
}: DashboardActionProps) {
  // TASK-2058: Show reconnection summary when coming back online with failures
  useReconnectionSummary();

  // State for the Start New Audit modal
  const [showStartNewAuditModal, setShowStartNewAuditModal] = useState(false);
  // State for the transaction limit popup
  const [showLimitModal, setShowLimitModal] = useState(false);

  // Get sync state from SyncOrchestrator (single source of truth for sync status)
  const { isRunning: isAnySyncing } = useSyncOrchestrator();

  // Initialize the onboarding tour for first-time users.
  // BACKLOG-3673: never over the terms screen -- the tour sits above it. It
  // starts once the terms are accepted (AuthContext clears the flag).
  const needsTermsAcceptance = useContext(AuthContext)?.needsTermsAcceptance === true;
  const { runTour, handleJoyrideCallback, dontShowAgain, setDontShowAgain } = useTour(
    !needsTermsAcceptance,
    "hasSeenDashboardTour",
  );
  const tourTooltipContext = useMemo(
    () => ({ dontShowAgain, setDontShowAgain }),
    [dontShowAgain, setDontShowAgain],
  );

  // Fetch pending auto-detected transaction count
  const { pendingCount } =
    usePendingTransactionCount();

  // License status for transaction limit check and AI addon
  const { canCreateTransaction, transactionCount, transactionLimit } = useLicense();
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");

  // Check if notifications are already enabled (macOS only)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const isMacOS = typeof window !== "undefined" && window.api?.system?.platform === "darwin";

  useEffect(() => {
    if (isMacOS && window.api?.notification?.isSupported) {
      window.api.notification.isSupported().then((result) => {
        // If isSupported returns true, notifications are already enabled
        setNotificationsEnabled(result.supported);
      }).catch(() => {
        // On error, assume enabled to avoid showing the step
        setNotificationsEnabled(true);
      });
    }
  }, [isMacOS]);

  // Memoize tour steps to avoid recreating on every render
  const tourSteps = useMemo(
    () => getDashboardTourSteps({ hasAIAddon, isMacOS, notificationsEnabled, hasIPhoneSync: !!onSyncPhone, hasSyncVisible: isAnySyncing }),
    [hasAIAddon, isMacOS, notificationsEnabled, onSyncPhone, isAnySyncing],
  );

  // Derive display name for personalized greeting
  // Users only reach Dashboard after WelcomeTerms, so this is always a return visit
  const fullName = user?.display_name || user?.email?.split("@")[0] || "";
  const firstName = fullName.split(" ")[0];
  const greeting = firstName
    ? `Welcome back, ${firstName}!`
    : "Welcome back!";

  // Handle viewing pending transactions - navigates to transactions view
  const handleViewPending = useCallback(() => {
    onViewTransactions();
  }, [onViewTransactions]);

  // Handle "Start New Audit" click
  // For non-AI users: skip the StartNewAuditModal and go directly to manual creation
  // For AI users: show the modal with AI-detected transactions
  const handleStartNewAuditClick = useCallback(() => {
    // Check transaction limit first
    if (!canCreateTransaction) {
      setShowLimitModal(true);
      return;
    }
    if (!hasAIAddon) {
      // Non-AI users bypass the modal entirely
      onAuditNew();
      return;
    }
    setShowStartNewAuditModal(true);
  }, [hasAIAddon, canCreateTransaction, onAuditNew]);

  // Handle selecting a pending transaction from the modal
  const handleSelectPendingTransaction = useCallback(
    (transaction: Transaction) => {
      setShowStartNewAuditModal(false);
      // If parent provides a handler, use it; otherwise navigate to transactions
      if (onSelectPendingTransaction) {
        onSelectPendingTransaction(transaction);
      } else {
        onViewTransactions();
      }
    },
    [onSelectPendingTransaction, onViewTransactions]
  );

  // Handle "View Active Transactions" from the modal
  const handleViewActiveTransactions = useCallback(() => {
    setShowStartNewAuditModal(false);
    onViewTransactions();
  }, [onViewTransactions]);

  // Handle "Add Manually" from the modal
  const handleCreateManually = useCallback(() => {
    setShowStartNewAuditModal(false);
    onAuditNew();
  }, [onAuditNew]);

  // Handle closing the Start New Audit modal
  const handleCloseStartNewAuditModal = useCallback(() => {
    setShowStartNewAuditModal(false);
  }, []);

  // Track last reported tour state to prevent infinite loops
  const lastReportedTourStateRef = useRef<boolean | null>(null);

  // Notify parent component when tour state changes
  // Uses ref guard to prevent duplicate calls that cause infinite re-renders
  useEffect(() => {
    if (onTourStateChange && lastReportedTourStateRef.current !== runTour) {
      lastReportedTourStateRef.current = runTour;
      onTourStateChange(runTour);
    }
  }, [runTour, onTourStateChange]);

  return (
    <div className="min-h-full bg-gray-50 flex items-center justify-center p-4 sm:p-8">
      {/* Onboarding Tour */}
      {/* BACKLOG-3674: the tooltip carries the "Don't show this again" box. */}
      <TourTooltipContext.Provider value={tourTooltipContext}>
        <Joyride
          steps={tourSteps}
          run={runTour}
          continuous
          showProgress
          showSkipButton
          hideCloseButton
          callback={handleJoyrideCallback}
          styles={JOYRIDE_STYLES}
          locale={JOYRIDE_LOCALE}
          tooltipComponent={TourTooltip}
        />
      </TourTooltipContext.Provider>
      <div className="max-w-4xl w-full">
        {/* Continue Setup Banner */}
        {showSetupPrompt && onContinueSetup && (
          <AlertBanner
            icon={AlertIcons.email}
            title="Complete your account setup"
            description="Connect your email to export communications with your audits"
            actionText="Continue Setup"
            onAction={onContinueSetup}
            dismissible={!!onDismissSetupPrompt}
            onDismiss={onDismissSetupPrompt}
            testId="setup-prompt-banner"
          />
        )}

        {/* Transaction Limit Warning Banner */}
        {!canCreateTransaction && (
          <AlertBanner
            icon={AlertIcons.warning}
            title="Transaction Limit Reached"
            description={`You've used ${transactionCount} of ${transactionLimit} transactions. Upgrade to create more.`}
            actionText="Upgrade"
            onAction={() => void billingService.openPortal()}
            testId="transaction-limit-banner"
          />
        )}

        {/* Unified Sync Status - shows progress during sync, completion after */}
        {/* data-tour wrapper always renders so Joyride tour step has a target */}
        <div data-tour="sync-status">
          <SyncStatusIndicator
            pendingCount={pendingCount}
            onViewPending={handleViewPending}
            onOpenSettings={onOpenSettings}
            isTourActive={runTour}
            onViewSyncDetails={(type) => {
              if (type === 'iphone' && onSyncPhone) {
                onSyncPhone();
              }
              // BACKLOG-3658: reopen the Google Messages Sync window (live progress).
              if (type === 'google-messages' && onSyncAndroid) {
                onSyncAndroid();
              }
            }}
          />
        </div>

        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            {greeting}
          </h1>
        </div>

        {/* Action Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <DashboardActionCard
            title="New Transaction"
            titleClassName="whitespace-nowrap"
            onClick={handleStartNewAuditClick}
            disabled={isAnySyncing}
            icon={<CheckCircleIcon />}
            highlighted={pendingCount > 0}
            dataTour="new-audit-card"
            dataTestId="nav-new-audit"
          >
            {/* Pending count badge - AI add-on only */}
            <FeatureGate requires="ai_addon">
              {pendingCount > 0 && (
                <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800 animate-pulse">
                  {pendingCount} new
                </span>
              )}
            </FeatureGate>
          </DashboardActionCard>

          <DashboardActionCard
            title="All audits"
            onClick={onViewTransactions}
            disabled={isAnySyncing}
            icon={<DocumentIcon />}
            dataTour="transactions-card"
            dataTestId="nav-transactions"
          />
        </div>

        {/* Small row: Clients & Contacts (+ phone sync). Placement is an ASSUMPTION, see DashboardSecondaryRow. */}
        <DashboardSecondaryRow
          onManageContacts={onManageContacts}
          onSyncPhone={onSyncPhone}
          onSyncAndroid={onSyncAndroid}
          disabled={isAnySyncing}
        />

        {/* BACKLOG-3965 PR-4b: Recent | Todo */}
        {user?.id && onOpenTransaction && (
          <DashboardPanels
            userId={user.id}
            onOpenTransaction={onOpenTransaction}
            onViewTransactions={onViewTransactions}
            disabled={isAnySyncing}
          />
        )}
      </div>

      {/* Start New Audit Modal */}
      {showStartNewAuditModal && (
        <StartNewAuditModal
          onSelectPendingTransaction={handleSelectPendingTransaction}
          onViewActiveTransactions={handleViewActiveTransactions}
          onCreateManually={handleCreateManually}
          onClose={handleCloseStartNewAuditModal}
          onSync={onTriggerRefresh}
          isSyncing={isAnySyncing}
        />
      )}

      {showLimitModal && (
        <TransactionLimitModal
          transactionCount={transactionCount}
          transactionLimit={transactionLimit}
          onClose={() => setShowLimitModal(false)}
        />
      )}
    </div>
  );
}

export default Dashboard;
