/**
 * useModalFlow Hook
 *
 * Manages all modal visibility state and provides semantic open/close methods.
 * Extracts modal-related logic from useAppStateMachine for better modularity.
 */

import { useState, useCallback, useMemo } from "react";
import type { AndroidSyncStart, ModalState } from "../types";

export interface UseModalFlowReturn {
  // State
  modalState: ModalState;

  // Profile modal
  openProfile: () => void;
  closeProfile: () => void;

  // Settings page (BACKLOG-3964: a full page, opened at a section)
  openSettings: (scrollTarget?: string) => void;
  closeSettings: () => void;
  /** The page calls this once it has scrolled to `modalState.settingsTarget`. */
  clearSettingsTarget: () => void;

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
  openAndroidSync: (start?: AndroidSyncStart) => void;
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
  const [settingsTarget, setSettingsTarget] = useState<string | null>(null);
  const [showTransactions, setShowTransactions] = useState<boolean>(false);
  const [showContacts, setShowContacts] = useState<boolean>(false);
  const [showAuditTransaction, setShowAuditTransaction] =
    useState<boolean>(false);
  const [showVersion, setShowVersion] = useState<boolean>(false);
  const [showMoveAppPrompt, setShowMoveAppPrompt] = useState<boolean>(false);
  const [showTermsModal, setShowTermsModal] = useState<boolean>(false);
  const [showIPhoneSync, setShowIPhoneSync] = useState<boolean>(false);
  const [showAndroidSync, setShowAndroidSync] = useState<boolean>(false);
  const [androidSyncStart, setAndroidSyncStart] = useState<AndroidSyncStart>("default");

  // Semantic modal methods
  // BACKLOG-3964: the title-bar initials stay live while the Settings page
  // shows. Profile renders beneath it, so close Settings first (as Profile's
  // own Settings link closes Profile first). Slice 3 replaces this with the panel.
  const openProfile = useCallback(() => {
    setShowSettings(false);
    setSettingsTarget(null);
    setShowProfile(true);
  }, []);
  const closeProfile = useCallback(() => setShowProfile(false), []);

  // BACKLOG-3964: the target used to be dropped here, and every "open Settings
  // at X" caller relied on a 500 ms timer instead. A non-string (an onClick
  // event passed through) is no target.
  const openSettings = useCallback((scrollTarget?: string) => {
    setSettingsTarget(typeof scrollTarget === "string" && scrollTarget ? scrollTarget : null);
    setShowSettings(true);
  }, []);
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setSettingsTarget(null);
  }, []);
  const clearSettingsTarget = useCallback(() => setSettingsTarget(null), []);

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

  // SR: the start comes with each open (a dashboard open is always "default";
  // an onClick event passed through is never "link").
  const openAndroidSync = useCallback((start?: AndroidSyncStart) => {
    setAndroidSyncStart(start === "link" ? "link" : "default");
    setShowAndroidSync(true);
  }, []);
  const closeAndroidSync = useCallback(() => {
    setShowAndroidSync(false);
    setAndroidSyncStart("default");
  }, []);

  // Memoized modal state object
  const modalState = useMemo<ModalState>(
    () => ({
      showProfile,
      showSettings,
      settingsTarget,
      showTransactions,
      showContacts,
      showAuditTransaction,
      showVersion,
      showMoveAppPrompt,
      showTermsModal,
      showIPhoneSync,
      showAndroidSync,
      androidSyncStart,
    }),
    [
      showProfile,
      showSettings,
      settingsTarget,
      showTransactions,
      showContacts,
      showAuditTransaction,
      showVersion,
      showMoveAppPrompt,
      showTermsModal,
      showIPhoneSync,
      showAndroidSync,
      androidSyncStart,
    ],
  );

  return useMemo(
    () => ({
      modalState,
      openProfile,
      closeProfile,
      openSettings,
      closeSettings,
      clearSettingsTarget,
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
      clearSettingsTarget,
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
