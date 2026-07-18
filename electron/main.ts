import {
  app,
  BrowserWindow,
  dialog,
  session,
  ipcMain,
  protocol,
  net,
} from "electron";
import path from "path";
import log from "electron-log";
import { redactEmail, redactId } from "./utils/redactSensitive";

// ==========================================
// DEEP LINK PROTOCOL REGISTRATION (TASK-1500)
// ==========================================
// Register keepr:// protocol handler at runtime
// This is needed for development mode and as a fallback for production
if (process.defaultApp) {
  // In development, register with the full path to the project directory
  // This ensures macOS can launch the app correctly via deep link
  const appPath = path.resolve(__dirname, '..');
  log.info('[DeepLink] Dev mode - registering protocol with path:', appPath);
  log.info('[DeepLink] Electron binary:', process.execPath);
  app.setAsDefaultProtocolClient('keepr', process.execPath, [appPath]);
} else {
  // In production, electron-builder handles registration via package.json protocols config
  app.setAsDefaultProtocolClient('keepr');
}

// ==========================================
// CUSTOM APP PROTOCOL REGISTRATION (TASK-2051)
// ==========================================
// Register custom app:// protocol scheme for production content loading.
// This MUST be called before app.whenReady() per Electron docs.
// Enables disabling GrantFileProtocolExtraPrivileges fuse for security hardening.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,      // Enables relative URL resolution (href="./style.css")
      secure: true,        // Treated as secure context (like https://)
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

// ==========================================
// BACKLOG-1940: E2E-only "serve built assets" hook (dev-only, ship-guarded)
// ==========================================
// The reliable QA driver launches the app UNPACKAGED via Playwright's
// `_electron.launch()` (node_modules electron + the built dist-electron/main.js).
// In that mode `app.isPackaged` is FALSE, so the normal load path (main.ts) would
// point the renderer at the Vite dev server (http://localhost:5173) — which is NOT
// running under the driver, yielding a stale/blank page. This flag makes an
// UNPACKAGED build load the already-built `dist/` assets via the app:// protocol
// instead, so the driver gets a deterministic renderer with NO dev server.
//
// SAFETY — this can NEVER be active in a shipped build:
//   - It is DOUBLE-gated: `!app.isPackaged` AND `process.env.KEEPR_E2E === '1'`.
//   - A packaged/notarized artifact always has `app.isPackaged === true`, so the
//     branch is dead code there regardless of the env var.
//   - It only changes WHICH already-built local asset source is loaded (dev server
//     vs the bundled dist/ files). It injects no auth, unlocks nothing, and adds no
//     IPC. Auth for the driver is provided entirely as an out-of-process fixture
//     (a seeded session.json + local DB rows), not by any app-code path.
function isE2EServeDistMode(): boolean {
  return !app.isPackaged && process.env.KEEPR_E2E === "1";
}

// ==========================================
// SINGLE INSTANCE LOCK (TASK-1500)
// ==========================================
// Ensure only one instance of the app is running
// This is required for deep link handling on Windows
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is running, quit this one
  // The other instance will handle the deep link via second-instance event
  app.quit();
}
import { autoUpdater } from "electron-updater";
// BACKLOG-1903: pure updater-failure telemetry helpers (fingerprint + field
// extraction + URL sanitization). No Electron/Sentry deps — safe to import here.
import {
  extractUpdaterDiagnostics,
  scrubUpdaterEventPII,
  type UpdaterUpdateInfoLike,
} from "./services/updateDiagnostics";
import { setLastUpdaterFailure } from "./services/updaterFailureStore";
// BACKLOG-1905: pure self-recovery decision (checksum full-download fallback +
// bounded network retry). No Electron/autoUpdater deps — safe to import here.
import {
  createRetryState,
  decideRecovery,
  executeRecovery,
  type RetryState,
} from "./services/updaterRetryPolicy";
import dotenv from "dotenv";

// Load environment files based on whether app is packaged or in development
if (app.isPackaged) {
  // Packaged build: load .env.production from extraResources
  // extraResources files are copied to process.resourcesPath (NOT inside app.asar)
  const envPath = path.join(process.resourcesPath, ".env.production");
  dotenv.config({ path: envPath });
} else {
  // Development: load .env.development first (OAuth credentials), then .env.local for overrides
  dotenv.config({ path: path.join(__dirname, "../.env.development") });
  dotenv.config({ path: path.join(__dirname, "../.env.local") });
}

// Import constants
import {
  WINDOW_CONFIG,
  DEV_SERVER_URL,
  UPDATE_CHECK_DELAY,
  UPDATE_CHECK_INTERVAL,
  DOWNLOAD_STALL_TIMEOUT_MS,
} from "./constants";

// Import handler registration functions
import { registerAuthHandlers } from "./handlers/authHandlers";
import { registerTransactionCrudHandlers } from "./handlers/transactionCrudHandlers";
import { registerTransactionExportHandlers, cleanupTransactionHandlers } from "./handlers/transactionExportHandlers";
import { registerTransactionSearchHandlers } from "./handlers/transactionSearchHandlers";
import { registerEmailSyncHandlers } from "./handlers/emailSyncHandlers";
import { registerEmailLinkingHandlers } from "./handlers/emailLinkingHandlers";
import { registerEmailAutoLinkHandlers } from "./handlers/emailAutoLinkHandlers";
import { registerAttachmentHandlers } from "./handlers/attachmentHandlers";
import { registerContactHandlers } from "./handlers/contactHandlers";
import { registerAddressHandlers } from "./handlers/addressHandlers";
import { registerFeedbackHandlers } from "./handlers/feedbackHandlers";
import { registerSystemHandlers } from "./handlers/systemHandlers";
import { registerDiagnosticHandlers } from "./handlers/diagnosticHandlers";
import { registerUserSettingsHandlers } from "./handlers/userSettingsHandlers";
import { registerPreferenceHandlers } from "./handlers/preferenceHandlers";
import {
  registerDeviceHandlers,
  cleanupDeviceHandlers,
} from "./handlers/deviceHandlers";
import { registerBackupHandlers } from "./handlers/backupHandlers";
import { registerSyncHandlers, cleanupSyncHandlers } from "./handlers/syncHandlers";
import { registerDriverHandlers } from "./handlers/driverHandlers";
import { registerLLMHandlers } from "./handlers/llmHandlers";
import { registerLicenseHandlers } from "./handlers/licenseHandlers";
import { registerFeatureGateHandlers } from "./handlers/featureGateHandlers";
import { registerEntitlementHandlers } from "./handlers/entitlementHandlers";
import { registerPaymentHandlers } from "./handlers/paymentHandlers";
import { sanitizeSessionId } from "./services/paymentService";
import { registerPreAuthValidationHandler } from "./handlers/preAuthValidationHandler";
import { registerSupportTicketHandlers } from "./handlers/supportTicketHandlers";
import { registerLocalSyncHandlers, cleanupLocalSyncHandlers } from "./handlers/localSyncHandlers";
import { registerPairingHandlers, cleanupPairingHandlers } from "./handlers/pairingHandlers";
import { LLMConfigService } from "./services/llm/llmConfigService";

// Import license and device services for deep link auth validation (TASK-1507)
import { validateLicense, createUserLicense } from "./services/licenseService";
import { registerDevice } from "./services/deviceService";
import supabaseService from "./services/supabaseService";
import databaseService from "./services/databaseService";
import sessionService from "./services/sessionService";
import submissionService from "./services/submissionService";
import {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
} from "./constants/legalVersions";
import type { OAuthProvider, SubscriptionTier, SubscriptionStatus, User } from "./types";

// Import extracted handlers from handlers/ directory
import {
  registerPermissionHandlers,
  registerConversationHandlers,
  registerMessageImportHandlers,
  registerOutlookHandlers,
  registerUpdaterHandlers,
  registerErrorLoggingHandlers,
  registerResetHandlers,
  registerAppCleanupHandlers,
  registerBackupRestoreHandlers,
  registerCcpaHandlers,
  registerFailureLogHandlers,
} from "./handlers";

// Configure logging for auto-updater
log.transports.file.level = "info";

// ==========================================
// SENTRY ERROR TRACKING (TASK-1967)
// ==========================================
// Initialize Sentry as early as possible for error monitoring
import * as Sentry from "@sentry/electron/main";
import { runStartupHealthChecks } from "./services/startupHealthCheck";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: app.isPackaged ? "production" : "development",
  release: app.getVersion(),
  // Don't send events in development unless DSN is explicitly set
  enabled: app.isPackaged || !!process.env.SENTRY_DSN,
  // BACKLOG-1903: scrub signed-URL tokens + local paths from the exception
  // VALUE (and top-level message) of auto-updater events before they leave
  // the process. Sentry derives the issue title/exception value from the
  // ORIGINAL err.message passed to captureException(), which bypasses the
  // sanitization already applied to extra.sanitizedMessage — see
  // scrubUpdaterEventPII() for the full explanation. Scoped to
  // tags.component === "auto-updater" so non-updater events are untouched,
  // and never mutates `fingerprint`, so grouping is unaffected. Guarded so a
  // throwing beforeSend can never silently drop the event.
  beforeSend(event) {
    try {
      return scrubUpdaterEventPII(event);
    } catch (scrubError) {
      log.error("[Sentry] beforeSend PII scrub failed, sending event unscrubbed:", scrubError);
      return event;
    }
  },
});

// TASK-2330: Set auto-updater context immediately after Sentry.init()
// so all subsequent events/breadcrumbs carry version + platform info
Sentry.setContext("auto-updater", {
  currentVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  feedRepo: "Keepr-Compliance/keepr-releases",
});

// Global error handlers - must be registered early, before any async operations
// These catch uncaught exceptions and unhandled promise rejections to prevent silent crashes
process.on("uncaughtException", (error: Error) => {
  Sentry.captureException(error);
  console.error("[FATAL] Uncaught Exception:", error);
  log.error("[FATAL] Uncaught Exception:", error);
  // Do NOT call process.exit() - let Electron handle graceful shutdown
  // Do NOT show dialog here - it may not be ready at startup
});

process.on("unhandledRejection", (reason: unknown) => {
  Sentry.captureException(reason);
  console.error("[ERROR] Unhandled Rejection:", reason);
  log.error("[ERROR] Unhandled Rejection:", reason);
  // Log but do not crash - unhandled rejections are often recoverable
});

let mainWindow: BrowserWindow | null = null;

// ==========================================
// PENDING DEEP LINK USER (TASK-1507D)
// ==========================================
// When deep link auth completes before database is initialized,
// we store the user data here and create the local user after DB init.

interface PendingDeepLinkUser {
  supabaseId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  provider: OAuthProvider;
  subscriptionTier?: SubscriptionTier;
  subscriptionStatus?: SubscriptionStatus;
  trialEndsAt?: string;
}

let pendingDeepLinkUser: PendingDeepLinkUser | null = null;

/**
 * Store pending deep link user data for later creation
 * Used when deep link auth completes before database is initialized
 */
export function setPendingDeepLinkUser(data: PendingDeepLinkUser): void {
  pendingDeepLinkUser = data;
  log.info("[DeepLink] Stored pending user for later creation:", redactId(data.supabaseId));
}

/**
 * Get and clear pending deep link user data
 * Called after database initialization to create the user
 */
export function getAndClearPendingDeepLinkUser(): PendingDeepLinkUser | null {
  const user = pendingDeepLinkUser;
  pendingDeepLinkUser = null;
  return user;
}

/**
 * Create or update local SQLite user from deep link auth data (TASK-1507D)
 *
 * This ensures the local database has a user record after deep link auth,
 * which is required for FK constraints (mailbox connection, audit logs, etc.)
 *
 * @param userData - User data from Supabase session
 * @returns Promise<void>
 */
async function syncDeepLinkUserToLocalDb(userData: PendingDeepLinkUser): Promise<void> {
  try {
    // Check if user already exists by email (deep link users use Supabase ID as oauth_id)
    // We check by email first since that's the unique identifier
    let localUser = await databaseService.getUserByEmail(userData.email);

    if (!localUser) {
      // Also check by OAuth ID in case the user was created via a different flow
      // Map 'azure' to 'microsoft' for lookup (Azure AD is Microsoft's provider)
      const lookupProvider = userData.provider === "azure" ? "microsoft" : userData.provider;
      localUser = await databaseService.getUserByOAuthId(lookupProvider, userData.supabaseId);
    }

    if (!localUser) {
      // TASK-1507G: Use Supabase Auth UUID as local user ID for unified IDs
      // Map 'azure' to 'microsoft' - Azure AD is Microsoft's auth provider
      const normalizedProvider = userData.provider === "azure" ? "microsoft" : userData.provider;
      await databaseService.createUser({
        id: userData.supabaseId,
        email: userData.email,
        display_name: userData.displayName || userData.email.split("@")[0],
        avatar_url: userData.avatarUrl,
        oauth_provider: normalizedProvider,
        oauth_id: userData.supabaseId,
        subscription_tier: userData.subscriptionTier || "free",
        subscription_status: userData.subscriptionStatus || "trial",
        trial_ends_at: userData.trialEndsAt,
        is_active: true,
      });
      log.info("[DeepLink] Created local SQLite user for:", redactId(userData.supabaseId));
    } else if (localUser.id !== userData.supabaseId) {
      // BACKLOG-600: Local user exists with different ID than Supabase auth.uid()
      // This happens for users created before TASK-1507G (user ID unification)
      // Migrate the local user to use the Supabase ID for FK constraint compatibility
      log.info("[DeepLink] Migrating local user ID to match Supabase", {
        oldId: redactId(localUser.id),
        newId: redactId(userData.supabaseId),
        email: redactEmail(userData.email),
      });
      try {
        await databaseService.migrateUserIdForUnification(localUser.id, userData.supabaseId);
        log.info("[DeepLink] Local user ID migrated successfully to:", redactId(userData.supabaseId));
      } catch (migrationError) {
        log.error("[DeepLink] Failed to migrate local user ID:", migrationError);
        // Don't throw - auth should continue, but Supabase operations may fail
      }
    } else {
      log.info("[DeepLink] Local user already exists with correct ID for:", redactEmail(userData.email));
    }
  } catch (error) {
    log.error("[DeepLink] Failed to create local user:", error);
    // Don't rethrow - auth should still succeed even if local user creation fails
    // The user will be created on next database operation that requires it
  }
}

// ==========================================
// DEEP LINK URL REDACTION (TASK-1939)
// ==========================================
/**
 * Redact sensitive OAuth tokens/codes from deep link URLs before logging.
 * Prevents credential leakage in log files.
 */
function redactDeepLinkUrl(url: string): string {
  return url.replace(
    /(?:code|token|access_token|refresh_token|claim)=[^&#]+/gi,
    (match) => {
      const key = match.split("=")[0];
      return `${key}=[REDACTED]`;
    },
  );
}

// ==========================================
// DEEP LINK HANDLER (TASK-1500, enhanced TASK-1507, BACKLOG-1603)
// ==========================================

/**
 * BACKLOG-1603: Claim tokens from the claim-tokens edge function.
 * Called when the deep link contains a claim ID instead of raw tokens.
 *
 * The edge function does NOT require user auth (chicken-and-egg: the tokens
 * are what we're trying to get). The claim UUID itself is the security factor
 * (unguessable, 60s TTL, single-use). The Supabase anon key authenticates
 * the request to the API gateway.
 *
 * @returns The token payload, or null if claim failed
 */
async function claimTokensFromEdgeFunction(claimId: string): Promise<{
  access_token: string;
  refresh_token: string;
  provider_token?: string;
  provider_refresh_token?: string;
} | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    log.error("[DeepLink] Cannot claim tokens: missing SUPABASE_URL or SUPABASE_ANON_KEY");
    return null;
  }

  try {
    log.info("[DeepLink] Claiming tokens from edge function...");
    const response = await net.fetch(`${supabaseUrl}/functions/v1/claim-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": supabaseAnonKey,
        "Authorization": `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify({ claim_id: claimId }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log.error("[DeepLink] Claim failed:", response.status, errorBody);
      return null;
    }

    const data = await response.json() as {
      payload?: {
        access_token?: string;
        refresh_token?: string;
        provider_token?: string;
        provider_refresh_token?: string;
      };
      provider?: string;
    };

    if (!data.payload?.access_token || !data.payload?.refresh_token) {
      log.error("[DeepLink] Claim response missing tokens in payload");
      return null;
    }

    log.info("[DeepLink] Tokens claimed successfully");
    return {
      access_token: data.payload.access_token,
      refresh_token: data.payload.refresh_token,
      provider_token: data.payload.provider_token,
      provider_refresh_token: data.payload.provider_refresh_token,
    };
  } catch (error) {
    log.error("[DeepLink] Failed to claim tokens:", error);
    return null;
  }
}

/**
 * Handle incoming deep link authentication callback
 * Parses the URL, validates license, registers device, and sends result to renderer
 *
 * TASK-1507: Enhanced to validate license and register device before completing auth
 * BACKLOG-1603: Support claim-code flow (keepr://callback?claim=UUID)
 *   - New format: keepr://callback?claim=UUID (tokens claimed via HTTPS)
 *   - Old format: keepr://callback?access_token=...&refresh_token=... (deprecated)
 *
 * @param url - The deep link URL to process
 */
async function handleDeepLinkCallback(url: string): Promise<void> {
  try {
    const parsed = new URL(url);

    // BACKLOG-2015: payment-callback branch. Fired after the browser returns from
    // Stripe Checkout / SCA (keepr://payment-callback?session=<id>). Mirror the
    // auth multi-format host/pathname check. The sessionId is UNTRUSTED input
    // (any local app can fire keepr://) — sanitize it and forward to the renderer
    // to poke the JWT-authed /status self-heal; the unlock decision is the
    // authoritative gate re-read (never trusts this URL).
    const isPaymentCallback =
      parsed.pathname === "//payment-callback" ||
      parsed.pathname === "/payment-callback" ||
      parsed.host === "payment-callback";

    if (isPaymentCallback) {
      const rawSession = parsed.searchParams.get("session");
      const sessionId = sanitizeSessionId(rawSession);
      log.info("[DeepLink] Payment callback received", { hasSession: !!sessionId });
      sendToRenderer("payment:deep-link-callback", { sessionId });
      focusMainWindow();
      return;
    }

    // Support multiple path formats: //callback, /callback, or host=callback
    const isCallback =
      parsed.pathname === "//callback" ||
      parsed.pathname === "/callback" ||
      parsed.host === "callback";

    if (isCallback) {
      // BACKLOG-1603: Check for claim-code format first (new secure flow)
      const claimId = parsed.searchParams.get("claim");

      let accessToken: string | null = null;
      let refreshToken: string | null = null;
      const hashParams = parsed.hash ? new URLSearchParams(parsed.hash.slice(1)) : null;

      if (claimId) {
        // New claim-code flow: retrieve tokens via HTTPS edge function
        log.info("[DeepLink] Claim-code format detected, claiming tokens securely");
        const claimed = await claimTokensFromEdgeFunction(claimId);
        if (!claimed) {
          const isOnline = net.isOnline();
          Sentry.captureException(new Error(`Deep link auth: token claim failed${!isOnline ? " (device offline)" : ""}`), {
            tags: { component: "deep-link", action: "auth-callback", error_code: "CLAIM_FAILED", networkOnline: isOnline },
          });
          sendToRenderer("auth:deep-link-error", {
            error: !isOnline
              ? "Authentication failed — you appear to be offline"
              : "Failed to retrieve authentication tokens. The claim may have expired (60s TTL). Please try signing in again.",
            code: "CLAIM_FAILED",
          });
          return;
        }
        accessToken = claimed.access_token;
        refreshToken = claimed.refresh_token;
      } else {
        // Legacy flow: tokens embedded directly in URL (deprecated)
        // TASK-1508A: Parse tokens from both query params AND URL fragment
        // Supabase OAuth returns tokens in fragment (#access_token=...) not query params (?access_token=...)
        accessToken = parsed.searchParams.get("access_token") || hashParams?.get("access_token") || null;
        refreshToken = parsed.searchParams.get("refresh_token") || hashParams?.get("refresh_token") || null;

        if (accessToken) {
          // BACKLOG-1603: Deprecation warning for direct token passing
          log.warn("[DeepLink] DEPRECATED: Received tokens directly in URL. Update broker portal to use claim-code flow.");
        }

        // Log which format was detected for debugging
        log.info("[DeepLink] Parsing callback URL (legacy format)", {
          hasQueryParams: !!parsed.searchParams.get("access_token"),
          hasHashParams: !!hashParams?.get("access_token"),
        });
      }

      // Extract OAuth error information if present (provider tells us exactly why auth failed)
      const oauthError = parsed.searchParams.get("error") || hashParams?.get("error");
      const oauthErrorDescription = parsed.searchParams.get("error_description") || hashParams?.get("error_description");

      if (!accessToken || !refreshToken) {
        // Missing tokens - send error to renderer
        log.error("[DeepLink] Callback missing tokens after claim/parse");
        if (oauthError) {
          // OAuth provider explicitly returned an error
          Sentry.captureException(new Error(`Deep link auth: OAuth error (${oauthError})`), {
            tags: { component: "deep-link", action: "auth-callback", error_code: "OAUTH_ERROR", oauthError, oauth_reason: oauthErrorDescription || "none" },
            extra: { callback_path: redactDeepLinkUrl(url) },
          });
          sendToRenderer("auth:deep-link-error", {
            error: oauthErrorDescription || `OAuth error: ${oauthError}`,
            code: "OAUTH_ERROR",
          });
        } else {
          // No OAuth error but tokens missing — could be corrupted URL or incomplete redirect
          const isOnline = net.isOnline();
          Sentry.captureException(new Error(`Deep link auth: missing tokens${!isOnline ? " (device offline)" : ""}`), {
            tags: { component: "deep-link", action: "auth-callback", error_code: "MISSING_TOKENS", networkOnline: isOnline },
            extra: { callback_path: redactDeepLinkUrl(url) },
          });
          sendToRenderer("auth:deep-link-error", {
            error: !isOnline ? "Authentication failed — you appear to be offline" : "Missing tokens in callback URL",
            code: "MISSING_TOKENS",
          });
        }
        return;
      }

      // From here on, the flow is identical regardless of how tokens were obtained
      // (claim-code or direct URL)

      // TASK-1507: Step 1 - Verify tokens and establish session using setSession()
      // Per SR Engineer review: Use setSession() instead of getUser() for proper session establishment
      log.info("[DeepLink] Setting session with tokens...");
      const { data: sessionData, error: sessionError } = await supabaseService
        .getClient()
        .auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

      if (sessionError || !sessionData?.user) {
        log.error("[DeepLink] Failed to set session:", sessionError);
        Sentry.captureException(sessionError || new Error("Deep link auth: session data missing user"), {
          tags: { component: "deep-link", action: "auth-callback", error_code: "INVALID_TOKENS", networkOnline: net.isOnline(), session_failure: sessionError?.message || "no user data" },
          extra: { callback_path: redactDeepLinkUrl(url) },
        });
        sendToRenderer("auth:deep-link-error", {
          error: "Invalid authentication tokens",
          code: "INVALID_TOKENS",
        });
        return;
      }

      const user = sessionData.user;
      Sentry.setUser({ id: user.id, email: user.email ? redactEmail(user.email) : undefined });
      log.info("[DeepLink] Session established for user:", redactId(user.id));

      // TASK-1507: Step 2 - Validate license
      log.info("[DeepLink] Validating license for user:", redactId(user.id));
      let licenseStatus = await validateLicense(user.id);

      // TASK-1507: Step 3 - Create trial license if needed
      if (licenseStatus.blockReason === "no_license") {
        log.info("[DeepLink] Creating trial license for new user:", redactId(user.id));
        licenseStatus = await createUserLicense(user.id);
      }

      // TASK-1507: Step 4 - Check if license blocks access (expired/suspended)
      if (!licenseStatus.isValid && licenseStatus.blockReason !== "no_license") {
        log.warn("[DeepLink] License blocked for user:", redactId(user.id), "reason:", licenseStatus.blockReason);
        Sentry.captureException(new Error("Deep link auth: license blocked"), {
          tags: { component: "deep-link", action: "auth-callback", error_code: "LICENSE_BLOCKED", block_reason: licenseStatus.blockReason || "unknown" },
        });
        sendToRenderer("auth:deep-link-license-blocked", {
          accessToken,
          refreshToken,
          userId: user.id,
          blockReason: licenseStatus.blockReason,
          licenseStatus,
        });
        focusMainWindow();
        return;
      }

      // TASK-1507: Step 5 - Register device
      log.info("[DeepLink] Registering device for user:", redactId(user.id));
      const deviceResult = await registerDevice(user.id);

      if (!deviceResult.success && deviceResult.error === "device_limit_reached") {
        log.warn("[DeepLink] Device limit reached for user:", redactId(user.id));
        Sentry.captureException(new Error("Deep link auth: device limit exceeded"), {
          tags: { component: "deep-link", action: "auth-callback", error_code: "DEVICE_LIMIT" },
        });
        sendToRenderer("auth:deep-link-device-limit", {
          accessToken,
          refreshToken,
          userId: user.id,
          licenseStatus,
        });
        focusMainWindow();
        return;
      }

      // TASK-1507D: Step 5.5 - Create local SQLite user
      // This is required for FK constraints (mailbox connection, audit logs, contacts)
      const rawProvider = (user.app_metadata?.provider as string) || "google";
      const provider = (rawProvider === "azure" ? "microsoft" : rawProvider) as OAuthProvider;

      // Map license type to subscription tier
      // licenseType: 'trial' | 'individual' | 'team' -> subscriptionTier: 'free' | 'pro' | 'enterprise'
      const mapLicenseToTier = (lt: string): SubscriptionTier => {
        if (lt === "individual") return "pro";
        if (lt === "team") return "enterprise";
        return "free"; // trial or unknown
      };

      // Map trial status to subscription status
      // trialStatus: 'active' | 'expired' | 'converted' -> subscriptionStatus: 'trial' | 'active' | 'cancelled' | 'expired'
      const mapTrialToStatus = (ts?: string, lt?: string): SubscriptionStatus => {
        if (lt === "individual" || lt === "team") return "active"; // Paid plan
        if (ts === "expired") return "expired";
        if (ts === "converted") return "active";
        return "trial"; // Default for trial license
      };

      // Extract email - Azure/Microsoft may have empty user.email but email in user_metadata
      const userEmail = user.email || user.user_metadata?.email || "";

      const deepLinkUserData: PendingDeepLinkUser = {
        supabaseId: user.id,
        email: userEmail,
        displayName: user.user_metadata?.full_name,
        avatarUrl: user.user_metadata?.avatar_url,
        provider,
        subscriptionTier: mapLicenseToTier(licenseStatus.licenseType),
        subscriptionStatus: mapTrialToStatus(licenseStatus.trialStatus, licenseStatus.licenseType),
      };

      // TASK-1507F: Track local user ID for renderer callback
      // The renderer needs the LOCAL SQLite user ID (not Supabase UUID) for FK constraints
      let localUserId = user.id; // Default to Supabase UUID as fallback
      let localUser: User | null = null; // Hoisted for session save logic

      if (databaseService.isInitialized()) {
        // Database is ready - create user now
        log.info("[DeepLink] Database initialized, creating local user");
        await syncDeepLinkUserToLocalDb(deepLinkUserData);

        // TASK-1507F: Get the local user ID after creation/sync
        localUser = await databaseService.getUserByEmail(userEmail);
        if (localUser) {
          localUserId = localUser.id;
          log.info("[DeepLink] Using local user ID:", redactId(localUserId));

          // Save session to disk for persistence across app restarts
          try {
            const sessionToken = await databaseService.createSession(localUserId);

            // Build full Subscription object from license status
            const subscriptionTier = deepLinkUserData.subscriptionTier || "free";
            const subscriptionStatus = deepLinkUserData.subscriptionStatus || "trial";
            const isTrial = subscriptionStatus === "trial";
            const isActive = subscriptionStatus === "active" || subscriptionStatus === "trial";

            const subscription = {
              tier: subscriptionTier,
              status: subscriptionStatus,
              isActive,
              isTrial,
              trialEnded: subscriptionStatus === "expired",
              trialDaysRemaining: licenseStatus.trialDaysRemaining ?? 0,
            };

            await sessionService.saveSession({
              user: localUser,
              sessionToken,
              provider,
              subscription,
              expiresAt: Date.now() + sessionService.getSessionExpirationMs(),
              createdAt: Date.now(),
              // Store Supabase tokens for SDK session restoration (Dorian's T&C fix)
              // Required for RLS-protected operations on app restart
              supabaseTokens: {
                access_token: accessToken,
                refresh_token: refreshToken,
              },
            });
            log.info("[DeepLink] Session saved successfully with Supabase tokens");
          } catch (sessionError) {
            log.error("[DeepLink] Failed to save session:", sessionError);
          }
        } else {
          log.warn("[DeepLink] Local user not found after sync, using Supabase ID");
        }
      } else {
        // Database not ready yet - store for later
        // User will be created after DB initialization in system-handlers.ts
        log.info("[DeepLink] Database not initialized, storing pending user");
        setPendingDeepLinkUser(deepLinkUserData);
        // Note: localUserId remains as Supabase UUID since we can't query local DB yet
        // The renderer will need to handle this case (existing flow before TASK-1507F)
      }

      // BACKLOG-546: Check if user needs to accept terms
      // Fetch from Supabase to get terms acceptance status
      // BACKLOG-614: Default to false - don't show T&C unless we confirm they haven't accepted
      // This prevents returning users from seeing T&C again due to fetch failures
      let needsTermsAcceptance = false;
      try {
        const cloudUser = await supabaseService.getUserById(user.id);
        if (!cloudUser?.terms_accepted_at) {
          // No terms acceptance record - they need to accept
          needsTermsAcceptance = true;
        } else if (cloudUser.terms_version_accepted || cloudUser.privacy_policy_version_accepted) {
          // Has versioned acceptance - check if current versions match
          const termsOutdated = cloudUser.terms_version_accepted !== CURRENT_TERMS_VERSION;
          const privacyOutdated = cloudUser.privacy_policy_version_accepted !== CURRENT_PRIVACY_POLICY_VERSION;
          needsTermsAcceptance = termsOutdated || privacyOutdated;
        }
        // else: has terms_accepted_at but no version = legacy acceptance, they're good
        log.info("[DeepLink] Terms acceptance check:", { needsTermsAcceptance, termsAcceptedAt: cloudUser?.terms_accepted_at });
      } catch (termsCheckError) {
        // BACKLOG-614: If fetch fails, DON'T show T&C - better UX for returning users
        // They'll see T&C on next successful check if actually needed
        log.warn("[DeepLink] Failed to check terms acceptance, skipping T&C screen:", termsCheckError);
      }

      // TASK-1507: Step 6 - Success! Send all data to renderer
      // TASK-1507F: Use local user ID instead of Supabase UUID for FK constraint compatibility
      // BACKLOG-546: Include isNewUser based on terms acceptance, not transaction count
      log.info("[DeepLink] Auth complete, sending success event for user:", redactId(localUserId));
      sendToRenderer("auth:deep-link-callback", {
        accessToken,
        refreshToken,
        userId: localUserId,
        user: {
          id: localUserId,
          email: userEmail,
          name: user.user_metadata?.full_name,
        },
        provider: user.app_metadata?.provider,
        licenseStatus,
        device: deviceResult.device,
        isNewUser: needsTermsAcceptance, // BACKLOG-546: Based on terms, not transactions
      });

      focusMainWindow();

      // BACKLOG-1559: Start email precache immediately after login.
      // Don't wait for renderer/dashboard — start in the main process.
      try {
        const { default: emailSyncService } = await import("./services/emailSyncService");
        const hasMailbox = await databaseService.getOAuthToken(localUserId, "microsoft", "mailbox")
          || await databaseService.getOAuthToken(localUserId, "google", "mailbox");
        if (hasMailbox) {
          log.info("[DeepLink] Starting email precache after login");
          emailSyncService.precacheEmails(localUserId).then(() => {
            log.info("[DeepLink] Email precache completed");
          }).catch((err: unknown) => {
            log.warn("[DeepLink] Email precache failed (non-fatal):", err);
          });
        }
      } catch (precacheErr) {
        log.warn("[DeepLink] Email precache setup failed (non-fatal):", precacheErr);
      }

      // BACKLOG-1831: additive-only SHADOW-mode Outlook delta sync. Flag-gated
      // (env KEEPR_SHADOW_DELTA_SYNC=1 or pref shadowDeltaSync.enabled), default
      // OFF; logic + flag/mailbox gating live in the shared helper, which is also
      // called from the restored-session boot path (sessionHandlers) so returning
      // users start the poller too. start() is idempotent.
      try {
        const { maybeStartShadowDeltaSync } = await import("./services/shadowDeltaSyncService");
        await maybeStartShadowDeltaSync(localUserId);
      } catch (shadowErr) {
        log.warn("[DeepLink] Shadow delta sync setup failed (non-fatal):", shadowErr);
      }
    }
  } catch (error) {
    // Invalid URL format or unexpected error
    log.error("[DeepLink] Failed to handle callback:", error);
    Sentry.captureException(error, {
      tags: { component: "deep-link", action: "auth-callback", error_code: "UNKNOWN_ERROR" },
    });
    sendToRenderer("auth:deep-link-error", {
      error: "Authentication failed",
      code: "UNKNOWN_ERROR",
    });
  }
}

/**
 * Helper: Send event to renderer process safely
 * @param channel - IPC channel name
 * @param data - Data to send
 */
function sendToRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/**
 * Helper: Focus the main window (brings app to foreground)
 */
function focusMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// ==========================================
// MACOS DEEP LINK HANDLER (TASK-1500)
// ==========================================
// Handle deep links on macOS via open-url event
// This fires when the app is already running and a deep link is clicked
app.on("open-url", (event, url) => {
  event.preventDefault();
  log.info("[DeepLink] Received URL (macOS):", redactDeepLinkUrl(url));
  handleDeepLinkCallback(url);
});

// ==========================================
// WINDOWS DEEP LINK HANDLER (TASK-1500)
// ==========================================
// Handle deep links on Windows via second-instance event
// On Windows, deep links are passed as command line args to a new instance
// Since we have single-instance lock, the existing instance gets this event
app.on("second-instance", (_event, commandLine) => {
  // Find the deep link URL in command line args
  const url = commandLine.find((arg) => arg.startsWith("keepr://"));
  if (url) {
    log.info("[DeepLink] Received URL (Windows):", redactDeepLinkUrl(url));
    handleDeepLinkCallback(url);
  }

  // Focus main window when second instance is attempted
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

/**
 * Configure Content Security Policy for the application
 * This prevents the "unsafe-eval" security warning and restricts connections
 * to known, trusted domains only.
 *
 * Development vs Production CSP differences:
 * - script-src: Dev uses 'unsafe-inline' for Vite HMR (Hot Module Replacement).
 *   Vite injects inline scripts for HMR updates. Cannot be removed without breaking HMR.
 *   See: https://vitejs.dev/guide/features.html#content-security-policy
 * - style-src: Both use 'unsafe-inline' for CSS-in-JS and dynamic styling.
 * - connect-src: Dev allows localhost:5173 (Vite dev server) + ws:// for HMR websocket.
 *   Both dev and production restrict connections to specific whitelisted domains.
 *
 * Whitelisted external domains (connect-src):
 * - *.supabase.co           -- Supabase backend (auth, database, edge functions)
 * - graph.microsoft.com     -- Microsoft Graph API (Outlook mail/contacts)
 * - login.microsoftonline.com -- Microsoft OAuth2 authentication
 * - accounts.google.com     -- Google OAuth2 authentication
 * - *.googleapis.com        -- Google APIs (Gmail, userinfo, token, Maps)
 * - www.apple.com           -- Apple iTunes driver downloads (Windows only)
 */
function setupContentSecurityPolicy(): void {
  const isDevelopment =
    process.env.NODE_ENV === "development" || !app.isPackaged;

  // Whitelisted external domains the app connects to.
  // Adding a new API integration? Add its domain here or requests will be blocked by CSP.
  const allowedConnectDomains = [
    "https://*.supabase.co", // Supabase backend (URL from SUPABASE_URL env var)
    "https://graph.microsoft.com", // Microsoft Graph API (mail, contacts)
    "https://login.microsoftonline.com", // Microsoft OAuth2 (all tenants)
    "https://accounts.google.com", // Google OAuth2 authentication
    "https://*.googleapis.com", // Google APIs (oauth2, www, maps)
    "https://www.apple.com", // Apple iTunes driver download (Windows)
  ].join(" ");

  // Log CSP mode on startup for debugging
  if (isDevelopment) {
    log.info("[CSP] Development mode - tightened CSP active");
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Configure CSP based on environment
    // Development: Allow localhost dev server and inline styles for HMR
    // Production: Strict CSP without unsafe-eval, connections restricted to whitelist
    const cspDirectives = isDevelopment
      ? [
          "default-src 'self'",
          // NOTE: 'unsafe-inline' required for Vite HMR - cannot be removed without
          // breaking hot module replacement. Production does not use this directive.
          "script-src 'self' 'unsafe-inline'",
          // NOTE: 'unsafe-inline' required for CSS-in-JS and dynamic styling.
          // This is also needed in production for the same reason.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: cid: https:",
          "font-src 'self' data:",
          // Tightened: Specific port 5173 for Vite dev server + whitelisted external domains
          // Port 5173 is Vite's default dev server port (see vite.config.js and package.json)
          `connect-src 'self' http://localhost:5173 ws://localhost:5173 ${allowedConnectDomains}`,
          "media-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "worker-src 'self' blob:",
          "upgrade-insecure-requests",
        ]
      : [
          "default-src 'self'",
          "script-src 'self'",
          // NOTE: 'unsafe-inline' required for CSS-in-JS and dynamic styling
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: cid: https:",
          "font-src 'self' data:",
          // Tightened: Only whitelisted external domains (no https: wildcard)
          `connect-src 'self' ${allowedConnectDomains}`,
          "media-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
          "worker-src 'self' blob:",
        ];

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [cspDirectives.join("; ")],
      },
    });
  });
}

/**
 * Set up permission handlers to deny all web permissions by default,
 * whitelisting only the permissions the app actually needs.
 *
 * This prevents the Electron app from granting permissions that could
 * be exploited (camera, microphone, geolocation, etc.) while allowing
 * clipboard and notification access needed for normal operation.
 */
function setupPermissionHandlers(): void {
  const allowedPermissions = new Set([
    "clipboard-read",
    "clipboard-sanitized-write",
    "notifications",
  ]);

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = allowedPermissions.has(permission);
      if (!allowed) {
        log.debug(
          `[Permissions] Denied permission request: ${permission}`
        );
      }
      callback(allowed);
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      return allowedPermissions.has(permission);
    }
  );

  log.info(
    "[Permissions] Permission handlers configured (deny-by-default, allowed: clipboard-read, clipboard-sanitized-write, notifications)"
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: WINDOW_CONFIG.DEFAULT_WIDTH,
    height: WINDOW_CONFIG.DEFAULT_HEIGHT,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    titleBarStyle: WINDOW_CONFIG.TITLE_BAR_STYLE as
      | "default"
      | "hidden"
      | "hiddenInset"
      | "customButtonsOnHover",
    backgroundColor: WINDOW_CONFIG.BACKGROUND_COLOR,
  });

  // Prevent closing while a submission is uploading
  mainWindow.on("close", (e) => {
    if (submissionService.isSubmitting) {
      e.preventDefault();
      dialog
        .showMessageBox(mainWindow!, {
          type: "warning",
          buttons: ["Keep Uploading", "Quit Anyway"],
          defaultId: 0,
          cancelId: 0,
          title: "Submission In Progress",
          message: "A transaction is being submitted to your broker.",
          detail:
            "Closing now will result in an incomplete submission. Are you sure you want to quit?",
        })
        .then(({ response }) => {
          if (response === 1) {
            // User chose "Quit Anyway" — force close
            mainWindow?.destroy();
          }
        });
    }
  });

  // Load the app
  if (isE2EServeDistMode()) {
    // BACKLOG-1940: unpackaged QA-driver run — load the BUILT dist/ assets via the
    // app:// protocol (registered below), NOT the Vite dev server. Deterministic,
    // no dev server needed. Dev-only + double-gated (see isE2EServeDistMode).
    log.info("[E2E] KEEPR_E2E=1 (unpackaged) — loading built dist/ via app:// protocol");
    mainWindow.loadURL('app://./index.html');
  } else if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    // TASK-2051: Use custom app:// protocol instead of file:// for security hardening.
    // This allows GrantFileProtocolExtraPrivileges fuse to be disabled.
    mainWindow.loadURL('app://./index.html');

    // Check for updates after window loads (only in production)
    // macOS App Translocation: When the app is run from a quarantined/translocated
    // path (e.g., /private/var/folders/.../AppTranslocation/...), Squirrel.Mac cannot
    // write to the app bundle, causing "Cannot update while running on a read-only volume".
    // Detect this and skip auto-update, notifying the user to move to /Applications.
    if (process.platform === "darwin" && process.execPath.includes("/AppTranslocation/")) {
      log.warn("[AutoUpdater] App Translocation detected — skipping auto-update. Path:", process.execPath);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app-translocation-detected");
        }
      }, UPDATE_CHECK_DELAY);
    } else {
      setTimeout(() => {
        // BACKLOG-1903/1905 (B2, organic path): autoDownload defaults to true
        // (AppUpdater.js:109), so a successful check immediately kicks off
        // downloadUpdate() and exposes its promise ONLY on the returned
        // UpdateCheckResult.downloadPromise. If that promise (or the check
        // promise, which re-throws after emitting "error" at AppUpdater.js:264-272)
        // rejects UNHANDLED, it reaches process.on("unhandledRejection")
        // (main.ts) and is captured WITHOUT the `component: auto-updater` tag,
        // so scrubUpdaterEventPII never runs and a raw signed-URL token
        // (X-Amz-Signature) ships. Attach no-op catches to BOTH: the real,
        // user-facing surfacing already happens via the tagged autoUpdater
        // "error" event → handleUpdaterError → surfaceUpdaterError. These
        // catches ONLY prevent the untagged/unscrubbed duplicate capture.
        autoUpdater
          .checkForUpdates()
          .then((result) => {
            result?.downloadPromise?.catch(() => {
              /* surfaced via the tagged autoUpdater "error" event */
            });
          })
          .catch(() => {
            /* surfaced via the tagged autoUpdater "error" event */
          });
      }, UPDATE_CHECK_DELAY);
    }
  }
}

// TASK-2330: Download stall detection timer
// If no download-progress event fires within DOWNLOAD_STALL_TIMEOUT_MS during
// an active download, we report a stall to Sentry so we can diagnose stuck updates.
let downloadStallTimer: ReturnType<typeof setTimeout> | null = null;

// ==========================================
// BACKLOG-1903: Auto-updater failure telemetry state
// ==========================================
// The last UpdateInfo seen from `update-available` — read by the error handler
// to enrich diagnostics with targetVersion / expected sha512+size.
let lastUpdateInfo: UpdaterUpdateInfoLike | null = null;
// Whether the in-flight download was a differential (blockmap) download.
let differentialDownloadInFlight = false;
// Ensures the "download started" breadcrumb fires only once per download cycle.
let downloadStartBreadcrumbEmitted = false;

// ==========================================
// BACKLOG-1905: Auto-update self-recovery state
// ==========================================
// Per-check-cycle attempt counters that drive the retry/fallback policy. Reset
// on `checking-for-update` alongside the 1903 telemetry state above. Recovery is
// keyed on errorType (see updaterRetryPolicy.decideRecovery):
//   - checksum_mismatch : force ONE full (non-differential) re-download, then surface.
//   - network_timeout   : retry the download up to N=2 (3 total) with backoff, then surface.
//   - everything else   : surface immediately.
let updaterRetryState: RetryState = createRetryState();

// BACKLOG-1905 (B3): whether the DOWNLOAD phase is reachable THIS check cycle.
// Set on `update-available` (guarantees updateInfoAndProvider != null), reset on
// `checking-for-update` alongside the retry-state reset. Recovery re-issues
// downloadUpdate(), which only makes sense once an update is available — a
// `network_timeout` from the CHECK phase (offline; updateInfoAndProvider null)
// would otherwise trigger a re-download that synchronously rejects with
// "Please check update first" (AppUpdater.js:437-440), re-enter here
// misclassified as `unknown`, and lose the original offline error. Keying on
// `update-available` (rather than the first `download-progress`) also restores
// the retry affordance for pre-first-byte download failures.
let updaterDownloadStarted = false;

/**
 * Whether Sentry is actually reporting in this process. Mirrors the init gate
 * at Sentry.init() (app.isPackaged || SENTRY_DSN present). When disabled,
 * Sentry.captureException() returns a synthetic id we must NOT treat as a real
 * event_id (BACKLOG-1903 REQUIRED change #4).
 */
function isSentryEnabled(): boolean {
  return app.isPackaged || !!process.env.SENTRY_DSN;
}

/**
 * BACKLOG-1903: Enriched auto-updater error handler.
 *
 * Shared by the real `autoUpdater.on("error")` listener AND the dev-only
 * "simulate update error" IPC so QA can deterministically drive each fingerprint
 * class through the EXACT production path.
 *
 * Responsibilities:
 * - Fingerprint the error (checksum/signature/network/…): Sentry groups by type
 *   via `fingerprint` + an indexed `errorType` tag.
 * - Attach structured, PII-safe diagnostics (targetVersion, feed/manifest URL,
 *   expected/actual sha512 + size, downloadMode). All URLs/strings are
 *   query-stripped and free of local paths (see updateDiagnostics.ts).
 * - Record a linkable snapshot (Sentry event_id + type) for support tickets.
 * - Forward a structured `{ message, errorType, sentryEventId }` payload to the
 *   renderer (still resilient to plain-string consumers during transition).
 */
function handleUpdaterError(err: Error): void {
  log.error("Error in auto-updater:", err);

  // FF3: clear the download-stall timer immediately on ANY updater error. The
  // clear in surfaceUpdaterError() is not reached when self-recovery early-returns
  // below, which would leave the 60s timer armed and fire a spurious
  // "download stalled" captureMessage after we've already handled the error.
  if (downloadStallTimer) {
    clearTimeout(downloadStallTimer);
    downloadStallTimer = null;
  }

  // Sanitize the feed URL (best-effort — getFeedURL may throw before configure).
  let rawFeedUrl: string | undefined;
  try {
    rawFeedUrl = autoUpdater.getFeedURL() ?? undefined;
  } catch {
    rawFeedUrl = undefined;
  }

  const diagnostics = extractUpdaterDiagnostics(err, lastUpdateInfo ?? undefined, {
    feedUrl: rawFeedUrl,
    differential: differentialDownloadInFlight,
  });
  const errorType = diagnostics.errorType;
  // Keep the historical field name used by prior handler + tests.
  const sanitizedMessage = diagnostics.sanitizedMessage;

  // ==========================================
  // BACKLOG-1905: self-recovery BEFORE surfacing
  // ==========================================
  // Consult the pure retry policy. For checksum_mismatch we force ONE clean full
  // (non-differential) re-download; for network_timeout we retry the download up
  // to N=2 with backoff. In both cases we emit a Sentry breadcrumb and RETURN
  // early WITHOUT capturing an exception or forwarding update-error to the
  // renderer — the user should never see a failure card while we're still
  // recovering. If the recovery attempt itself fails, autoUpdater fires `error`
  // again and we re-enter here with the counter advanced, eventually surfacing.
  //
  // NOTE: the dev-only simulate hook drives this branch so the breadcrumbs are
  // observable, but the REAL disableDifferentialDownload + downloadUpdate()
  // re-attempt is proven by a mocked-autoUpdater unit test
  // (executeRecovery in updaterRetryPolicy.test.ts).
  const decision = decideRecovery(errorType, updaterRetryState, updaterDownloadStarted);
  const recovered = executeRecovery(decision, updaterRetryState, autoUpdater, {
    onAttempt: (d) => {
      log.warn(`[AutoUpdater] self-recovery: ${d.reason}`);
      Sentry.addBreadcrumb({
        category: "auto-updater",
        message: `Self-recovery: ${d.reason}`,
        level: "info",
        data: {
          errorType,
          action: d.action,
          backoffMs: d.backoffMs,
          targetVersion: diagnostics.targetVersion,
        },
      });
    },
    onError: (retryErr) => {
      // B2: the DEFERRED recovery download rejected. Only LOG here — do NOT
      // Sentry.captureException(): a capture from this context would lack the
      // `component: auto-updater` tag and bypass scrubUpdaterEventPII (which is
      // tag-scoped), leaking raw X-Amz-Signature tokens. When the recovery
      // downloadUpdate() truly fails, electron-updater emits its own
      // autoUpdater "error", which re-enters handleUpdaterError and surfaces via
      // the tagged/scrubbed surfaceUpdaterError path.
      log.error("[AutoUpdater] Recovery download rejected:", retryErr);
    },
  });

  // If a recovery action was taken, do NOT surface yet — the user should never
  // see a failure card while we're still recovering. autoUpdater will fire
  // `error` again if the recovery attempt itself fails, re-entering here with the
  // counter advanced, so we eventually surface.
  if (recovered) return;

  // Recovery exhausted / not applicable — surface the failure (1903 behavior).
  surfaceUpdaterError(err, diagnostics, sanitizedMessage);
}

/**
 * BACKLOG-1903/1905: surface a FINAL (unrecoverable) updater failure — capture
 * to Sentry with a stable fingerprint, record a linkable snapshot for support
 * tickets, and forward a structured `update-error` payload to the renderer.
 *
 * Extracted from handleUpdaterError so the self-recovery path (1905) can decide
 * whether to recover first and only call this once recovery is exhausted.
 */
function surfaceUpdaterError(
  err: Error,
  diagnostics: ReturnType<typeof extractUpdaterDiagnostics>,
  sanitizedMessage: string,
): void {
  const errorType = diagnostics.errorType;

  // Build PII-safe structured context/extra. Undefined fields are dropped so we
  // never write empty/placeholder values or raw local paths into Sentry.
  const failureContext: Record<string, unknown> = {
    errorType,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    downloadMode: diagnostics.downloadMode,
  };
  if (diagnostics.targetVersion) failureContext.targetVersion = diagnostics.targetVersion;
  if (diagnostics.feedUrl) failureContext.feedUrl = diagnostics.feedUrl;
  if (diagnostics.manifestUrl) failureContext.manifestUrl = diagnostics.manifestUrl;
  if (diagnostics.expectedSha512) failureContext.expectedSha512 = diagnostics.expectedSha512;
  if (diagnostics.actualSha512) failureContext.actualSha512 = diagnostics.actualSha512;
  if (typeof diagnostics.expectedSize === "number") failureContext.expectedSize = diagnostics.expectedSize;
  if (typeof diagnostics.actualSize === "number") failureContext.actualSize = diagnostics.actualSize;

  // Context is searchable-per-event; also stamp it globally so any concurrent
  // event carries the same failure snapshot.
  Sentry.setContext("auto-updater-failure", failureContext);

  // Capture with a stable fingerprint so failures GROUP by errorType instead of
  // collapsing into the single generic "failed to verify" issue.
  const sentryEventId = Sentry.captureException(err, {
    fingerprint: ["auto-updater", errorType],
    tags: {
      component: "auto-updater",
      errorType,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      downloadMode: diagnostics.downloadMode,
    },
    extra: { ...failureContext, sanitizedMessage },
  });

  // REQUIRED #4: only treat the id as real when Sentry is actually enabled.
  const linkableEventId = isSentryEnabled() ? sentryEventId : null;

  // Record a linkable snapshot for support-ticket correlation (10-min window).
  setLastUpdaterFailure({
    sentryEventId: linkableEventId,
    errorType,
    targetVersion: diagnostics.targetVersion,
    at: Date.now(),
  });

  // TASK-2330: Clear stall timer on error to prevent stale fire.
  if (downloadStallTimer) {
    clearTimeout(downloadStallTimer);
    downloadStallTimer = null;
  }

  // macOS: Classify "read-only volume" errors as App Translocation issues and
  // surface actionable guidance instead of a generic error. Translocation takes
  // precedence over the generic error banner.
  const errMsg = err?.message?.toLowerCase() ?? "";
  const isTranslocationError =
    process.platform === "darwin" &&
    (errMsg.includes("read-only volume") || errMsg.includes("readonly"));

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (isTranslocationError) {
      log.warn("[AutoUpdater] Read-only volume error — likely App Translocation");
      mainWindow.webContents.send("app-translocation-detected");
    } else {
      // BACKLOG-1641/1903: Forward a STRUCTURED error payload so the UI can show
      // an error state (and 1905 can act on errorType). The renderer keeps a
      // string-or-object guard, so this stays backward compatible.
      mainWindow.webContents.send("update-error", {
        message: sanitizedMessage,
        errorType,
        sentryEventId: linkableEventId,
      });
    }
  }
}

const appStartTime = Date.now();
app.whenReady().then(async () => {
  log.debug(`[PERF] app.whenReady: ${Date.now() - appStartTime}ms`);
  // Configure auto-updater after app is ready
  autoUpdater.logger = log;

  // Auto-updater event handlers (TASK-2330: comprehensive Sentry monitoring)
  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for update...");
    // BACKLOG-1903: reset per-check failure-context state so a stale differential
    // flag from a previous cycle can't leak into a new failure's diagnostics.
    differentialDownloadInFlight = false;
    downloadStartBreadcrumbEmitted = false;
    // BACKLOG-1905: reset self-recovery counters for the new cycle, and clear the
    // differential-download override so a fresh check starts on the efficient
    // (blockmap) path again rather than being permanently forced to full.
    updaterRetryState = createRetryState();
    // BACKLOG-1905 (B3): a new cycle has no download in flight yet.
    updaterDownloadStarted = false;
    autoUpdater.disableDifferentialDownload = false;
    Sentry.addBreadcrumb({
      category: "auto-updater",
      message: "Checking for update",
      level: "info",
      data: { currentVersion: app.getVersion() },
    });
  });

  autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info);
    // BACKLOG-1903: store the UpdateInfo so the error handler can enrich
    // diagnostics with targetVersion / expected sha512 + size.
    lastUpdateInfo = {
      version: info.version,
      files: Array.isArray(info.files)
        ? info.files.map((f) => ({ url: f.url, sha512: f.sha512, size: f.size }))
        : undefined,
      sha512: (info as { sha512?: string }).sha512,
    };
    // BACKLOG-1905 (B3): mark the download phase as reachable this cycle. Keyed on
    // `update-available` (not the first `download-progress`) because that event
    // guarantees `updateInfoAndProvider != null` — the true invariant recovery
    // needs: re-issuing downloadUpdate() is now safe (won't hit the offline
    // "Please check update first" path, AppUpdater.js:437-440). This restores the
    // retry affordance for PRE-first-byte failures (connection refused / DNS /
    // 403 on the signed URL / blockmap fetch) that never emit download-progress,
    // while still preserving the check-phase gate: an offline check never fires
    // `update-available`, so the flag stays false and the failure surfaces at once.
    updaterDownloadStarted = true;
    Sentry.addBreadcrumb({
      category: "auto-updater",
      message: `Update available: ${info.version}`,
      level: "info",
      data: {
        version: info.version,
        fileCount: Array.isArray(info.files) ? info.files.length : 0,
        expectedSize: lastUpdateInfo.files?.find((f) => typeof f.size === "number")?.size,
      },
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-available", info);
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    log.info("Update not available:", info);
    Sentry.addBreadcrumb({ category: "auto-updater", message: `Update not available (current: ${info.version})`, level: "info" });
  });

  autoUpdater.on("error", (err) => handleUpdaterError(err));

  autoUpdater.on("download-progress", (progressObj) => {
    const message = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent.toFixed(2)}%`;
    log.info(message);
    // BACKLOG-1905 (B3): the download-phase gate (updaterDownloadStarted) is now
    // set on `update-available` — which always precedes download-progress and
    // guarantees updateInfoAndProvider != null — so no set is needed here.
    // BACKLOG-1903: emit a one-time "download started" breadcrumb so a later
    // failure's Sentry trail shows: check → available(version) → download → error.
    // electron-updater's ProgressInfo does not expose differential-vs-full, so
    // downloadMode is authoritatively derived at error time from the message.
    if (!downloadStartBreadcrumbEmitted) {
      downloadStartBreadcrumbEmitted = true;
      Sentry.addBreadcrumb({
        category: "auto-updater",
        message: "Download in progress",
        level: "info",
        data: {
          version: lastUpdateInfo?.version,
          totalBytes: progressObj.total,
        },
      });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-progress", progressObj);
    }
    // TASK-2330: Reset download stall detection timer on each progress event.
    // If no progress fires within DOWNLOAD_STALL_TIMEOUT_MS, report a stall.
    if (downloadStallTimer) {
      clearTimeout(downloadStallTimer);
    }
    downloadStallTimer = setTimeout(() => {
      Sentry.captureMessage("Auto-update download stalled — no progress for 60s", {
        level: "warning",
        tags: {
          component: "auto-updater",
          currentVersion: app.getVersion(),
        },
        extra: {
          lastPercent: progressObj.percent,
          lastBytesPerSecond: progressObj.bytesPerSecond,
        },
      });
      downloadStallTimer = null;
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded:", info);
    Sentry.addBreadcrumb({ category: "auto-updater", message: `Update downloaded: ${info.version}`, level: "info" });
    // TASK-2330: Clear stall timer — download completed successfully
    if (downloadStallTimer) {
      clearTimeout(downloadStallTimer);
      downloadStallTimer = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-downloaded", info);
    }
  });

  // ==========================================
  // CUSTOM APP PROTOCOL HANDLER (TASK-2051)
  // ==========================================
  // Register the app:// protocol handler to serve renderer content from dist/.
  // This replaces file:// protocol usage, allowing GrantFileProtocolExtraPrivileges
  // fuse to be disabled for security hardening.
  // Only needed in production -- dev mode uses Vite dev server (http://localhost:5173).
  // BACKLOG-1940: also register it for the unpackaged E2E-driver mode, which loads the
  // built dist/ assets via app:// (see isE2EServeDistMode). Dev-only + double-gated.
  if (app.isPackaged || isE2EServeDistMode()) {
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      // Decode URI-encoded characters in the pathname (e.g., %20 -> space)
      let pathname = decodeURIComponent(url.pathname);
      // Remove leading slash on Windows paths (app://./file -> /file -> file)
      if (process.platform === 'win32' && pathname.startsWith('/')) {
        pathname = pathname.slice(1);
      }
      // Resolve the file path relative to the dist/ directory
      // path.normalize prevents path traversal (../../etc/passwd -> etc/passwd)
      const normalizedPath = path.normalize(pathname);
      const distDir = path.join(__dirname, '..', 'dist');
      const filePath = path.join(distDir, normalizedPath);
      // Security: Ensure the resolved path is within the dist/ directory
      if (!filePath.startsWith(distDir)) {
        log.warn('[Protocol] Blocked path traversal attempt:', request.url);
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(`file://${filePath}`);
    });
    log.info('[Protocol] app:// protocol handler registered for production');
  }

  // Set up Content Security Policy
  setupContentSecurityPolicy();

  // Set up permission handlers (deny-by-default)
  setupPermissionHandlers();

  // Database initialization is now ALWAYS deferred to the renderer process
  // This allows us to show an explanation screen (KeychainExplanation) before the keychain prompt
  //
  // The renderer will call 'system:initialize-secure-storage' which handles:
  // 1. Database initialization (triggers keychain prompt)
  // 2. Clearing sessions/tokens for session-only OAuth

  // ==========================================
  // PRE-AUTH HEALTH CHECKS (TASK-2101)
  // ==========================================
  // Run system-level health checks before creating the window.
  // Critical failures (P0/P1) show a dialog and quit the app.
  // Warnings (P2) are logged to Sentry but don't block startup.
  const healthResult = await runStartupHealthChecks();
  if (!healthResult.passed) {
    log.error("[HealthCheck] Pre-auth health checks failed, quitting app");
    app.quit();
    return;
  }
  log.debug(`[PERF] post-healthChecks: ${Date.now() - appStartTime}ms`);

  log.debug(`[PERF] pre-createWindow: ${Date.now() - appStartTime}ms`);
  createWindow();
  log.debug(`[PERF] post-createWindow: ${Date.now() - appStartTime}ms`);

  // ==========================================
  // RENDERER CRASH RECOVERY (TASK-1968)
  // ==========================================
  // Handle renderer process crashes and unresponsive states
  // Uses native dialog (not renderer-based) since the renderer may be dead
  if (mainWindow) {
    mainWindow.webContents.on("render-process-gone", async (_event, details) => {
      console.error("[Main] Renderer process gone:", details.reason, details.exitCode);
      log.error("[Main] Renderer process gone:", details.reason, details.exitCode);

      // Skip dialog in development for 'killed' reason (DevTools reload causes this)
      if (!app.isPackaged && details.reason === "killed") {
        return;
      }

      // Capture crash in Sentry (TASK-1967)
      Sentry.captureMessage(`Renderer process gone: ${details.reason}`, {
        level: "fatal",
        extra: { reason: details.reason, exitCode: details.exitCode },
      });

      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "Application Error",
        message: "The application encountered an error.",
        detail: `Reason: ${details.reason}`,
        buttons: ["Reload", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });

      if (response === 0) {
        mainWindow?.webContents.reload();
      } else {
        app.quit();
      }
    });

    mainWindow.on("unresponsive", async () => {
      console.warn("[Main] Window became unresponsive");
      log.warn("[Main] Window became unresponsive");

      Sentry.captureMessage("Window became unresponsive", { level: "warning" });

      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "Application Not Responding",
        message: "The application is not responding.",
        detail: "Would you like to wait or reload?",
        buttons: ["Wait", "Reload", "Quit"],
        defaultId: 0,
        cancelId: 0,
      });

      if (response === 1) {
        mainWindow?.webContents.reload();
      } else if (response === 2) {
        app.quit();
      }
      // response === 0: Wait (do nothing)
    });
  }

  // ==========================================
  // COLD START DEEP LINK HANDLING (TASK-1500)
  // ==========================================
  // Handle deep link when app is cold started via URL
  // On macOS: URL comes through 'open-url' event, not command line
  // On Windows: URL is in process.argv
  if (process.platform === "win32") {
    const deepLinkUrl = process.argv.find((arg) => arg.startsWith("keepr://"));
    if (deepLinkUrl) {
      log.info("[DeepLink] Cold start with URL (Windows):", redactDeepLinkUrl(deepLinkUrl));
      // Wait for window to be ready before processing
      mainWindow?.webContents.once("did-finish-load", () => {
          handleDeepLinkCallback(deepLinkUrl);
      });
    }
  }
  // On macOS, cold start URLs come through the 'open-url' event which is already registered

  // Register existing handler modules
  registerAuthHandlers(mainWindow!);
  registerTransactionCrudHandlers(mainWindow!);
  registerTransactionExportHandlers(mainWindow!);
  registerTransactionSearchHandlers();
  registerEmailSyncHandlers(mainWindow!);
  registerEmailLinkingHandlers();
  registerEmailAutoLinkHandlers();
  registerAttachmentHandlers(mainWindow!);
  registerContactHandlers(mainWindow!);
  registerAddressHandlers();
  registerFeedbackHandlers();
  registerSystemHandlers();
  registerDiagnosticHandlers();
  registerUserSettingsHandlers();
  registerPreferenceHandlers();
  registerDeviceHandlers(mainWindow!);
  registerBackupHandlers(mainWindow!);
  registerSyncHandlers(mainWindow!);
  registerDriverHandlers();

  // Initialize LLM services and register handlers
  const llmConfigService = new LLMConfigService();
  registerLLMHandlers(llmConfigService);

  // Register license handlers
  registerLicenseHandlers();

  // Register feature gate handlers (SPRINT-122)
  registerFeatureGateHandlers();

  // Register per-transaction paywall entitlement handlers (BACKLOG-2006a)
  registerEntitlementHandlers();

  // Register PAYG card-purchase handlers (BACKLOG-2015)
  registerPaymentHandlers();

  // TASK-2086: Register pre-DB auth validation handler (SOC 2 CC6.1)
  registerPreAuthValidationHandler();

  // Register extracted handlers from handlers/ directory
  registerPermissionHandlers();
  registerConversationHandlers(mainWindow!);
  registerMessageImportHandlers(mainWindow!);
  registerOutlookHandlers(mainWindow!);
  registerUpdaterHandlers(mainWindow!);
  registerErrorLoggingHandlers();
  registerResetHandlers();
  registerAppCleanupHandlers();
  registerBackupRestoreHandlers();
  registerCcpaHandlers();
  registerFailureLogHandlers();
  registerSupportTicketHandlers();
  registerLocalSyncHandlers();

  // Android companion pairing (TASK-1428)
  registerPairingHandlers();

  // DEV-ONLY: Manual deep link handler for testing when protocol handler fails
  // Usage from DevTools console: window.api.system.manualDeepLink("keepr://callback?access_token=...&refresh_token=...")
  if (process.defaultApp) {
    ipcMain.handle("system:manual-deep-link", async (_event, url: string) => {
      log.info("[DeepLink] Manual trigger from DevTools:", redactDeepLinkUrl(url));
      await handleDeepLinkCallback(url);
      return { success: true };
    });
  }

  // ==========================================
  // BACKLOG-1903: DEV-ONLY updater-error simulation hook
  // ==========================================
  // Lets QA deterministically drive each fingerprint class through the SAME
  // production `handleUpdaterError` path so we can verify Sentry grouping,
  // structured fields, breadcrumbs, and ticket linkage without a real feed.
  // GATED on !app.isPackaged — this IPC is NOT registered in packaged builds.
  if (!app.isPackaged) {
    ipcMain.handle(
      "app:__simulate-update-error",
      async (_event, errorClass?: string) => {
        // Realistic electron-updater error strings per fingerprint class. The
        // signed-token URL below verifies the [SECURITY] sanitization path.
        const samples: Record<string, string> = {
          checksum_mismatch:
            "Error: sha512 checksum mismatch, expected Zm9vYmFyYmF6cXV4c3R1dg==, got YmFyYmF6cXV4c3R1dmZvbw== for https://objects.githubusercontent.com/asset/keepr.exe?X-Amz-Signature=deadbeef",
          signature_codesign:
            "Error: New version 2.99.0 is not signed by the application owner: SignerCertificate mismatch",
          network_timeout: "Error: net::ERR_CONNECTION_RESET",
          disk_space: "Error: ENOSPC: no space left on device, write",
          permission:
            "Error: EACCES: permission denied, open '/Applications/Keepr.app/Contents/Info.plist'",
          manifest_parse:
            "Error: Cannot parse latest.yml: unexpected token at line 3",
          feed_not_found:
            "HttpError: 404 Not Found while fetching latest.yml",
          unknown: "Error: something completely unexpected happened",
        };
        const key = errorClass && errorClass in samples ? errorClass : "unknown";
        const simulated = new Error(samples[key]);
        // Prime a target version so diagnostics carry targetVersion even without
        // a real update-available event in this simulated run.
        if (!lastUpdateInfo) {
          lastUpdateInfo = { version: "2.99.0" };
        }
        // BACKLOG-1905 (B3): the sim drives the DOWNLOAD-phase recovery path, so
        // mark a download as in flight — otherwise decideRecovery would treat
        // every simulated failure as a check-phase (offline) error and surface
        // immediately, defeating the point of the QA hook.
        updaterDownloadStarted = true;
        log.warn(`[AutoUpdater][DEV] Simulating update error: ${key}`);
        handleUpdaterError(simulated);
        return { success: true, simulated: key };
      },
    );
    log.info("[AutoUpdater][DEV] Registered app:__simulate-update-error IPC (dev only)");
  }

  // ==========================================
  // PERIODIC UPDATE CHECKS (TASK-1970)
  // ==========================================
  // Check for updates every 4 hours (production only)
  if (app.isPackaged) {
    const updateInterval = setInterval(() => {
      autoUpdater
        .checkForUpdates()
        .then((result) => {
          // BACKLOG-1903/1905 (B2, organic path): also handle the auto-download
          // promise rejection so a failed periodic download can't leak a raw
          // signed-URL token via the untagged unhandledRejection capture. The
          // failure is still surfaced through the tagged autoUpdater "error"
          // event → handleUpdaterError → surfaceUpdaterError.
          result?.downloadPromise?.catch(() => {
            /* surfaced via the tagged autoUpdater "error" event */
          });
        })
        .catch((err: Error) => {
          console.warn("[Update] Periodic check failed:", err.message);
        });
    }, UPDATE_CHECK_INTERVAL);

    // Clean up interval on quit (prevent memory leak)
    app.on("before-quit", () => {
      clearInterval(updateInterval);
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // TASK-1956: Shutdown persistent contact worker pool
  try {
    const { shutdownPool } = require("./workers/contactWorkerPool");
    shutdownPool();
  } catch { /* pool may not have been imported */ }
  // Clean up device detection polling
  cleanupDeviceHandlers();
  // Clean up sync handlers
  cleanupSyncHandlers();
  // Clean up transaction handlers (submission sync)
  cleanupTransactionHandlers();
  // Clean up local sync server (TASK-1429: Android Companion)
  cleanupLocalSyncHandlers();
  // Clean up pairing sessions (TASK-1428)
  cleanupPairingHandlers();
  // BACKLOG-1831: stop the shadow delta sync poller timers (interval hygiene)
  try {
    const { default: shadowDeltaSyncService } = require("./services/shadowDeltaSyncService");
    shadowDeltaSyncService.stop();
  } catch { /* service may never have been imported/started */ }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
