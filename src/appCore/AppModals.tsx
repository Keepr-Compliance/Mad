/**
 * AppModals Component
 *
 * Renders all modal components that can appear over the main application.
 * This keeps modal logic centralized and separate from routing.
 */

import React, { useCallback, useState } from "react";
import Profile from "../components/Profile";
import TransactionList from "../components/TransactionList";
import Contacts from "../components/Contacts";
import WelcomeTerms from "../components/WelcomeTerms";
import AuditTransactionModal from "../components/AuditTransactionModal";
import MoveAppPrompt from "../components/MoveAppPrompt";
import { IPhoneSyncModal } from "./modals/IPhoneSyncModal";
import { AndroidSyncModal } from "./modals/AndroidSyncModal";
import type { AppStateMachine } from "./state/types";
import type { Transaction } from "@/types";
import { useGoogleMessagesSyncStatus } from "../hooks/useGoogleMessagesSyncStatus";
import { useExtensionFolderRefresh } from "../hooks/useExtensionFolderRefresh";
import { useSubmissionStatusNotice } from "./hooks/useSubmissionStatusNotice";

interface AppModalsProps {
  app: AppStateMachine;
}

export function AppModals({ app }: AppModalsProps) {
  const {
    modalState,
    currentUser,
    authProvider,
    subscription,
    isDatabaseInitialized,
    pendingOAuthData,
    needsTermsAcceptance,
    appPath,
    // Modal transitions
    closeProfile,
    closeTransactions,
    closeContacts,
    closeAuditTransaction,
    openSettings,
    openTransactions,
    // Handlers
    handleLogout,
    handleAcceptTerms,
    handleDeclineTerms,
    handleDismissMovePrompt,
    handleNotNowMovePrompt,
    closeIPhoneSync,
    closeAndroidSync,
  } = app;

  // BACKLOG-3658: a Google Messages Sync on the dashboard indicator, even minimized.
  useGoogleMessagesSyncStatus();
  useExtensionFolderRefresh();

  // Track newly created transaction so TransactionList can auto-open its details
  const [auditCreatedTransaction, setAuditCreatedTransaction] = useState<Transaction | null>(null);

  // BACKLOG-1898 T5: id of a transaction to auto-open in TransactionList, set
  // when the user clicks a transaction row in the Contacts detail card. Kept
  // local to AppModals (like auditCreatedTransaction) so no state-machine change
  // is needed.
  const [pendingTransactionId, setPendingTransactionId] = useState<string | null>(null);

  // Compound action: close audit transaction modal and open transactions with the new transaction selected
  const handleAuditTransactionSuccess = useCallback((transaction: Transaction) => {
    closeAuditTransaction();
    setAuditCreatedTransaction(transaction);
    openTransactions();
  }, [closeAuditTransaction, openTransactions]);

  // BACKLOG-1898 T5: open a transaction from a Contacts card click — close the
  // Contacts modal, remember the id, and open the Transactions view (which
  // resolves + opens the transaction detail by id).
  const handleOpenTransactionFromContact = useCallback((transactionId: string) => {
    closeContacts();
    setPendingTransactionId(transactionId);
    openTransactions();
  }, [closeContacts, openTransactions]);

  // BACKLOG-3594: tell the agent when a submission comes back from the broker;
  // its "Open" action reuses the open-by-id path above.
  useSubmissionStatusNotice({ onOpenTransaction: handleOpenTransactionFromContact });

  return (
    <>
      {/* Move App Prompt */}
      {modalState.showMoveAppPrompt && (
        <MoveAppPrompt
          appPath={appPath}
          onDismiss={handleDismissMovePrompt}
          onNotNow={handleNotNowMovePrompt}
        />
      )}

      {/* Profile Modal */}
      {modalState.showProfile && currentUser && authProvider && (
        <Profile
          user={currentUser}
          provider={authProvider}
          subscription={subscription}
          onLogout={handleLogout}
          onClose={closeProfile}
          onViewTransactions={openTransactions}
          onOpenSettings={openSettings}
        />
      )}

      {/* Settings is a page, not a modal: shell/SettingsLayer (BACKLOG-3964). */}

      {/* Transactions View */}
      {modalState.showTransactions && currentUser && authProvider && isDatabaseInitialized && (
        <div className="fixed inset-0 z-[60]">
          <TransactionList
            userId={currentUser.id}
            provider={authProvider as "google" | "microsoft"}
            onClose={() => {
              setAuditCreatedTransaction(null);
              setPendingTransactionId(null);
              closeTransactions();
            }}
            initialTransaction={auditCreatedTransaction}
            initialTransactionId={pendingTransactionId}
          />
        </div>
      )}

      {/* Contacts View */}
      {modalState.showContacts && currentUser && isDatabaseInitialized && (
        <div className="fixed inset-0 z-[60]">
          <Contacts
            userId={currentUser.id}
            onClose={closeContacts}
            onOpenTransaction={handleOpenTransactionFromContact}
          />
        </div>
      )}

      {/* Welcome Terms Modal (New Users Only) */}
      {(modalState.showTermsModal || (needsTermsAcceptance && currentUser)) && (
        <WelcomeTerms
          user={
            currentUser ||
            (pendingOAuthData
              ? {
                  id: pendingOAuthData.cloudUser.id,
                  email: pendingOAuthData.userInfo.email,
                  display_name: pendingOAuthData.userInfo.name,
                  avatar_url: pendingOAuthData.userInfo.picture,
                }
              : { id: "", email: "" })
          }
          onAccept={handleAcceptTerms}
          onDecline={handleDeclineTerms}
        />
      )}

      {/* Audit Transaction Modal */}
      {modalState.showAuditTransaction && currentUser && authProvider && isDatabaseInitialized && (
        <AuditTransactionModal
          userId={currentUser.id}
          provider={authProvider}
          onClose={closeAuditTransaction}
          onSuccess={handleAuditTransactionSuccess}
        />
      )}

      {/* iPhone Sync Flow Modal */}
      {modalState.showIPhoneSync && <IPhoneSyncModal onClose={closeIPhoneSync} />}

      {/* Android Sync Wizard Modal (BACKLOG-2320) */}
      {/* SR C6 (founder): always Google Messages — the Companion's UI is removed. */}
      {modalState.showAndroidSync && currentUser && (
        <AndroidSyncModal
          userId={currentUser.id}
          onClose={closeAndroidSync}
          startAtLink={modalState.androidSyncStart === "link"}
          onOpenSettings={openSettings}
        />
      )}
    </>
  );
}
