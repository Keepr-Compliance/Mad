/**
 * App State Types
 *
 * Centralized type definitions for the application state machine.
 * These types are extracted from App.tsx for better modularity and reuse.
 */

import type { Subscription } from "../../../electron/types/models";
import type { PendingOAuthData, DeepLinkAuthData } from "../../components/Login";
import type { SyncStatus } from "../../hooks/useAutoRefresh";

// Application navigation steps
export type AppStep =
  | "loading"
  | "login"
  | "error" // TASK-2278: Error screen for DB init failures and other errors
  | "keychain-explanation"
  | "phone-type-selection"
  | "android-coming-soon"
  | "apple-driver-setup"
  | "email-onboarding"
  | "permissions"
  | "dashboard";

// Pending onboarding data - stored in memory before DB is initialized
export interface PendingOnboardingData {
  termsAccepted: boolean;
  phoneType: "iphone" | "android" | null;
  emailConnected: boolean;
  emailProvider: "google" | "microsoft" | null;
}

// Phone type options
export type PhoneType = "iphone" | "android" | null;

// Auth provider options
export type AuthProvider = "google" | "microsoft";

// User type for app-level state
export interface AppUser {
  id: string;
  email: string;
  display_name?: string;
  avatar_url?: string;
}

// Modal visibility state
export interface ModalState {
  showProfile: boolean;
  showSettings: boolean;
  showTransactions: boolean;
  showContacts: boolean;
  showAuditTransaction: boolean;
  showVersion: boolean;
  showMoveAppPrompt: boolean;
  showTermsModal: boolean;
  showIPhoneSync: boolean;
}

/**
 * AppStateMachine Interface
 *
 * Typed interface for the application state machine.
 * Provides read-only state access and semantic transition methods.
 * This interface eliminates prop drilling by grouping related state
 * and exposing semantic methods instead of raw setters.
 */
export interface AppStateMachine {
  // ============================================
  // READ-ONLY STATE
  // ============================================

  // Navigation state
  currentStep: AppStep;

  // Auth state (from context)
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  currentUser: AppUser | null;
  sessionToken: string | null;
  authProvider: string | null;
  subscription: Subscription | undefined;
  needsTermsAcceptance: boolean;

  // Network state (from context)
  isOnline: boolean;
  isChecking: boolean;
  connectionError: string | null;

  // Platform state (from context)
  isMacOS: boolean;
  isWindows: boolean;

  // Permissions state
  hasPermissions: boolean;

  // Secure storage state
  hasSecureStorageSetup: boolean;
  isCheckingSecureStorage: boolean;
  isDatabaseInitialized: boolean;
  isInitializingDatabase: boolean;

  // Email onboarding state
  hasCompletedEmailOnboarding: boolean;
  hasEmailConnected: boolean;
  isCheckingEmailOnboarding: boolean;

  // Phone type state
  hasSelectedPhoneType: boolean;
  selectedPhoneType: "iphone" | "android" | null;
  isLoadingPhoneType: boolean;
  needsDriverSetup: boolean;

  // New user flow state
  isNewUserFlow: boolean;

  // Pending data (pre-DB flow)
  pendingOAuthData: PendingOAuthData | null;
  pendingOnboardingData: PendingOnboardingData;

  // Modal state (grouped)
  modalState: ModalState;

  // UI state
  showSetupPromptDismissed: boolean;
  isTourActive: boolean;
  appPath: string;

  // Sync status (for dashboard indicator)
  syncStatus?: SyncStatus;
  isAnySyncing: boolean;
  currentSyncMessage: string | null;
  triggerRefresh: () => Promise<void>;

  // ============================================
  // SEMANTIC MODAL TRANSITIONS
  // ============================================

  // Profile modal
  openProfile(): void;
  closeProfile(): void;

  // Settings modal
  openSettings(scrollTarget?: string): void;
  closeSettings(): void;

  // Transactions modal
  openTransactions(): void;
  closeTransactions(): void;

  // Contacts modal
  openContacts(): void;
  closeContacts(): void;

  // Audit transaction modal
  openAuditTransaction(): void;
  closeAuditTransaction(): void;

  // Version popup
  toggleVersion(): void;
  closeVersion(): void;

  // Terms modal
  openTermsModal(): void;
  closeTermsModal(): void;

  // Move app prompt
  openMoveAppPrompt(): void;
  closeMoveAppPrompt(): void;

  // iPhone sync modal
  openIPhoneSync(): void;
  closeIPhoneSync(): void;

  // ============================================
  // NAVIGATION TRANSITIONS
  // ============================================

  goToStep(step: AppStep): void;
  goToEmailOnboarding(): void;

  // ============================================
  // AUTH HANDLERS
  // ============================================

  handleLoginSuccess: (
    user: AppUser,
    token: string,
    provider: string,
    subscriptionData: Subscription | undefined,
    isNewUser: boolean,
  ) => void;
  handleLoginPending: (oauthData: PendingOAuthData) => void;
  /** TASK-1507B: Handle deep link auth success from browser OAuth flow */
  handleDeepLinkAuthSuccess: (data: DeepLinkAuthData) => void;
  handleLogout: () => Promise<void>;

  // ============================================
  // TERMS HANDLERS
  // ============================================

  handleAcceptTerms: () => Promise<void>;
  handleDeclineTerms: () => Promise<void>;

  // ============================================
  // PHONE TYPE HANDLERS
  // ============================================

  handleSelectIPhone: () => Promise<void>;
  handleSelectAndroid: () => Promise<void>;
  handleAndroidGoBack: () => void;
  handleAndroidContinueWithEmail: () => Promise<void>;
  handlePhoneTypeChange: (phoneType: "iphone" | "android") => Promise<void>;
  handleAppleDriverSetupComplete: () => Promise<void>;
  handleAppleDriverSetupSkip: () => Promise<void>;

  // ============================================
  // EMAIL ONBOARDING HANDLERS
  // ============================================

  handleEmailOnboardingComplete: () => Promise<void>;
  handleEmailOnboardingSkip: () => Promise<void>;
  handleEmailOnboardingBack: () => void;

  /**
   * Start Google OAuth flow for email connection.
   * Sets up event listeners and initiates the OAuth popup.
   */
  handleStartGoogleEmailConnect: () => Promise<void>;

  /**
   * Start Microsoft OAuth flow for email connection.
   * Sets up event listeners and initiates the OAuth popup.
   */
  handleStartMicrosoftEmailConnect: () => Promise<void>;

  // ============================================
  // KEYCHAIN HANDLERS
  // ============================================

  handleKeychainExplanationContinue: () => Promise<void>;
  handleKeychainBack: () => void;

  // ============================================
  // PERMISSION HANDLERS
  // ============================================

  handlePermissionsGranted: () => void;
  checkPermissions: () => Promise<void>;

  // ============================================
  // NETWORK HANDLERS
  // ============================================

  handleRetryConnection: () => Promise<void>;

  // ============================================
  // UI HANDLERS
  // ============================================

  handleDismissSetupPrompt: () => void;
  setIsTourActive: (active: boolean) => void;
  handleDismissMovePrompt: () => void;
  handleNotNowMovePrompt: () => void;

  // ============================================
  // UTILITY
  // ============================================

  getPageTitle: () => string;
}

// Re-export types needed by consumers
export type { Subscription, PendingOAuthData, DeepLinkAuthData };
