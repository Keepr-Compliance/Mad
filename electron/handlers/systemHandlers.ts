// ============================================
// SYSTEM IPC HANDLERS
// Handles: secure storage, database init, permissions, connections,
//          shell operations, support
// ============================================

import { ipcMain, shell, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import os from "os";
// These 3 services use require() instead of ES imports because
// the test mocks (system-handlers.test.ts) don't set __esModule: true.
// Converting to ES imports would cause __importDefault wrapping mismatch.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const permissionService = require("../services/permissionService").default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectionStatusService = require("../services/connectionStatusService").default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const macOSPermissionHelper = require("../services/macOSPermissionHelper").default;
import { databaseEncryptionService } from "../services/databaseEncryptionService";
import databaseService from "../services/databaseService";
import supabaseService from "../services/supabaseService";
import sessionService from "../services/sessionService";
import { initializationBroadcaster } from "../services/initializationBroadcaster";
import { initializeDatabase } from "./authHandlers";
import { getAndClearPendingDeepLinkUser } from "../main";
import { initializePool } from "../workers/contactWorkerPool";
import { getDbPath, getEncryptionKey } from "../services/db/core/dbConnection";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import logService from "../services/logService";
import failureLogService from "../services/failureLogService";
import { wrapHandler } from "../utils/wrapHandler";
import {
  ValidationError,
  validateUserId,
  validateString,
} from "../utils/validation";
import { redactId } from "../utils/redactSensitive";
import type { User, OAuthProvider } from "../types/models";

// ============================================
// SHARED STATE
// ============================================

// Guard to prevent multiple concurrent initializations
let isInitializing = false;
let initializationComplete = false;
let handlersRegistered = false;

/**
 * Check if database initialization is complete.
 * Exported for use by userSettingsHandlers.
 */
export function isInitializationComplete(): boolean {
  return initializationComplete;
}

// ============================================
// TYPE DEFINITIONS
// ============================================

interface SystemResponse {
  success: boolean;
  error?:
    | string
    | {
        type: string;
        userMessage: string;
        details?: string;
      };
}

interface PermissionResponse extends SystemResponse {
  hasPermission?: boolean;
  granted?: boolean;
  overallSuccess?: boolean;
}

interface ConnectionResponse extends SystemResponse {
  connected?: boolean;
  error?: {
    type: string;
    userMessage: string;
    details?: string;
  };
}

interface SecureStorageResponse extends SystemResponse {
  available: boolean;
  platform?: string;
  guidance?: string;
}

// ============================================
// SHARED HELPERS
// ============================================

/**
 * Get platform-specific guidance for resolving secure storage issues
 */
function getSecureStorageGuidance(platform: string): string {
  switch (platform) {
    case "darwin":
      return `To enable secure storage on macOS:
1. When the Keychain Access prompt appears, click "Allow" or "Always Allow"
2. If you clicked "Deny", you may need to:
   - Open Keychain Access (in Applications > Utilities)
   - Find "Keepr Safe Storage"
   - Right-click and select "Delete"
   - Then restart Keepr and click "Allow"`;
    case "win32":
      return `Windows should automatically provide secure storage via DPAPI.
If you're seeing this error:
1. Try restarting the application
2. Run as administrator if the issue persists
3. Check Windows Event Viewer for credential-related errors`;
    case "linux":
      return `Linux requires a secret service to be running:
1. Install gnome-keyring: sudo apt install gnome-keyring
2. Ensure it's running: eval $(gnome-keyring-daemon --start --components=secrets)
3. Or install KWallet if using KDE: sudo apt install kwalletmanager`;
    default:
      return "Please ensure your operating system's credential storage service is available and running.";
  }
}

/**
 * Creates a local user from cloud user data (Supabase users table).
 * Uses the existing User type which has all required fields.
 *
 * IMPORTANT: Normalizes "azure" to "microsoft" because:
 * - Supabase Auth uses "azure" for Microsoft OAuth
 * - Local SQLite CHECK constraint only allows 'google' or 'microsoft'
 */
async function createLocalUserFromCloud(cloudUser: User): Promise<void> {
  // Normalize provider: "azure" -> "microsoft" for local DB compatibility
  // Local SQLite has CHECK (oauth_provider IN ('google', 'microsoft'))
  let provider: OAuthProvider = cloudUser.oauth_provider || "microsoft";
  if (provider === "azure") {
    provider = "microsoft";
    logService.debug(
      "createLocalUserFromCloud: Normalized 'azure' to 'microsoft'",
      "System",
      { userId: cloudUser.id.substring(0, 8) + "..." }
    );
  }

  if (!cloudUser.oauth_provider) {
    logService.warn(
      "createLocalUserFromCloud: oauth_provider missing from cloud user, using default",
      "System",
      { defaultProvider: provider, userId: cloudUser.id.substring(0, 8) + "..." }
    );
  }

  await databaseService.createUser({
    id: cloudUser.id,
    email: cloudUser.email,
    display_name: cloudUser.display_name || cloudUser.email.split("@")[0],
    avatar_url: cloudUser.avatar_url,
    oauth_provider: provider,
    oauth_id: cloudUser.id,
    subscription_tier: cloudUser.subscription_tier || "free",
    subscription_status: cloudUser.subscription_status || "trial",
    trial_ends_at: cloudUser.trial_ends_at,
    is_active: true,
  });
}

/**
 * BACKLOG-2173b: Persist a durable session (SQLite session row + encrypted
 * userData/session.json) for a local user, including the Supabase
 * access/refresh tokens needed to restore the SDK session after a restart.
 *
 * Mirrors the "DB already initialized" success path in main.ts's deep-link
 * callback (main.ts ~L693-726) so that both the fast path (DB ready at login)
 * and the deferred path (DB not ready at login -- fresh macOS profile, this
 * function's caller) end up with the exact same on-disk session shape.
 *
 * Root cause this closes: on a fresh profile the Supabase JS client is
 * `persistSession: false` with an in-memory-only storage adapter
 * (supabaseService.ts) -- session.json is the ONLY durable store. Before this
 * fix, the deferred-DB branch never called sessionService.saveSession(), so
 * the session lived only in the running process's RAM and was lost the
 * instant BACKLOG-2173's app.relaunch() restarted the process (FDA grant
 * flow), dumping the user to a failed login screen instead of the dashboard.
 *
 * Best-effort: errors are logged (with tokens redacted, never logged in
 * plaintext) and swallowed -- a failure here must not block onboarding, same
 * posture as the main.ts equivalent.
 */
async function persistSessionForUser(
  localUser: User,
  provider: OAuthProvider,
  tokens: { accessToken: string; refreshToken: string },
): Promise<void> {
  try {
    const sessionToken = await databaseService.createSession(localUser.id);

    const subscriptionStatus = localUser.subscription_status || "trial";
    const isTrial = subscriptionStatus === "trial";
    const isActive = subscriptionStatus === "active" || subscriptionStatus === "trial";

    await sessionService.saveSession({
      user: localUser,
      sessionToken,
      provider,
      subscription: {
        tier: localUser.subscription_tier || "free",
        status: subscriptionStatus,
        isActive,
        isTrial,
        trialEnded: subscriptionStatus === "expired",
        trialDaysRemaining: 0,
      },
      expiresAt: Date.now() + sessionService.getSessionExpirationMs(),
      createdAt: Date.now(),
      // Required for RLS-protected operations on app restart (Dorian's T&C fix)
      supabaseTokens: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      },
    });
    logService.info(
      "[DeepLink] Session persisted for deferred-DB user (BACKLOG-2173b)",
      "System",
      { userId: redactId(localUser.id) },
    );
  } catch (sessionError) {
    logService.error(
      "[DeepLink] Failed to persist session for deferred-DB user",
      "System",
      { error: sessionError instanceof Error ? sessionError.message : String(sessionError) },
    );
  }
}

/**
 * Verifies user exists in local DB, creates if missing.
 * Fetches user data from Supabase cloud if needed.
 * Exported for use by userSettingsHandlers (verify-user-in-local-db).
 */
export async function ensureUserInLocalDb(): Promise<{ success: boolean; userId?: string; error?: string }> {
  Sentry.addBreadcrumb({
    category: "onboarding",
    message: "ensureUserInLocalDb: called",
    level: "info",
  });

  let authSession;
  try {
    authSession = await supabaseService.getAuthSession();
  } catch (sessionError) {
    const errorMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
    logService.error("ensureUserInLocalDb: getAuthSession threw", "System", { error: errorMsg });
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: getAuthSession threw",
      level: "error",
      data: { error: errorMsg },
    });
    return { success: false, error: `Session fetch failed: ${errorMsg}` };
  }

  if (!authSession?.userId) {
    logService.warn("ensureUserInLocalDb: No auth session", "System");
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: no auth session",
      level: "warning",
      data: { hasSession: !!authSession, hasUserId: !!authSession?.userId },
    });
    return { success: false, error: "No auth session found" };
  }

  const userId = authSession.userId;
  const userIdShort = userId.substring(0, 8) + "...";

  Sentry.addBreadcrumb({
    category: "onboarding",
    message: "ensureUserInLocalDb: checking local DB",
    level: "info",
    data: { userId: userIdShort },
  });

  let localUser;
  try {
    localUser = await databaseService.getUserById(userId);
  } catch (dbLookupError) {
    const errorMsg = dbLookupError instanceof Error ? dbLookupError.message : String(dbLookupError);
    logService.error("ensureUserInLocalDb: getUserById threw", "System", { error: errorMsg });
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: local DB lookup failed",
      level: "error",
      data: { error: errorMsg, userId: userIdShort },
    });
    return { success: false, error: `Local DB lookup failed: ${errorMsg}` };
  }

  if (localUser) {
    logService.debug("ensureUserInLocalDb: User already exists", "System", { userId: userIdShort });
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: user already exists in local DB",
      level: "info",
      data: { userId: userIdShort },
    });
    return { success: true, userId };
  }

  // User doesn't exist - fetch from Supabase cloud and create locally
  logService.info("ensureUserInLocalDb: User not in local DB, fetching from Supabase", "System", {
    userId: userIdShort,
  });

  Sentry.addBreadcrumb({
    category: "onboarding",
    message: "ensureUserInLocalDb: fetching from Supabase cloud",
    level: "info",
    data: { userId: userIdShort },
  });

  let cloudUser;
  try {
    cloudUser = await supabaseService.getUserById(userId);
  } catch (fetchError) {
    const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
    logService.error("ensureUserInLocalDb: Supabase fetch threw", "System", { error: errorMsg });
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: Supabase profile fetch failed",
      level: "error",
      data: {
        error: errorMsg,
        userId: userIdShort,
        isTimeout: errorMsg.includes("timeout") || errorMsg.includes("ETIMEDOUT"),
        isRLS: errorMsg.includes("policy") || errorMsg.includes("permission") || errorMsg.includes("RLS"),
      },
    });
    return { success: false, error: `Cloud profile fetch failed: ${errorMsg}` };
  }

  logService.debug("ensureUserInLocalDb: Cloud user result", "System", {
    found: !!cloudUser,
    provider: cloudUser?.oauth_provider,
  });

  Sentry.addBreadcrumb({
    category: "onboarding",
    message: `ensureUserInLocalDb: cloud user ${cloudUser ? "found" : "NOT found"}`,
    level: cloudUser ? "info" : "warning",
    data: {
      found: !!cloudUser,
      provider: cloudUser?.oauth_provider,
      userId: userIdShort,
    },
  });

  if (!cloudUser) {
    logService.error("ensureUserInLocalDb: User not found in Supabase cloud", "System");
    return { success: false, error: "User not found in cloud database (profile may not exist yet)" };
  }

  // Create user in local DB using consolidated helper
  try {
    logService.debug("ensureUserInLocalDb: Creating local user", "System", {
      provider: cloudUser.oauth_provider,
    });
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: creating local user",
      level: "info",
      data: { provider: cloudUser.oauth_provider, userId: userIdShort },
    });
    await createLocalUserFromCloud(cloudUser);
    logService.debug("ensureUserInLocalDb: User created successfully", "System");
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: local user created",
      level: "info",
      data: { userId: userIdShort },
    });
  } catch (createError) {
    const errorMsg = createError instanceof Error ? createError.message : String(createError);
    logService.error("ensureUserInLocalDb: Failed to create user", "System", {
      error: errorMsg,
    });
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: local user creation failed",
      level: "error",
      data: {
        error: errorMsg,
        userId: userIdShort,
        isConstraint: errorMsg.includes("CHECK") || errorMsg.includes("constraint"),
        isBusy: errorMsg.includes("BUSY") || errorMsg.includes("locked"),
        isDiskFull: errorMsg.includes("FULL") || errorMsg.includes("disk") || errorMsg.includes("SQLITE_FULL"),
      },
    });
    return { success: false, error: `Failed to create user: ${errorMsg}` };
  }

  // Verify creation succeeded
  localUser = await databaseService.getUserById(userId);

  if (!localUser) {
    logService.error("ensureUserInLocalDb: User creation verification failed", "System");
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: "ensureUserInLocalDb: user creation verification failed (created but not found)",
      level: "error",
      data: { userId: userIdShort },
    });
    return { success: false, error: "User creation verification failed" };
  }

  logService.info("ensureUserInLocalDb: User created successfully", "System", { userId: userIdShort });
  return { success: true, userId };
}

// ============================================
// HANDLER REGISTRATION
// ============================================

/**
 * Register all system and permission-related IPC handlers
 */
export function registerSystemHandlers(): void {
  // Prevent double registration (can happen during hot-reload or app reactivation)
  if (handlersRegistered) {
    logService.warn(
      "System handlers already registered, skipping duplicate registration",
      "System",
    );
    return;
  }
  handlersRegistered = true;

  // ===== SECURE STORAGE (KEYCHAIN) SETUP =====

  /**
   * Get secure storage status without triggering keychain prompt
   * Now checks database encryption status (session-only OAuth, no token encryption)
   */
  ipcMain.handle(
    "system:get-secure-storage-status",
    wrapHandler(async (): Promise<SecureStorageResponse> => {
      // Check if database encryption key store exists (file check, no keychain prompt)
      const hasKeyStore = databaseEncryptionService.hasKeyStore();
      return {
        success: true,
        available: hasKeyStore,
        platform: os.platform(),
      };
    }, { module: "System" }),
  );

  /**
   * Initialize secure storage (database only)
   *
   * Since we use session-only OAuth (tokens not persisted), we only need
   * to initialize the database encryption. This triggers ONE keychain prompt
   * for the database encryption key.
   *
   * OAuth tokens are kept in memory only - users login each session.
   * This is more secure and avoids multiple keychain prompts.
   */
  ipcMain.handle(
    "system:initialize-secure-storage",
    async (): Promise<SecureStorageResponse> => {
      logService.debug("DB_INIT handler called", "System", {
        initializationComplete,
        isInitializing,
      });
      // If already initialized, return immediately
      if (initializationComplete) {
        logService.debug(
          "Database already initialized, skipping",
          "System",
        );
        return {
          success: true,
          available: true,
          platform: os.platform(),
        };
      }

      // If initialization is in progress, wait for it to complete
      if (isInitializing) {
        logService.debug(
          "Database initialization already in progress, waiting...",
          "System",
        );
        // Wait for current initialization to complete (poll every 100ms)
        let waitCount = 0;
        while (isInitializing && waitCount < 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
        return {
          success: initializationComplete,
          available: initializationComplete,
          platform: os.platform(),
          error: initializationComplete ? undefined : "Initialization timeout",
        };
      }

      isInitializing = true;
      const t0 = Date.now();
      try {
        // Initialize database - this triggers keychain prompt for db encryption key
        await initializeDatabase();
        logService.debug(
          `[PERF] initializeDatabase: ${Date.now() - t0}ms`,
          "System",
        );
        logService.info(
          "Database initialized with encryption",
          "System",
        );

        // TASK-1956: Initialize persistent worker pool for contact queries
        const poolDbPath = getDbPath();
        const poolEncKey = getEncryptionKey();
        if (poolDbPath && poolEncKey) {
          initializePool(poolDbPath, poolEncKey).catch((err) => {
            logService.warn("Failed to initialize contact worker pool: " + (err instanceof Error ? err.message : String(err)), "System");
          });
        }

        // Sessions persist across app restarts for better UX
        // Security is maintained via 24hr expiry on session tokens
        // NOTE: Previously cleared sessions on startup causing issues (file session
        // not synced with DB session, user appeared logged in but validation failed)
        logService.info(
          "Database initialized, sessions preserved across restarts",
          "System",
        );

        // TASK-1507D: Create pending deep link user if exists
        // This handles the case where deep link auth completed before DB was ready
        const pendingUser = getAndClearPendingDeepLinkUser();
        if (pendingUser) {
          logService.info(
            "Processing pending deep link user",
            "System",
            { email: pendingUser.email },
          );
          try {
            // Check if user already exists
            let localUser = await databaseService.getUserByEmail(pendingUser.email);
            if (!localUser) {
              localUser = await databaseService.getUserByOAuthId(
                pendingUser.provider,
                pendingUser.supabaseId,
              );
            }

            if (!localUser) {
              // TASK-1507G: Use Supabase Auth UUID as local user ID for unified IDs
              await databaseService.createUser({
                id: pendingUser.supabaseId,
                email: pendingUser.email,
                display_name: pendingUser.displayName || pendingUser.email.split("@")[0],
                avatar_url: pendingUser.avatarUrl,
                oauth_provider: pendingUser.provider,
                oauth_id: pendingUser.supabaseId,
                subscription_tier: pendingUser.subscriptionTier || "free",
                subscription_status: pendingUser.subscriptionStatus || "trial",
                trial_ends_at: pendingUser.trialEndsAt,
                is_active: true,
              });
              logService.info(
                "Created local user from pending deep link data",
                "System",
                { supabaseId: pendingUser.supabaseId },
              );
              localUser = await databaseService.getUserById(pendingUser.supabaseId);
            } else {
              logService.info(
                "Local user already exists for pending deep link",
                "System",
                { email: pendingUser.email },
              );
            }

            // BACKLOG-2173b: This is the deferred-DB path -- the DB was NOT
            // initialized when the deep-link callback fired in main.ts, so
            // main.ts's session-save block (L693-726) was skipped and took
            // the `else` branch (setPendingDeepLinkUser only, no save). The
            // DB is initialized NOW, so persist the durable session here --
            // otherwise the session only ever lives in RAM and is lost the
            // moment BACKLOG-2173's app.relaunch() restarts the process for
            // the FDA grant, dumping the user back to a failed login screen.
            if (localUser) {
              const authSession = await supabaseService.getAuthSession();
              if (authSession?.accessToken && authSession?.refreshToken) {
                await persistSessionForUser(localUser, pendingUser.provider, {
                  accessToken: authSession.accessToken,
                  refreshToken: authSession.refreshToken,
                });
              } else {
                logService.warn(
                  "[DeepLink] No Supabase auth session available to persist for deferred-DB user",
                  "System",
                  { userId: redactId(localUser.id) },
                );
              }
            }
          } catch (userError) {
            // Log but don't fail initialization
            logService.error(
              "Failed to create pending deep link user",
              "System",
              { error: userError instanceof Error ? userError.message : String(userError) },
            );
          }
        }

        // BACKLOG-1381: Broadcast creating-user stage before user verification/creation
        initializationBroadcaster.broadcast({
          stage: "creating-user",
          message: "Setting up your account...",
        });

        // ALWAYS verify user exists in local DB before returning success
        // This catches cases where pendingDeepLinkUser was null (non-deep-link auth flows)
        logService.debug("Running fallback user verification/creation", "System");
        try {
          const authSession = await supabaseService.getAuthSession();
          if (authSession?.userId) {
            const userId = authSession.userId;

            // Check if user exists in local DB
            let localUser = await databaseService.getUserById(userId);

            // If not, create them by fetching from Supabase cloud
            if (!localUser) {
              logService.info(
                "User not in local DB, fetching from Supabase",
                "System",
                { userId: userId.substring(0, 8) + "..." },
              );

              // Get user data from Supabase cloud (users table)
              const cloudUser = await supabaseService.getUserById(userId);

              if (cloudUser) {
                // Use consolidated helper for consistent defaults
                await createLocalUserFromCloud(cloudUser);

                // VERIFY: Re-fetch to confirm user was created
                localUser = await databaseService.getUserById(userId);
                if (!localUser) {
                  logService.error(
                    "Failed to verify user creation",
                    "System",
                    { userId: userId.substring(0, 8) + "..." },
                  );
                  throw new Error("User creation verification failed");
                }
                logService.info(
                  "User created and verified in local DB",
                  "System",
                  { userId: userId.substring(0, 8) + "..." },
                );
              } else {
                logService.warn(
                  "User not found in Supabase cloud, skipping local DB creation",
                  "System",
                  { userId: userId.substring(0, 8) + "..." },
                );
              }
            } else {
              logService.debug(
                "User already exists in local DB",
                "System",
                { userId: userId.substring(0, 8) + "..." },
              );
            }
          }
        } catch (userError) {
          // Log but don't fail DB init - user creation is best-effort
          logService.error(
            "Failed to ensure user in local DB",
            "System",
            { error: userError instanceof Error ? userError.message : String(userError) },
          );
        }

        initializationComplete = true;

        // BACKLOG-1381: Broadcast complete stage
        initializationBroadcaster.broadcast({
          stage: "complete",
          message: "Ready",
        });

        return {
          success: true,
          available: true,
          platform: os.platform(),
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Database initialization failed. Please try again.";

        // BACKLOG-1381: Broadcast error stage
        initializationBroadcaster.broadcast({
          stage: "error",
          error: { message: errorMessage, retryable: true },
        });

        logService.error("Database initialization failed", "System", {
          error: errorMessage,
        });
        const platform = os.platform();
        return {
          success: false,
          available: false,
          platform,
          guidance: getSecureStorageGuidance(platform),
          error: errorMessage,
        };
      } finally {
        isInitializing = false;
      }
    },
  );

  /**
   * Check if the database encryption key store exists
   * Used to determine if this is a new user (needs secure storage setup) vs returning user
   */
  ipcMain.handle(
    "system:has-encryption-key-store",
    wrapHandler(async (): Promise<{ success: boolean; hasKeyStore: boolean }> => {
      const hasKeyStore = databaseEncryptionService.hasKeyStore();
      return { success: true, hasKeyStore };
    }, { module: "System" }),
  );

  /**
   * Initialize the database after secure storage setup
   * This should be called after the user has authorized keychain access
   */
  ipcMain.handle(
    "system:initialize-database",
    async (): Promise<SystemResponse> => {
      // If already initialized, return immediately
      if (initializationComplete) {
        logService.debug(
          "Database already initialized via secure storage, skipping",
          "System",
        );
        return { success: true };
      }

      // If initialization is in progress, wait for it
      if (isInitializing) {
        logService.debug(
          "Database initialization already in progress, waiting...",
          "System",
        );
        let waitCount = 0;
        while (isInitializing && waitCount < 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
        return {
          success: initializationComplete,
          error: initializationComplete ? undefined : "Initialization timeout",
        };
      }

      isInitializing = true;
      try {
        await initializeDatabase();
        initializationComplete = true;
        logService.debug("Database initialized successfully", "System");

        // BACKLOG-1381: Broadcast complete stage (deferred DB init path)
        initializationBroadcaster.broadcast({
          stage: "complete",
          message: "Ready",
        });

        // TASK-1956: Initialize persistent worker pool for contact queries
        const poolDbPath2 = getDbPath();
        const poolEncKey2 = getEncryptionKey();
        if (poolDbPath2 && poolEncKey2) {
          initializePool(poolDbPath2, poolEncKey2).catch((err) => {
            logService.warn("Failed to initialize contact worker pool: " + (err instanceof Error ? err.message : String(err)), "System");
          });
        }

        // TASK-2058: Initialize failure log service (create table + prune)
        failureLogService.initialize().catch((err) => {
          logService.warn("Failed to initialize failure log service: " + (err instanceof Error ? err.message : String(err)), "System");
        });

        return { success: true };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        // BACKLOG-1381: Broadcast error stage (deferred DB init path)
        initializationBroadcaster.broadcast({
          stage: "error",
          error: { message: errorMessage, retryable: true },
        });

        logService.error("Database initialization failed", "System", {
          error: errorMessage,
        });
        return {
          success: false,
          error: errorMessage,
        };
      } finally {
        isInitializing = false;
      }
    },
  );

  /**
   * Check if the database is initialized
   * Used to determine if we can perform database operations (e.g., save user after OAuth)
   */
  ipcMain.handle(
    "system:is-database-initialized",
    wrapHandler(async (): Promise<{ success: boolean; initialized: boolean }> => {
      const initialized = databaseService.isInitialized();
      return { success: true, initialized };
    }, { module: "System" }),
  );

  /**
   * Get current initialization stage (BACKLOG-1379: event-driven init protocol)
   * Used by late-joining renderers to catch up on current init state
   */
  ipcMain.handle(
    "system:get-init-stage",
    wrapHandler(async () => {
      return initializationBroadcaster.getCurrentStage();
    }, { module: "System" }),
  );

  // ===== PERMISSION SETUP (ONBOARDING) =====

  /**
   * Run permission setup flow (contacts + full disk access)
   */
  ipcMain.handle(
    "system:run-permission-setup",
    wrapHandler(async (): Promise<SystemResponse> => {
      const result = await macOSPermissionHelper.runPermissionSetupFlow();
      return {
        success: result.overallSuccess,
        ...result,
      };
    }, { module: "System" }),
  );

  /**
   * Request Contacts permission
   */
  ipcMain.handle(
    "system:request-contacts-permission",
    wrapHandler(async (): Promise<SystemResponse> => {
      const result = await macOSPermissionHelper.requestContactsPermission();
      return result;
    }, { module: "System" }),
  );

  /**
   * Setup Full Disk Access (opens System Preferences)
   */
  ipcMain.handle(
    "system:setup-full-disk-access",
    wrapHandler(async (): Promise<SystemResponse> => {
      const result = await macOSPermissionHelper.setupFullDiskAccess();
      return result;
    }, { module: "System" }),
  );

  /**
   * Open specific privacy pane in System Preferences
   */
  ipcMain.handle(
    "system:open-privacy-pane",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      pane: string,
    ): Promise<SystemResponse> => {
      // Validate pane parameter
      const validatedPane = validateString(pane, "pane", {
        required: true,
        maxLength: 100,
      })!;

      const result =
        await macOSPermissionHelper.openPrivacyPane(validatedPane);
      return result;
    }, { module: "System" }),
  );

  /**
   * Check Full Disk Access status
   */
  ipcMain.handle(
    "system:check-full-disk-access-status",
    async (): Promise<PermissionResponse> => {
      try {
        const result = await macOSPermissionHelper.checkFullDiskAccessStatus();
        return {
          success: true,
          ...result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error(
          "Full Disk Access status check failed",
          "System",
          { error: errorMessage },
        );
        return {
          success: false,
          granted: false,
          error: errorMessage,
        };
      }
    },
  );

  // ===== PERMISSION CHECKS =====
  // Note: These handlers preserve their original try/catch because they return
  // structured error objects via permissionService.getPermissionError() which
  // is incompatible with wrapHandler's flat error string format.

  /**
   * Check Full Disk Access permission
   */
  ipcMain.handle(
    "system:check-full-disk-access",
    async (): Promise<PermissionResponse> => {
      try {
        const result = await permissionService.checkFullDiskAccess();
        return {
          success: true,
          ...result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("Full Disk Access check failed", "System", {
          error: errorMessage,
        });
        return {
          success: false,
          hasPermission: false,
          error: permissionService.getPermissionError(error as Error) as unknown as string,
        };
      }
    },
  );

  /**
   * Check Contacts permission
   */
  ipcMain.handle(
    "system:check-contacts-permission",
    async (): Promise<PermissionResponse> => {
      try {
        const result = await permissionService.checkContactsPermission();
        return {
          success: true,
          ...result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("Contacts permission check failed", "System", {
          error: errorMessage,
        });
        return {
          success: false,
          hasPermission: false,
          error: permissionService.getPermissionError(error as Error) as unknown as string,
        };
      }
    },
  );

  /**
   * Check all required permissions
   */
  ipcMain.handle(
    "system:check-all-permissions",
    async (): Promise<SystemResponse> => {
      try {
        const result = await permissionService.checkAllPermissions();
        return {
          success: true,
          ...result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("All permissions check failed", "System", {
          error: errorMessage,
        });
        return {
          success: false,
          error: permissionService.getPermissionError(error as Error) as unknown as string,
        };
      }
    },
  );

  // ===== CONNECTION STATUS =====
  // Note: These handlers preserve their original try/catch because they return
  // structured error objects (type/userMessage/details) which is incompatible
  // with wrapHandler's flat error string format.

  /**
   * Check Google OAuth connection
   */
  ipcMain.handle(
    "system:check-google-connection",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<ConnectionResponse> => {
      try {
        // Validate input
        const validatedUserId = validateUserId(userId)!;

        const result =
          await connectionStatusService.checkGoogleConnection(validatedUserId);
        return {
          success: true,
          ...result,
        } as ConnectionResponse;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("Google connection check failed", "System", {
          error: errorMessage,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            connected: false,
            error: {
              type: "VALIDATION_ERROR",
              userMessage: "Invalid user ID",
              details: error.message,
            },
          };
        }
        return {
          success: false,
          connected: false,
          error: {
            type: "CHECK_FAILED",
            userMessage: "Could not check Gmail connection",
            details: error instanceof Error ? error.message : "Unknown error",
          },
        };
      }
    },
  );

  /**
   * Check Microsoft OAuth connection
   */
  ipcMain.handle(
    "system:check-microsoft-connection",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<ConnectionResponse> => {
      try {
        // Validate input
        const validatedUserId = validateUserId(userId)!;

        const result =
          await connectionStatusService.checkMicrosoftConnection(
            validatedUserId,
          );
        return {
          success: true,
          ...result,
        } as ConnectionResponse;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error(
          "Microsoft connection check failed",
          "System",
          { error: errorMessage },
        );
        if (error instanceof ValidationError) {
          return {
            success: false,
            connected: false,
            error: {
              type: "VALIDATION_ERROR",
              userMessage: "Invalid user ID",
              details: error.message,
            },
          };
        }
        return {
          success: false,
          connected: false,
          error: {
            type: "CHECK_FAILED",
            userMessage: "Could not check Outlook connection",
            details: error instanceof Error ? error.message : "Unknown error",
          },
        };
      }
    },
  );

  /**
   * Check all OAuth connections
   */
  ipcMain.handle(
    "system:check-all-connections",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<SystemResponse> => {
      try {
        // Validate input
        const validatedUserId = validateUserId(userId)!;

        // BACKLOG-1842 (resume-at-step fix round, startup-resilience
        // follow-up): connectionStatusService.checkAllConnections reads
        // databaseService.getOAuthToken, which throws "Database is not
        // initialized" when called before DB init completes. Live trace
        // evidence (main.log 2026-07-20 21:55:38.862, "DatabaseError") caught
        // this firing unguarded during a fast relaunch/sign-in — it recovered
        // silently (the catch block below already returns a graceful
        // success:false that callers treat as "not connected"), but await the
        // shared db-ready signal first so the common case (DB comes up within
        // the bound) returns real connection data instead of a false negative.
        if (!databaseService.isInitialized()) {
          await initializationBroadcaster.whenDbReady();
          // Whether it became ready or timed out, fall through: if still not
          // ready, the read below throws and the existing catch handles it
          // the same graceful way it always has.
        }

        const result =
          await connectionStatusService.checkAllConnections(validatedUserId);
        return {
          success: true,
          ...result,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("All connections check failed", "System", {
          error: errorMessage,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: {
              type: "VALIDATION_ERROR",
              userMessage: "Invalid user ID",
              details: error.message,
            },
          };
        }
        return {
          success: false,
          error: {
            type: "CHECK_FAILED",
            userMessage: "Could not check email connections",
            details: error instanceof Error ? error.message : "Unknown error",
          },
        };
      }
    },
  );

  // ===== SUPPORT & EXTERNAL LINKS =====

  /**
   * Open external URL in default browser
   */
  ipcMain.handle(
    "shell:open-external",
    wrapHandler(async (event: IpcMainInvokeEvent, url: string): Promise<SystemResponse> => {
      // Validate URL
      const validatedUrl = validateString(url, "url", {
        required: true,
        maxLength: 2000,
      });

      if (!validatedUrl) {
        return {
          success: false,
          error: "URL is required",
        };
      }

      // Only allow safe protocols
      const allowedProtocols = ["https:", "http:", "mailto:"];
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(validatedUrl);
      } catch {
        return {
          success: false,
          error: "Invalid URL format",
        };
      }

      if (!allowedProtocols.includes(parsedUrl.protocol)) {
        return {
          success: false,
          error: `Protocol not allowed: ${parsedUrl.protocol}`,
        };
      }

      await shell.openExternal(validatedUrl);
      return { success: true };
    }, { module: "System" }),
  );

  /**
   * Open URL in a popup window (instead of system browser)
   * Used for upgrade flows to keep user in-app
   */
  ipcMain.handle(
    "shell:open-popup",
    wrapHandler(async (event: IpcMainInvokeEvent, url: string, title?: string): Promise<SystemResponse> => {
      // Validate URL
      const validatedUrl = validateString(url, "url", {
        required: true,
        maxLength: 2000,
      });

      if (!validatedUrl) {
        return {
          success: false,
          error: "URL is required",
        };
      }

      // Only allow safe protocols
      const allowedProtocols = ["https:", "http:"];
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(validatedUrl);
      } catch {
        return {
          success: false,
          error: "Invalid URL format",
        };
      }

      if (!allowedProtocols.includes(parsedUrl.protocol)) {
        return {
          success: false,
          error: `Protocol not allowed: ${parsedUrl.protocol}`,
        };
      }

      // Create popup window
      const popupWindow = new BrowserWindow({
        width: 800,
        height: 700,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
        autoHideMenuBar: true,
        title: title || "Keepr",
      });

      // Load the URL
      popupWindow.loadURL(validatedUrl);

      return { success: true };
    }, { module: "System" }),
  );

  /**
   * Show file in folder (Finder on macOS, Explorer on Windows)
   */
  ipcMain.handle(
    "system:show-in-folder",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      filePath: string,
    ): Promise<SystemResponse> => {
      // Validate file path
      const validatedPath = validateString(filePath, "filePath", {
        required: true,
        maxLength: 2000,
      });

      if (!validatedPath) {
        return {
          success: false,
          error: "File path is required",
        };
      }

      shell.showItemInFolder(validatedPath);
      return { success: true };
    }, { module: "System" }),
  );

  /**
   * Open support email with pre-filled content
   */
  ipcMain.handle(
    "system:contact-support",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      errorDetails?: string,
    ): Promise<SystemResponse> => {
      const supportEmail = "support@keeprcompliance.com";
      const subject = encodeURIComponent("Keepr Support Request");
      const body = encodeURIComponent(
        `Hi Keepr Support,\n\n` +
          `I need help with:\n\n` +
          `${errorDetails ? `Error details: ${errorDetails}\n\n` : ""}` +
          `Thank you for your assistance.\n`,
      );

      const mailtoUrl = `mailto:${supportEmail}?subject=${subject}&body=${body}`;
      await shell.openExternal(mailtoUrl);
      return { success: true };
    }, { module: "System" }),
  );

  // Renderer log relay — pipes renderer console logs to main process log file
  ipcMain.on("log:renderer", (_event, level: string, message: string) => {
    const prefix = `[Renderer] ${message}`;
    switch (level) {
      case "debug": log.debug(prefix); break;
      case "warn": log.warn(prefix); break;
      case "error": log.error(prefix); break;
      default: log.info(prefix); break;
    }
  });
}
