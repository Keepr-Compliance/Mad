/**
 * Authentication Bridge
 * Handles user authentication, OAuth flows, and session management
 */

import { ipcRenderer } from "electron";

export const authBridge = {
  /**
   * Initiates Google OAuth login flow
   * @returns Login initiation result
   */
  googleLogin: () => ipcRenderer.invoke("auth:google:login"),

  /**
   * Completes Google OAuth login with authorization code
   * @param code - OAuth authorization code from Google
   * @returns Login completion result
   */
  googleCompleteLogin: (code: string) =>
    ipcRenderer.invoke("auth:google:complete-login", code),

  /**
   * Initiates Microsoft OAuth login flow
   * @returns Login initiation result
   */
  microsoftLogin: () => ipcRenderer.invoke("auth:microsoft:login"),

  /**
   * Completes Microsoft OAuth login with authorization code
   * @param code - OAuth authorization code from Microsoft
   * @returns Login completion result
   */
  microsoftCompleteLogin: (code: string) =>
    ipcRenderer.invoke("auth:microsoft:complete-login", code),

  /**
   * Connects Google mailbox for a logged-in user
   * @param userId - User ID to connect mailbox for
   * @returns Connection result
   */
  googleConnectMailbox: (userId: string) =>
    ipcRenderer.invoke("auth:google:connect-mailbox", userId),

  /**
   * Connects Microsoft mailbox for a logged-in user
   * @param userId - User ID to connect mailbox for
   * @returns Connection result
   */
  microsoftConnectMailbox: (userId: string) =>
    ipcRenderer.invoke("auth:microsoft:connect-mailbox", userId),

  /**
   * Disconnects Google mailbox for a logged-in user
   * @param userId - User ID to disconnect mailbox for
   * @returns Disconnection result
   */
  googleDisconnectMailbox: (userId: string) =>
    ipcRenderer.invoke("auth:google:disconnect-mailbox", userId),

  /**
   * Disconnects Microsoft mailbox for a logged-in user
   * @param userId - User ID to disconnect mailbox for
   * @returns Disconnection result
   */
  microsoftDisconnectMailbox: (userId: string) =>
    ipcRenderer.invoke("auth:microsoft:disconnect-mailbox", userId),

  /**
   * Logs out the current user and invalidates session
   * @param sessionToken - Session token to invalidate
   * @returns Logout result
   */
  logout: (sessionToken: string) =>
    ipcRenderer.invoke("auth:logout", sessionToken),

  /**
   * Force logout - clears all local sessions without requiring a token
   * Used when user is stuck (e.g., license blocked during login)
   * @returns Logout result
   */
  forceLogout: () => ipcRenderer.invoke("auth:force-logout"),

  /**
   * TASK-2045: Sign out of all devices (global session invalidation)
   * Invalidates all active Supabase sessions across all devices,
   * then clears the local session. User will need to log in again.
   * @returns Sign-out result
   */
  signOutAllDevices: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("session:sign-out-all-devices"),

  /**
   * Validates an existing session token
   * @param sessionToken - Session token to validate
   * @returns Validation result
   */
  validateSession: (sessionToken: string) =>
    ipcRenderer.invoke("auth:validate-session", sessionToken),

  /**
   * Gets the currently authenticated user
   * @returns Current user data
   */
  getCurrentUser: () => ipcRenderer.invoke("auth:get-current-user"),

  /**
   * Records user's acceptance of terms and conditions
   * @param userId - User ID accepting terms
   * @returns Acceptance result
   */
  acceptTerms: (userId: string) =>
    ipcRenderer.invoke("auth:accept-terms", userId),

  /**
   * Accept terms directly to Supabase (pre-DB onboarding flow)
   * Used when user accepts terms before local database is initialized
   * @param userId - User ID accepting terms
   * @returns Acceptance result
   */
  acceptTermsToSupabase: (userId: string) =>
    ipcRenderer.invoke("auth:accept-terms-to-supabase", userId),

  /**
   * Marks email onboarding as completed for a user
   * @param userId - User ID completing email onboarding
   * @returns Completion result
   */
  completeEmailOnboarding: (userId: string) =>
    ipcRenderer.invoke("auth:complete-email-onboarding", userId),

  /**
   * Completes a pending login after keychain/database setup
   * Called when OAuth succeeded but database wasn't initialized yet
   * @param oauthData - The pending OAuth data from login-pending event
   * @returns Login completion result
   */
  completePendingLogin: (oauthData: unknown) =>
    ipcRenderer.invoke("auth:complete-pending-login", oauthData),

  /**
   * Pre-DB Google mailbox connection (returns tokens instead of saving to DB)
   * Used during onboarding before database is initialized
   * @param emailHint - Optional email hint for pre-filling the login
   * @returns Connection initiation result
   */
  googleConnectMailboxPending: (emailHint?: string) =>
    ipcRenderer.invoke("auth:google:connect-mailbox-pending", emailHint),

  /**
   * Pre-DB Microsoft mailbox connection (returns tokens instead of saving to DB)
   * Used during onboarding before database is initialized
   * @param emailHint - Optional email hint for pre-filling the login
   * @returns Connection initiation result
   */
  microsoftConnectMailboxPending: (emailHint?: string) =>
    ipcRenderer.invoke("auth:microsoft:connect-mailbox-pending", emailHint),

  /**
   * Saves pending mailbox tokens after database is initialized
   * @param data - Token data including userId, provider, email, and tokens
   * @returns Save result
   */
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
  }) => ipcRenderer.invoke("auth:save-pending-mailbox-tokens", data),

  /**
   * DEV ONLY: Expire a mailbox token for testing Connection Issue state
   * @param userId - User ID
   * @param provider - OAuth provider (google | microsoft)
   */
  devExpireMailboxToken: (userId: string, provider: "google" | "microsoft") =>
    ipcRenderer.invoke("auth:dev:expire-mailbox-token", userId, provider),

  /**
   * DEV ONLY: Reset onboarding for testing the onboarding flow
   * Clears email_onboarding_completed_at and mobile_phone_type
   * @param userId - User ID to reset
   */
  devResetOnboarding: (userId: string) =>
    ipcRenderer.invoke("auth:dev:reset-onboarding", userId),

  // ==========================================
  // DEEP LINK AUTH (TASK-1507)
  // ==========================================

  /**
   * Opens the Supabase auth URL in the default browser
   * Used for deep-link authentication flow where OAuth completes in browser
   * and redirects back to app via keepr://callback
   * @returns Success status
   */
  openAuthInBrowser: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("auth:open-in-browser"),

  // ==========================================
  // PRE-DB AUTH VALIDATION (TASK-2086)
  // ==========================================

  /**
   * Validate auth session before database decryption (SOC 2 CC6.1).
   * Checks Supabase auth.getUser() without requiring the encrypted DB.
   * Returns { valid: true, noSession: true } if no session exists (new user).
   */
  preValidateSession: (): Promise<{
    valid: boolean;
    noSession?: boolean;
    reason?: string;
  }> => ipcRenderer.invoke("pre-auth:validate-session"),

  // ==========================================
  // SESSION MANAGEMENT (TASK-2062)
  // ==========================================

  /**
   * Validate remote session by checking Supabase auth.getUser().
   * Returns { valid: false } if the session has been invalidated remotely.
   * Returns { valid: true } on network errors to avoid false logouts.
   */
  validateRemoteSession: (): Promise<{ valid: boolean }> =>
    ipcRenderer.invoke("session:validate-remote"),

  /**
   * BACKLOG-3833: report real user input (keyboard, pointer, wheel, touch).
   * No arguments: main loads the session itself, checks it is still valid,
   * and only then records the activity.
   */
  reportUserActivity: (): Promise<void> =>
    ipcRenderer.invoke("session:user-activity"),

  /**
   * BACKLOG-3833: main signed the session out for inactivity.
   * @returns unsubscribe
   */
  onIdleSessionExpired: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("session:idle-expired", listener);
    return () => ipcRenderer.removeListener("session:idle-expired", listener);
  },

  /**
   * Get active devices for the current user.
   * Returns list of devices with device name, OS, last active time,
   * and whether each device is the current one.
   * @param userId - User ID to get devices for
   */
  getActiveDevices: (userId: string): Promise<{
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
  }> => ipcRenderer.invoke("session:get-active-devices", userId),
};
