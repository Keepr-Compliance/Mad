/**
 * useModalFlow Hook
 *
 * Manages all modal visibility state and provides semantic open/close methods.
 * Extracts modal-related logic from useAppStateMachine for better modularity.
 */

import { useState, useCallback, useMemo } from "react";
import type { ModalState } from "../types";

export interface UseModalFlowReturn {
  // State
  modalState: ModalState;

  // Profile modal
  openProfile: () => void;
  closeProfile: () => void;

  // Settings modal
  openSettings: (scrollTarget?: string) => void;
  closeSettings: () => void;

  // Transactions modal
  openTransactions: () => void;
  closeTransactions: () => void;

  // Contacts modal
  openContacts: () => void;
  closeContacts: () => void;

  // Audit transaction modal
  openAuditTransaction: () => void;
  closeAuditTransaction: () => void;

  // Version popup
  toggleVersion: () => void;
  closeVersion: () => void;

  // Terms modal
  openTermsModal: () => void;
  closeTermsModal: () => void;

  // Move app prompt
  openMoveAppPrompt: () => void;
  closeMoveAppPrompt: () => void;

  // iPhone sync modal
  openIPhoneSync: () => void;
  closeIPhoneSync: () => void;

  // Android sync modal
  openAndroidSync: () => void;
  closeAndroidSync: () => void;

  // Internal setters (for orchestrator to control)
  setShowProfile: (show: boolean) => void;
  setShowTermsModal: (show: boolean) => void;
  setShowMoveAppPrompt: (show: boolean) => void;
}

export function useModalFlow(): UseModalFlowReturn {
  // Modal state
  const [showProfile, setShowProfile] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showTransactions, setShowTransactions] = useState<boolean>(false);
  const [showContacts, setShowContacts] = useState<boolean>(false);
  const [showAuditTransaction, setShowAuditTransaction] =
    useState<boolean>(false);
  const [showVersion, setShowVersion] = useState<boolean>(false);
  const [showMoveAppPrompt, setShowMoveAppPrompt] = useState<boolean>(false);
  const [showTermsModal, setShowTermsModal] = useState<boolean>(false);
  const [showIPhoneSync, setShowIPhoneSync] = useState<boolean>(false);
  const [showAndroidSync, setShowAndroidSync] = useState<boolean>(false);

  // Semantic modal methods
  const openProfile = useCallback(() => setShowProfile(true), []);
  const closeProfile = useCallback(() => setShowProfile(false), []);

  const openSettings = useCallback(() => setShowSettings(true), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);

  const openTransactions = useCallback(() => setShowTransactions(true), []);
  const closeTransactions = useCallback(() => setShowTransactions(false), []);

  const openContacts = useCallback(() => setShowContacts(true), []);
  const closeContacts = useCallback(() => setShowContacts(false), []);

  const openAuditTransaction = useCallback(
    () => setShowAuditTransaction(true),
    [],
  );
  const closeAuditTransaction = useCallback(
    () => setShowAuditTransaction(false),
    [],
  );

  const toggleVersion = useCallback(() => setShowVersion((prev) => !prev), []);
  const closeVersion = useCallback(() => setShowVersion(false), []);

  const openTermsModal = useCallback(() => setShowTermsModal(true), []);
  const closeTermsModal = useCallback(() => setShowTermsModal(false), []);

  const openMoveAppPrompt = useCallback(() => setShowMoveAppPrompt(true), []);
  const closeMoveAppPrompt = useCallback(() => setShowMoveAppPrompt(false), []);

  const openIPhoneSync = useCallback(() => setShowIPhoneSync(true), []);
  const closeIPhoneSync = useCallback(() => setShowIPhoneSync(false), []);

  const openAndroidSync = useCallback(() => setShowAndroidSync(true), []);
  const closeAndroidSync = useCallback(() => setShowAndroidSync(false), []);

  // Memoized modal state object
  const modalState = useMemo<ModalState>(
    () => ({
      showProfile,
      showSettings,
      showTransactions,
      showContacts,
      showAuditTransaction,
      showVersion,
      showMoveAppPrompt,
      showTermsModal,
      showIPhoneSync,
      showAndroidSync,
    }),
    [
      showProfile,
      showSettings,
      showTransactions,
      showContacts,
      showAuditTransaction,
      showVersion,
      showMoveAppPrompt,
      showTermsModal,
      showIPhoneSync,
      showAndroidSync,
    ],
  );

  return useMemo(
    () => ({
      modalState,
      openProfile,
      closeProfile,
      openSettings,
      closeSettings,
      openTransactions,
      closeTransactions,
      openContacts,
      closeContacts,
      openAuditTransaction,
      closeAuditTransaction,
      toggleVersion,
      closeVersion,
      openTermsModal,
      closeTermsModal,
      openMoveAppPrompt,
      closeMoveAppPrompt,
      openIPhoneSync,
      closeIPhoneSync,
      openAndroidSync,
      closeAndroidSync,
      setShowProfile,
      setShowTermsModal,
      setShowMoveAppPrompt,
    }),
    [
      modalState,
      openProfile,
      closeProfile,
      openSettings,
      closeSettings,
      openTransactions,
      closeTransactions,
      openContacts,
      closeContacts,
      openAuditTransaction,
      closeAuditTransaction,
      toggleVersion,
      closeVersion,
      openTermsModal,
      closeTermsModal,
      openMoveAppPrompt,
      closeMoveAppPrompt,
      openIPhoneSync,
      closeIPhoneSync,
      openAndroidSync,
      closeAndroidSync,
    ],
  );
}
