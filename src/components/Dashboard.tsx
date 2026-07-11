import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Joyride from "react-joyride";
import { useTour } from "../hooks/useTour";
import { usePendingTransactionCount } from "../hooks/usePendingTransactionCount";
import { useSyncOrchestrator } from "../hooks/useSyncOrchestrator";
import { SyncStatusIndicator } from "./dashboard/index";
import StartNewAuditModal from "./StartNewAuditModal";
import { FeatureGate } from "./common/FeatureGate";
import { AlertBanner, AlertIcons } from "./common/AlertBanner";
import { TransactionLimitModal } from "./common/TransactionLimitModal";
import { useLicense } from "../contexts/LicenseContext";
import { useFeatureGate } from "../hooks/useFeatureGate";
import {
  getDashboardTourSteps,
  JOYRIDE_STYLES,
  JOYRIDE_LOCALE,
} from "../config/tourSteps";
import type { Transaction } from "../types";
import { useReconnectionSummary } from "../hooks/useReconnectionSummary";

interface DashboardActionProps {
  onAuditNew: () => void;
  onViewTransactions: () => void;
  onManageContacts: () => void;
  onSyncPhone?: () => void; // Only available for Windows + iPhone users
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
  /** Current user info for personalized greeting */
  user?: {
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
  onTourStateChange,
  showSetupPrompt,
  onContinueSetup,
  onDismissSetupPrompt,
  onTriggerRefresh,
  onSelectPendingTransaction,
  onOpenSettings,
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

  // Initialize the onboarding tour for first-time users
  const { runTour, handleJoyrideCallback } = useTour(
    true,
    "hasSeenDashboardTour",
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
    <div className="min-h-full bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-4 sm:p-8">
      {/* Onboarding Tour */}
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
      />
      <div className="max-w-5xl w-full">
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
            onAction={() => window.open("https://www.keeprcompliance.com/beta", "_blank")}
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
            }}
          />
        </div>

        {/* Header */}
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-2xl sm:text-4xl font-bold text-gray-900 mb-2 sm:mb-3">
            {greeting}
          </h1>
          <p className="text-base sm:text-lg text-gray-600">
            Transaction compliance made simple
          </p>
        </div>

        {/* Action Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-8">
          {/* Start New Audit Card */}
          <button
            onClick={handleStartNewAuditClick}
            disabled={isAnySyncing}
            className={`group bg-white rounded-2xl shadow-xl transition-all duration-300 p-6 text-left border-2 transform ${
              isAnySyncing
                ? "opacity-50 cursor-not-allowed"
                : `hover:shadow-2xl hover:scale-105 ${
                    pendingCount > 0
                      ? "border-indigo-500 ring-2 ring-indigo-300 ring-offset-2 hover:border-indigo-600"
                      : "border-transparent hover:border-blue-500"
                  }`
            }`}
            data-tour="new-audit-card"
          >
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg group-hover:shadow-xl transition-all">
                <svg
                  className="w-7 h-7 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-gray-900">
                  New Audit
                </h2>
              </div>
              {/* Pending count badge - AI add-on only */}
              <FeatureGate requires="ai_addon">
                {pendingCount > 0 && (
                  <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-sm font-semibold bg-indigo-100 text-indigo-800 animate-pulse">
                    {pendingCount} new
                  </span>
                )}
              </FeatureGate>
              <svg
                className="w-5 h-5 text-blue-600 group-hover:translate-x-1 transition-transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </button>

          {/* Browse Transactions Card */}
          <button
            onClick={onViewTransactions}
            disabled={isAnySyncing}
            className={`group bg-white rounded-2xl shadow-xl transition-all duration-300 p-6 text-left border-2 transform ${
              isAnySyncing
                ? "opacity-50 cursor-not-allowed border-transparent"
                : "hover:shadow-2xl hover:scale-105 border-transparent hover:border-green-500"
            }`}
            data-tour="transactions-card"
          >
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-green-500 to-teal-600 rounded-xl flex items-center justify-center shadow-lg group-hover:shadow-xl transition-all">
                <svg
                  className="w-7 h-7 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-gray-900">
                  All Audits
                </h2>
              </div>
              <svg
                className="w-5 h-5 text-green-600 group-hover:translate-x-1 transition-transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </button>
        </div>

        {/* Secondary Actions Row */}
        <div className={`mt-4 sm:mt-8 grid gap-4 ${onSyncPhone ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
          {/* Manage Contacts Card */}
          <button
            onClick={onManageContacts}
            disabled={isAnySyncing}
            className={`group w-full relative bg-white bg-opacity-70 backdrop-blur rounded-2xl shadow-lg transition-all duration-300 p-6 text-left border-2 transform ${
              isAnySyncing
                ? "opacity-50 cursor-not-allowed border-transparent"
                : "hover:shadow-xl hover:scale-[1.02] border-transparent hover:border-purple-400"
            }`}
            data-tour="contacts-card"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-pink-600 rounded-xl flex items-center justify-center shadow-lg">
                <svg
                  className="w-6 h-6 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-gray-900 mb-1">
                  Clients &amp; Contacts
                </h3>
              </div>
              <svg
                className="w-5 h-5 text-purple-600 group-hover:translate-x-2 transition-transform"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </div>
          </button>

          {/* Sync iPhone Card (Windows + iPhone users only) */}
          {onSyncPhone && (
            <button
              onClick={onSyncPhone}
              disabled={isAnySyncing}
              className={`group w-full relative bg-white bg-opacity-70 backdrop-blur rounded-2xl shadow-lg transition-all duration-300 p-6 text-left border-2 transform ${
                isAnySyncing
                  ? "opacity-50 cursor-not-allowed border-transparent"
                  : "hover:shadow-xl hover:scale-[1.02] border-transparent hover:border-indigo-400"
              }`}
              data-tour="sync-phone-card"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg">
                  <svg
                    className="w-6 h-6 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-gray-900 mb-1">
                    Sync iPhone Messages
                  </h3>
                  <p className="text-sm text-gray-500">
                    Import texts via USB cable
                  </p>
                </div>
                <svg
                  className="w-5 h-5 text-indigo-600 group-hover:translate-x-2 transition-transform"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </div>
            </button>
          )}
        </div>

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
