/**
 * System Service
 *
 * Service abstraction for system-related API calls including permissions,
 * connections, health checks, and secure storage.
 * Centralizes all window.api.system calls and provides type-safe wrappers.
 */

import type { OAuthProvider } from "@/types";
import type { ConnectionErrorType } from "../../electron/services/connectionStatusService";
import type { HealthIssue } from "../../electron/types/ipc/healthIssue";
import { type ApiResult, getErrorMessage } from "./index";

/**
 * All permissions status
 */
export interface AllPermissions {
  fullDiskAccess: boolean;
  contactsAccess: boolean;
  allGranted: boolean;
}

/**
 * Permission result from backend
 */
interface PermissionResult {
  hasPermission: boolean;
  error?: string;
}

/**
 * Full permissions response from backend
 */
interface AllPermissionsResponse {
  allGranted: boolean;
  permissions: {
    fullDiskAccess?: PermissionResult;
    contacts?: PermissionResult;
  };
  errors: PermissionResult[];
}

/**
 * Provider connection status
 */
export interface ConnectionStatus {
  connected: boolean;
  email?: string;
}

/**
 * Structured connection error surfaced by connectionStatusService.
 * BACKLOG-2127: carried through so consumers can distinguish a broken
 * token (TOKEN_REFRESH_FAILED / TOKEN_EXPIRED / CONNECTION_CHECK_FAILED)
 * from a legitimately-absent connection (NOT_CONNECTED).
 */
export interface ProviderConnectionError {
  type: ConnectionErrorType;
  userMessage: string;
  action?: string;
  actionHandler?: string;
}

/**
 * Provider connection status including the structured error (BACKLOG-2127).
 */
export interface ProviderConnection {
  connected: boolean;
  email?: string;
  error?: ProviderConnectionError | null;
}

/**
 * All connections status
 */
export interface AllConnections {
  google?: ProviderConnection;
  microsoft?: ProviderConnection;
}

/**
 * Health check result
 */
export interface HealthCheck {
  healthy: boolean;
  provider?: OAuthProvider;
  /** BACKLOG-3230: objects, not strings. See electron/types/ipc/healthIssue.ts. */
  issues?: HealthIssue[];
}

export type { HealthIssue };

/**
 * Secure storage status
 */
export interface SecureStorageStatus {
  available: boolean;
  platform?: string;
  guidance?: string;
}

/**
 * Diagnostics information
 */
export interface Diagnostics {
  diagnostics: string;
}

/**
 * System Service
 * Provides a clean abstraction over window.api.system
 */
export const systemService = {
  // ============================================
  // PERMISSION METHODS
  // ============================================

  /**
   * BACKLOG-3208: Is Full Disk Access usable by THIS process right now?
   *
   * Wraps the existing `check-permissions` IPC — the same one the onboarding
   * `PermissionsStep` uses — so a Settings surface can ask the question without
   * a scattered `window.api` call. The handler resolves rather than throws on
   * a denial: `{ hasPermission: false, error: "EPERM: operation not
   * permitted, access '<home>/Library/Messages/chat.db'" }`.
   *
   * `hasPermission` is returned as `boolean | undefined` ON PURPOSE. The
   * three states are distinct and the caller must be able to tell them apart:
   * granted, denied, and "the check did not answer" (the IPC threw, or an
   * older/other producer omitted the field). Collapsing unknown into denied
   * would put a "you have not granted Full Disk Access" notice in front of
   * users who have.
   */
  async checkMessagesPermission(): Promise<
    ApiResult<{
      hasPermission: boolean | undefined;
      reason?: string;
      errorCode?: string;
    }>
  > {
    try {
      const result = await window.api.system.checkPermissions();
      return {
        success: true,
        data: {
          hasPermission:
            typeof result?.hasPermission === "boolean"
              ? result.hasPermission
              : undefined,
          reason: result?.error,
          // BACKLOG-3213: WHICH failure, carried through unchanged. A caller
          // that ignores it sees exactly the previous behaviour; the panel
          // uses it to tell "Full Disk Access is refused" from "there is no
          // Messages database on this Mac", which need opposite sentences.
          errorCode: result?.errorCode,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * BACKLOG-3208: Open the macOS Full Disk Access pane, with Keepr already
   * listed in it.
   *
   * Both calls, in this order, are the working sequence from
   * `PermissionsStep.handleOpenSystemSettings` and are reused verbatim rather
   * than re-derived:
   *   1. `triggerFullDiskAccess()` reads `~/Library/Messages/chat.db`, which is
   *      what makes macOS add Keepr to the Full Disk Access list. Without it the
   *      pane can open with no Keepr row to switch on. It is idempotent, and
   *      BACKLOG-2192 established that re-firing it on every open is both safe
   *      and necessary (a single mount-time trigger sometimes had not landed in
   *      the pane by the time the user looked).
   *   2. `openSystemSettings()` opens the pane itself.
   *
   * Step 1 is best-effort: if the trigger fails the pane is still opened, which
   * is strictly better than refusing to open it.
   */
  async openFullDiskAccessSettings(): Promise<ApiResult> {
    try {
      try {
        await window.api.system.triggerFullDiskAccess();
      } catch {
        // Non-fatal: the pane is still worth opening, the user can add Keepr
        // with the "+" button. Swallowing is the intended behaviour here and
        // the reason is this comment, not an empty block.
      }
      const result = await window.api.system.openSystemSettings();
      return { success: result?.success !== false };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * BACKLOG-3208: Relaunch the app cleanly (no data wipe) so a freshly granted
   * Full Disk Access actually takes effect.
   *
   * macOS caches the sandbox/TCC decision per-process at launch, so a process
   * that was denied `chat.db` does not gain access when the toggle is flipped
   * under it — this is the premise BACKLOG-1842 was built on. `relaunched` is
   * `false` when the main-process handler suppressed the relaunch (the
   * `!app.isPackaged && KEEPR_E2E=1` gate), which callers must handle rather
   * than assuming the process is about to exit.
   */
  async relaunchApp(): Promise<ApiResult<{ relaunched: boolean }>> {
    try {
      const result = await window.api.system.relaunchApp();
      return { success: true, data: { relaunched: result?.relaunched === true } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Run the permission setup wizard
   */
  async runPermissionSetup(): Promise<ApiResult> {
    try {
      const result = await window.api.system.runPermissionSetup();
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Request contacts permission
   */
  async requestContactsPermission(): Promise<ApiResult<{ granted: boolean }>> {
    try {
      const result = await window.api.system.requestContactsPermission();
      return { success: true, data: { granted: result.granted } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Setup full disk access
   */
  async setupFullDiskAccess(): Promise<ApiResult> {
    try {
      const result = await window.api.system.setupFullDiskAccess();
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Open system privacy pane
   */
  async openPrivacyPane(pane: string): Promise<ApiResult> {
    try {
      const result = await window.api.system.openPrivacyPane(pane);
      return { success: result.success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check full disk access status
   */
  async checkFullDiskAccessStatus(): Promise<ApiResult<{ hasAccess: boolean }>> {
    try {
      const result = await window.api.system.checkFullDiskAccessStatus();
      return { success: true, data: { hasAccess: result.hasAccess } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check full disk access (alias)
   */
  async checkFullDiskAccess(): Promise<ApiResult<{ hasAccess: boolean }>> {
    try {
      const result = await window.api.system.checkFullDiskAccess();
      return { success: true, data: { hasAccess: result.hasAccess } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check contacts permission
   */
  async checkContactsPermission(): Promise<ApiResult<{ hasPermission: boolean }>> {
    try {
      const result = await window.api.system.checkContactsPermission();
      return { success: true, data: { hasPermission: result.hasPermission } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check all permissions at once
   */
  async checkAllPermissions(): Promise<ApiResult<AllPermissions>> {
    try {
      const result = await window.api.system.checkAllPermissions() as AllPermissionsResponse;
      return {
        success: true,
        data: {
          fullDiskAccess: result.permissions?.fullDiskAccess?.hasPermission ?? false,
          contactsAccess: result.permissions?.contacts?.hasPermission ?? false,
          allGranted: result.allGranted,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // CONNECTION METHODS
  // ============================================

  /**
   * Check Google connection status
   */
  async checkGoogleConnection(userId: string): Promise<ApiResult<ConnectionStatus>> {
    try {
      const result = await window.api.system.checkGoogleConnection(userId);
      return {
        success: true,
        data: {
          connected: result.connected,
          email: result.email,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check Microsoft connection status
   */
  async checkMicrosoftConnection(
    userId: string
  ): Promise<ApiResult<ConnectionStatus>> {
    try {
      const result = await window.api.system.checkMicrosoftConnection(userId);
      return {
        success: true,
        data: {
          connected: result.connected,
          email: result.email,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check all email provider connections
   */
  async checkAllConnections(userId: string): Promise<ApiResult<AllConnections>> {
    try {
      const result = await window.api.system.checkAllConnections(userId);
      if (result.success) {
        return {
          success: true,
          data: {
            // BACKLOG-2127: preserve the structured `error` so consumers
            // (e.g. useAutoRefresh) can read error.type and distinguish a
            // broken token from a legitimately-disconnected provider.
            google: result.google,
            microsoft: result.microsoft,
          },
        };
      }
      return { success: false, error: "Failed to check connections" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Run health check for a provider
   */
  async healthCheck(
    userId: string,
    provider: OAuthProvider
  ): Promise<ApiResult<HealthCheck>> {
    try {
      const result = await window.api.system.healthCheck(userId, provider);
      return {
        success: true,
        data: {
          healthy: result.healthy,
          provider: result.provider,
          issues: result.issues,
        },
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // SECURE STORAGE METHODS
  // ============================================

  /**
   * Get secure storage (keychain) status
   */
  async getSecureStorageStatus(): Promise<ApiResult<SecureStorageStatus>> {
    try {
      const result = await window.api.system.getSecureStorageStatus();
      if (result.success) {
        return {
          success: true,
          data: {
            available: result.available,
            platform: result.platform,
            guidance: result.guidance,
          },
        };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Initialize secure storage (keychain)
   */
  async initializeSecureStorage(): Promise<ApiResult<SecureStorageStatus>> {
    try {
      const result = await window.api.system.initializeSecureStorage();
      if (result.success) {
        return {
          success: true,
          data: {
            available: result.available,
            platform: result.platform,
            guidance: result.guidance,
          },
        };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if encryption key store exists
   */
  async hasEncryptionKeyStore(): Promise<ApiResult<{ hasKeyStore: boolean }>> {
    try {
      const result = await window.api.system.hasEncryptionKeyStore();
      if (result.success) {
        return { success: true, data: { hasKeyStore: result.hasKeyStore } };
      }
      return { success: false, error: "Failed to check key store" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // DATABASE METHODS
  // ============================================

  /**
   * Initialize the database
   */
  async initializeDatabase(): Promise<ApiResult> {
    try {
      const result = await window.api.system.initializeDatabase();
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Check if database is initialized
   */
  async isDatabaseInitialized(): Promise<ApiResult<{ initialized: boolean }>> {
    try {
      const result = await window.api.system.isDatabaseInitialized();
      if (result.success) {
        return { success: true, data: { initialized: result.initialized } };
      }
      return { success: false, error: "Failed to check database status" };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  // ============================================
  // SUPPORT METHODS
  // ============================================

  /**
   * Contact support with optional error details
   */
  async contactSupport(errorDetails?: string): Promise<ApiResult> {
    try {
      const result = await window.api.system.contactSupport(errorDetails);
      return { success: result.success, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },

  /**
   * Get system diagnostics
   */
  async getDiagnostics(): Promise<ApiResult<Diagnostics>> {
    try {
      const result = await window.api.system.getDiagnostics();
      if (result.success && result.diagnostics) {
        return { success: true, data: { diagnostics: result.diagnostics } };
      }
      return { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  },
};

export default systemService;
