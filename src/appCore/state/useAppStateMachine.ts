/**
 * useAppStateMachine Hook
 *
 * Central state machine for the application.
 * Orchestrates all application state, navigation, and business logic.
 * Uses specialized flow hooks for domain-specific state management.
 *
 * Returns a typed AppStateMachine interface with:
 * - Read-only state properties
 * - Semantic transition methods (openProfile, closeProfile, etc.)
 * - Handler methods for complex operations
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAuth, useNetwork, usePlatform } from "../../contexts";
import { useFeatureGate } from "../../hooks/useFeatureGate";
import {
  useSecureStorage,
  useEmailOnboardingApi,
  usePhoneTypeApi,
  useModalFlow,
  useAuthFlow,
  usePermissionsFlow,
  useNavigationFlow,
  useEmailHandlers,
  usePhoneHandlers,
  useKeychainHandlers,
} from "./flows";
import { useOptionalMachineState } from "./machine/hooks/useOptionalMachineState";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import {
  constructStateProps,
  constructModalTransitions,
  constructHandlers,
} from "./returnHelpers";
import type { AppStateMachine } from "./types";

export function useAppStateMachine(): AppStateMachine {
  // ============================================
  // CONTEXT HOOKS
  // ============================================
  const {
    isAuthenticated,
    isLoading: isAuthLoading,
    currentUser,
    sessionToken,
    authProvider,
    subscription,
    needsTermsAcceptance,
    login,
    logout,
    acceptTerms,
    declineTerms,
    clearTermsRequirement,
  } = useAuth();

  const {
    isOnline,
    isChecking,
    connectionError,
    checkConnection,
    setConnectionError,
  } = useNetwork();

  const { isMacOS, isWindows } = usePlatform();

  const { isAllowed, refresh: refreshFeatureGate } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");

  // BACKLOG-1348: Refresh feature gate after login completes.
  // The hook's initial fetch fires before login, caching stale "no org" results.
  // When isAuthenticated flips to true, invalidate the cache and re-fetch so
  // org-level features (broker_submission, etc.) resolve correctly.
  const prevAuthRef = useRef(isAuthenticated);
  useEffect(() => {
    if (isAuthenticated && !prevAuthRef.current) {
      refreshFeatureGate();
    }
    prevAuthRef.current = isAuthenticated;
  }, [isAuthenticated, refreshFeatureGate]);

  // ============================================
  // STATE MACHINE (Optional - feature flagged)
  // ============================================
  const machineState = useOptionalMachineState();


  // ============================================
  // MODAL FLOW
  // ============================================
  const modal = useModalFlow();

  // ============================================
  // EMAIL ONBOARDING API (existing)
  // ============================================
  const emailOnboardingApi = useEmailOnboardingApi({ userId: currentUser?.id });

  // ============================================
  // PHONE TYPE API (existing)
  // ============================================
  const phoneTypeApi = usePhoneTypeApi({ userId: currentUser?.id, isWindows });

  // ============================================
  // AUTH FLOW
  // ============================================
  // Derive isDatabaseInitialized from state machine (before useSecureStorage to avoid circular dep)
  // DB is initialized if we're not in loading state with deferredDbInit flag
  const isDatabaseInitializedFromMachine = machineState?.state
    ? !(machineState.state.status === "loading" && (machineState.state as { deferredDbInit?: boolean }).deferredDbInit) &&
      !(machineState.state.status === "unauthenticated" && (machineState.state as { deferredDbInit?: boolean }).deferredDbInit) &&
      !(machineState.state.status === "onboarding" && (machineState.state as { deferredDbInit?: boolean }).deferredDbInit)
    : true; // Default to true if no state machine

  const auth = useAuthFlow({
    login,
    logout,
    acceptTerms,
    declineTerms,
    clearTermsRequirement,
    isAuthenticated,
    isDatabaseInitialized: isDatabaseInitializedFromMachine,
    currentUserId: currentUser?.id ?? null,
    onCloseProfile: modal.closeProfile,
    onSetHasSelectedPhoneType: phoneTypeApi.setHasSelectedPhoneType,
    onSetSelectedPhoneType: phoneTypeApi.setSelectedPhoneType,
    onSetCurrentStep: (step) => nav.setCurrentStep(step),
    // Pass state machine dispatch for LOGIN_SUCCESS integration
    stateMachineDispatch: machineState?.dispatch,
    platform: { isMacOS, isWindows },
  });

  // ============================================
  // PERMISSIONS FLOW
  // ============================================
  const permissions = usePermissionsFlow({
    isWindows,
    onSetShowMoveAppPrompt: modal.setShowMoveAppPrompt,
    onSetCurrentStep: (step) => nav.setCurrentStep(step),
    stateMachineDispatch: machineState?.dispatch,
  });

  // ============================================
  // SECURE STORAGE (existing)
  // ============================================
  const secureStorage = useSecureStorage({
    isWindows,
    isMacOS,
    pendingOAuthData: auth.pendingOAuthData,
    pendingOnboardingData: auth.pendingOnboardingData,
    isAuthenticated,
    login,
    onPendingOAuthClear: () => auth.setPendingOAuthData(null),
    onPendingOnboardingClear: () =>
      auth.setPendingOnboardingData({
        termsAccepted: false,
        phoneType: null,
        emailConnected: false,
        emailProvider: null,
      }),
    onPhoneTypeSet: phoneTypeApi.setHasSelectedPhoneType,
    onEmailOnboardingComplete: (completed, connected) => {
      emailOnboardingApi.setHasCompletedEmailOnboarding(completed);
      emailOnboardingApi.setHasEmailConnected(connected);
    },
    onNewUserFlowSet: auth.setIsNewUserFlow,
    onNeedsDriverSetup: phoneTypeApi.setNeedsDriverSetup,
  });

  // ============================================
  // NAVIGATION FLOW
  // ============================================
  const nav = useNavigationFlow({
    isAuthenticated,
    isAuthLoading,
    needsTermsAcceptance,
    isMacOS,
    isWindows,
    pendingOAuthData: auth.pendingOAuthData,
    pendingOnboardingData: auth.pendingOnboardingData,
    isCheckingSecureStorage: secureStorage.isCheckingSecureStorage,
    isDatabaseInitialized: secureStorage.isDatabaseInitialized,
    isInitializingDatabase: secureStorage.isInitializingDatabase,
    initializeSecureStorage: secureStorage.initializeSecureStorage,
    hasSelectedPhoneType: phoneTypeApi.hasSelectedPhoneType,
    isLoadingPhoneType: phoneTypeApi.isLoadingPhoneType,
    needsDriverSetup: phoneTypeApi.needsDriverSetup,
    hasCompletedEmailOnboarding: emailOnboardingApi.hasCompletedEmailOnboarding,
    hasEmailConnected: emailOnboardingApi.hasEmailConnected,
    isCheckingEmailOnboarding: emailOnboardingApi.isCheckingEmailOnboarding,
    hasPermissions: permissions.hasPermissions,
    showTermsModal: modal.modalState.showTermsModal,
    onSetShowTermsModal: modal.setShowTermsModal,
  });

  // ============================================
  // EMAIL HANDLERS
  // TASK-1603: Simplified after flow reorder (no more pending email tokens)
  // ============================================
  const emailHandlers = useEmailHandlers({
    currentUserId: currentUser?.id,
    currentUserEmail: currentUser?.email,
    isMacOS,
    isWindows,
    selectedPhoneType: phoneTypeApi.selectedPhoneType,
    needsDriverSetup: phoneTypeApi.needsDriverSetup,
    hasPermissions: permissions.hasPermissions,
    setPendingOnboardingData: auth.setPendingOnboardingData,
    setHasEmailConnected: emailOnboardingApi.setHasEmailConnected,
    setCurrentStep: nav.setCurrentStep,
    completeEmailOnboarding: emailOnboardingApi.completeEmailOnboarding,
  });

  // ============================================
  // PHONE HANDLERS
  // ============================================
  const phoneHandlers = usePhoneHandlers({
    pendingOAuthData: auth.pendingOAuthData,
    isAuthenticated,
    currentUserId: currentUser?.id,
    isWindows,
    selectedPhoneType: phoneTypeApi.selectedPhoneType,
    setSelectedPhoneType: phoneTypeApi.setSelectedPhoneType,
    setHasSelectedPhoneType: phoneTypeApi.setHasSelectedPhoneType,
    setNeedsDriverSetup: phoneTypeApi.setNeedsDriverSetup,
    savePhoneType: phoneTypeApi.savePhoneType,
    setHasCompletedEmailOnboarding:
      emailOnboardingApi.setHasCompletedEmailOnboarding,
    setPendingOnboardingData: auth.setPendingOnboardingData,
    setCurrentStep: nav.setCurrentStep,
  });

  // ============================================
  // KEYCHAIN HANDLERS
  // ============================================
  const keychainHandlers = useKeychainHandlers({
    initializeSecureStorage: secureStorage.initializeSecureStorage,
    setCurrentStep: nav.setCurrentStep,
  });

  // ============================================
  // AUTO-REFRESH (TASK-1003)
  // ============================================
  const autoSync = useAutoRefresh({
    userId: currentUser?.id ?? null,
    hasEmailConnected: emailOnboardingApi.hasEmailConnected,
    isDatabaseInitialized: secureStorage.isDatabaseInitialized,
    hasPermissions: permissions.hasPermissions,
    isOnDashboard: nav.currentStep === "dashboard",
    isOnboarding: nav.currentStep !== "dashboard",
    hasAIAddon,
  });

  // ============================================
  // NETWORK HANDLERS
  // ============================================
  const handleRetryConnection = useCallback(async () => {
    const online = await checkConnection();
    if (!online) {
      setConnectionError(
        "Unable to connect. Please check your internet connection.",
      );
    }
  }, [checkConnection, setConnectionError]);

  // ============================================
  // UI HANDLERS
  // ============================================
  const handleDismissMovePrompt = useCallback((): void => {
    modal.closeMoveAppPrompt();
  }, [modal]);

  const handleNotNowMovePrompt = useCallback((): void => {
    modal.closeMoveAppPrompt();
  }, [modal]);

  // ============================================
  // CONTEXT STATE OBJECT (for helper functions)
  // ============================================
  const contextState = useMemo(
    () => ({
      isAuthenticated,
      isAuthLoading,
      currentUser,
      sessionToken,
      authProvider,
      subscription,
      needsTermsAcceptance,
      isOnline,
      isChecking,
      connectionError,
      isMacOS,
      isWindows,
    }),
    [
      isAuthenticated,
      isAuthLoading,
      currentUser,
      sessionToken,
      authProvider,
      subscription,
      needsTermsAcceptance,
      isOnline,
      isChecking,
      connectionError,
      isMacOS,
      isWindows,
    ],
  );

  // ============================================
  // RETURN STATE MACHINE
  // ============================================
  return useMemo<AppStateMachine>(
    () => ({
      ...constructStateProps(
        contextState,
        nav,
        permissions,
        secureStorage,
        emailOnboardingApi,
        phoneTypeApi,
        auth,
        modal,
        autoSync,
      ),
      ...constructModalTransitions(modal),
      ...constructHandlers(
        nav,
        auth,
        permissions,
        phoneHandlers,
        emailHandlers,
        keychainHandlers,
        handleRetryConnection,
        handleDismissMovePrompt,
        handleNotNowMovePrompt,
      ),
    }),
    [
      contextState,
      nav,
      permissions,
      secureStorage,
      emailOnboardingApi,
      phoneTypeApi,
      auth,
      modal,
      autoSync,
      phoneHandlers,
      emailHandlers,
      keychainHandlers,
      handleRetryConnection,
      handleDismissMovePrompt,
      handleNotNowMovePrompt,
    ],
  );
}
