/**
 * WindowApi Events sub-interface
 * Top-level event listeners for auth, mailbox, deep link, and other events
 */

import type { User, Subscription } from "../models";
import type { FolderExportProgress } from "./common";

/**
 * Top-level event listener methods on window.api
 * These are directly on the WindowApi interface (not nested under a sub-object)
 */
export interface WindowApiEvents {
  // Event listeners for mailbox connections
  onGoogleMailboxConnected: (
    callback: (result: {
      success: boolean;
      email?: string;
      error?: string;
    }) => void,
  ) => () => void;
  onGoogleMailboxCancelled: (callback: () => void) => () => void;
  onMicrosoftMailboxConnected: (
    // BACKLOG-2007: `adminConsentRequired` is set when the connection failed
    // because the org tenant admin has not consented to Keepr (AADSTS admin-
    // consent block). The renderer uses it to show the "Request IT approval"
    // flow. `email`/`error` were already sent by the handler but missing here.
    callback: (result: {
      success: boolean;
      email?: string;
      error?: string;
      adminConsentRequired?: boolean;
    }) => void,
  ) => () => void;
  onMicrosoftMailboxCancelled: (callback: () => void) => () => void;
  onGoogleMailboxDisconnected: (
    callback: (result: { success: boolean }) => void,
  ) => () => void;
  onMicrosoftMailboxDisconnected: (
    callback: (result: { success: boolean }) => void,
  ) => () => void;
  // Pre-DB mailbox connection events (for collecting tokens before DB init)
  onGoogleMailboxPendingConnected: (
    callback: (result: {
      success: boolean;
      email?: string;
      tokens?: {
        access_token: string;
        refresh_token: string | null;
        expires_at: string;
        scopes: string;
      };
      error?: string;
    }) => void,
  ) => () => void;
  onGoogleMailboxPendingCancelled: (callback: () => void) => () => void;
  onMicrosoftMailboxPendingConnected: (
    callback: (result: {
      success: boolean;
      email?: string;
      tokens?: {
        access_token: string;
        refresh_token: string | null;
        expires_at: string;
        scopes: string;
      };
      error?: string;
    }) => void,
  ) => () => void;
  onMicrosoftMailboxPendingCancelled: (callback: () => void) => () => void;
  onGoogleLoginComplete: (
    callback: (result: {
      success: boolean;
      user?: User;
      sessionToken?: string;
      subscription?: Subscription;
      isNewUser?: boolean;
      pendingLogin?: boolean;
      error?: string;
    }) => void,
  ) => () => void;
  onMicrosoftLoginComplete: (
    callback: (result: {
      success: boolean;
      user?: User;
      sessionToken?: string;
      subscription?: Subscription;
      isNewUser?: boolean;
      pendingLogin?: boolean;
      error?: string;
    }) => void,
  ) => () => void;
  // Event listeners for pending login (OAuth succeeded but DB not initialized - login-first flow)
  onGoogleLoginPending: (
    callback: (result: {
      success: boolean;
      pendingLogin?: boolean;
      oauthData?: unknown;
      error?: string;
    }) => void,
  ) => () => void;
  onMicrosoftLoginPending: (
    callback: (result: {
      success: boolean;
      pendingLogin?: boolean;
      oauthData?: unknown;
      error?: string;
    }) => void,
  ) => () => void;
  // Event listeners for login cancelled (user closed popup window)
  onGoogleLoginCancelled: (callback: () => void) => () => void;
  onMicrosoftLoginCancelled: (callback: () => void) => () => void;
  /**
   * BACKLOG-1832: Fires when a background auto-sync starts for a specific transaction.
   * The renderer uses this to show a "fetching emails…" indicator.
   */
  onTransactionAutoSyncStarted: (
    callback: (data: { transactionId: string; reason: string }) => void,
  ) => () => void;

  /**
   * BACKLOG-1832: Fires when a background auto-sync completes for a specific transaction.
   * The renderer uses this to auto-refresh the email list and tab count badge.
   * ran=true means the sync actually fetched emails; ran=false means it was skipped/throttled.
   */
  onTransactionAutoSyncComplete: (
    callback: (data: { transactionId: string; reason: string; ran: boolean; windowsFetched?: number }) => void,
  ) => () => void;

  onTransactionScanProgress: (
    callback: (progress: unknown) => void,
  ) => () => void;
  onExportFolderProgress: (
    callback: (progress: FolderExportProgress) => void,
  ) => () => void;

  // ==========================================
  // DEEP LINK AUTH EVENTS (TASK-1500, enhanced TASK-1507)
  // ==========================================

  /**
   * Listen for deep link auth callback with tokens and license status
   * Fired when app receives keepr://callback and auth/license validation succeeds
   * TASK-1507: Enhanced to include user, license, and device data
   */
  onDeepLinkAuthCallback: (
    callback: (data: {
      accessToken: string;
      refreshToken: string;
      userId?: string;
      user?: {
        id: string;
        email?: string;
        name?: string;
      };
      licenseStatus?: {
        isValid: boolean;
        licenseType: "trial" | "individual" | "team";
        trialDaysRemaining?: number;
        transactionCount: number;
        transactionLimit: number;
        canCreateTransaction: boolean;
        deviceCount: number;
        deviceLimit: number;
        aiEnabled: boolean;
        blockReason?: string;
      };
      device?: {
        id: string;
        device_id: string;
        device_name: string | null;
      };
    }) => void,
  ) => () => void;

  /**
   * Listen for deep link auth errors
   * Fired when callback URL is invalid, tokens are missing, or auth fails
   */
  onDeepLinkAuthError: (
    callback: (data: { error: string; code: "MISSING_TOKENS" | "INVALID_URL" | "INVALID_TOKENS" | "UNKNOWN_ERROR" }) => void,
  ) => () => void;

  /**
   * Listen for the payment deep-link callback (BACKLOG-2015).
   * Fired when the app receives keepr://payment-callback?session=<id> after the
   * browser returns from Checkout / SCA. `sessionId` is UNTRUSTED (sanitized in
   * main) and is only used to poke the JWT-authed /status self-heal — the unlock
   * decision is the authoritative gate re-read.
   */
  onPaymentDeepLinkCallback: (
    callback: (data: { sessionId: string | null }) => void,
  ) => () => void;

  /**
   * Listen for deep link license blocked events (TASK-1507)
   * Fired when user authenticates successfully but license is expired/suspended
   */
  onDeepLinkLicenseBlocked: (
    callback: (data: {
      accessToken: string;
      refreshToken: string;
      userId: string;
      blockReason: string;
      licenseStatus: {
        isValid: boolean;
        licenseType: "trial" | "individual" | "team";
        blockReason?: string;
      };
    }) => void,
  ) => () => void;

  /**
   * Listen for deep link device limit events (TASK-1507)
   * Fired when user authenticates successfully but device registration fails due to limit
   */
  onDeepLinkDeviceLimit: (
    callback: (data: {
      accessToken: string;
      refreshToken: string;
      userId: string;
      licenseStatus: {
        isValid: boolean;
        licenseType: "trial" | "individual" | "team";
        deviceCount: number;
        deviceLimit: number;
      };
    }) => void,
  ) => () => void;
}
