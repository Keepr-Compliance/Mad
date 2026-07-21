/**
 * WindowApi Auth sub-interface
 * Authentication methods exposed to renderer process
 */

import type { User, Subscription } from "../models";

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
  googleDisconnectMailbox: (
    userId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  microsoftDisconnectMailbox: (
    userId: string,
  ) => Promise<{ success: boolean; error?: string }>;
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
