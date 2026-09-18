/**
 * WindowApi Auth sub-interface
 * Authentication methods exposed to renderer process
 */

import type { User, Subscription } from "../models";

/**
 * BACKLOG-3206 — what the disconnect did about the provider's grant.
 *
 * Disconnecting a mailbox used to delete the local token row and stop there,
 * which left the provider-side grant intact. The disconnect now asks the
 * provider to end that grant first, and this is what came back:
 *
 * - `revoked`         the provider confirmed the grant is gone
 * - `already-invalid` the provider says the token was already dead, which is
 *                     the same end state
 * - `no-token`        the row held nothing to send, so there was nothing to end
 * - `unsupported`     the provider publishes no way for an app to end its own
 *                     access (Microsoft)
 * - `failed`          we asked and did not get a confirmation
 * - `read-failed`     we could not read the token row, so we could not ask.
 *                     NOT the same as `no-token`: there may well have been a
 *                     token. Google-only by construction — the Microsoft path
 *                     never reaches the read.
 *
 * The local row is deleted either way, so `success` is about the disconnect and
 * this field is about the grant. They are separate facts and are reported
 * separately.
 */
export type MailboxRevokeOutcome =
  | "revoked"
  | "already-invalid"
  | "no-token"
  | "unsupported"
  | "failed"
  | "read-failed";

/**
 * Why a `failed` outcome failed. `network` means nothing came back at all
 * (timeout, DNS, reset); `rejected` means the provider answered and the answer
 * was not a confirmation.
 */
export type MailboxRevokeReason = "network" | "rejected";

/**
 * What `auth:{provider}:disconnect-mailbox` resolves to.
 */
export interface DisconnectMailboxResult {
  success: boolean;
  error?: string;
  revokeOutcome?: MailboxRevokeOutcome;
  revokeReason?: MailboxRevokeReason;
}

/**
 * Auth methods on window.api
 */
export interface WindowApiAuth {
  googleLogin: () => Promise<{
    success: boolean;
    authUrl?: string;
    error?: string;
  }>;
  googleCompleteLogin: (code: string) => Promise<{
    success: boolean;
    user?: User;
    sessionToken?: string;
    subscription?: Subscription;
    isNewUser?: boolean;
    error?: string;
  }>;
  microsoftLogin: () => Promise<{
    success: boolean;
    authUrl?: string;
    error?: string;
  }>;
  microsoftCompleteLogin: (code: string) => Promise<{
    success: boolean;
    user?: User;
    sessionToken?: string;
    subscription?: Subscription;
    isNewUser?: boolean;
    error?: string;
  }>;
  googleConnectMailbox: (
    userId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  microsoftConnectMailbox: (
    userId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  googleDisconnectMailbox: (userId: string) => Promise<DisconnectMailboxResult>;
  microsoftDisconnectMailbox: (
    userId: string,
  ) => Promise<DisconnectMailboxResult>;
  logout: (
    sessionToken: string,
  ) => Promise<{ success: boolean; error?: string }>;
  forceLogout: () => Promise<{ success: boolean; error?: string }>;
  validateSession: (
    sessionToken: string,
  ) => Promise<{ valid: boolean; user?: User; error?: string }>;
  getCurrentUser: () => Promise<{
    success: boolean;
    user?: User;
    sessionToken?: string;
    subscription?: Subscription;
    provider?: string;
    isNewUser?: boolean;
    error?: string;
    // BACKLOG-2149: DB still starting up — renderer should retry, not fail hard.
    transient?: boolean;
    retryable?: boolean;
  }>;
  acceptTerms: (
    userId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  completeEmailOnboarding: (
    userId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  checkEmailOnboarding: (
    userId: string,
  ) => Promise<{
    success: boolean;
    completed: boolean;
    error?: string;
    // BACKLOG-1842 (startup-resilience follow-up): DB still starting up —
    // caller should retry, not treat as terminal.
    transient?: boolean;
    retryable?: boolean;
  }>;
  // Complete pending login after keychain setup (login-first flow)
  completePendingLogin: (oauthData: unknown) => Promise<{
    success: boolean;
    user?: User;
    sessionToken?: string;
    subscription?: Subscription;
    isNewUser?: boolean;
    error?: string;
  }>;
  // Pre-DB mailbox connection (returns tokens instead of saving to DB)
  googleConnectMailboxPending: (
    emailHint?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  microsoftConnectMailboxPending: (
    emailHint?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  // Save pending mailbox tokens after DB initialization
  savePendingMailboxTokens: (data: {
    userId: string;
    provider: "google" | "microsoft";
    email: string;
    tokens: {
      access_token: string;
      refresh_token: string | null;
      expires_at: string;
      scopes: string;
    };
  }) => Promise<{ success: boolean; error?: string }>;

  // TASK-1507: Deep link browser auth
  /**
   * Opens Supabase auth URL in the default browser
   * Used for deep-link authentication flow
   */
  openAuthInBrowser: () => Promise<{ success: boolean; error?: string }>;
  // TASK-2045: Sign out of all devices (global session invalidation)
  signOutAllDevices: () => Promise<{ success: boolean; error?: string }>;

  // TASK-2062: Remote session validation
  validateRemoteSession: () => Promise<{ valid: boolean }>;

  // TASK-2062: Active devices list
  getActiveDevices: (userId: string) => Promise<{
    success: boolean;
    devices?: Array<{
      device_id: string;
      device_name: string;
      os: string;
      platform: string;
      last_seen_at: string;
      isCurrentDevice: boolean;
    }>;
    error?: string;
  }>;
}
