/**
 * WindowApi Services sub-interfaces
 * Smaller service APIs: preferences, user, feedback, address, shell,
 * notification, update, errorLogging, app, llm
 */

import type { LLMHandlerResponse, LLMUserConfig, LLMPreferences, LLMUsageStats, LLMAvailability, LLMProvider } from "./llm";

/**
 * Preferences methods on window.api
 */
export interface WindowApiPreferences {
  get: (
    userId: string,
  ) => Promise<{ success: boolean; preferences?: Record<string, unknown> }>;
  save: (
    userId: string,
    preferences: Record<string, unknown>,
  ) => Promise<{ success: boolean }>;
  update: (
    userId: string,
    partialPreferences: Record<string, unknown>,
  ) => Promise<{ success: boolean }>;
}

/**
 * LLM methods on window.api
 */
export interface WindowApiLlm {
  getConfig: (userId: string) => Promise<LLMHandlerResponse<LLMUserConfig>>;
  setApiKey: (
    userId: string,
    provider: LLMProvider,
    apiKey: string,
  ) => Promise<LLMHandlerResponse<void>>;
  validateKey: (
    provider: LLMProvider,
    apiKey: string,
  ) => Promise<LLMHandlerResponse<boolean>>;
  removeApiKey: (
    userId: string,
    provider: LLMProvider,
  ) => Promise<LLMHandlerResponse<void>>;
  updatePreferences: (
    userId: string,
    preferences: LLMPreferences,
  ) => Promise<LLMHandlerResponse<void>>;
  recordConsent: (
    userId: string,
    consent: boolean,
  ) => Promise<LLMHandlerResponse<void>>;
  getUsage: (userId: string) => Promise<LLMHandlerResponse<LLMUsageStats>>;
  canUse: (userId: string) => Promise<LLMHandlerResponse<LLMAvailability>>;
}

/**
 * Feedback methods for AI transaction detection
 */
export interface WindowApiFeedback {
  submit: (
    userId: string,
    feedbackData: Record<string, unknown>,
  ) => Promise<{ success: boolean; feedbackId?: string; error?: string }>;
  getForTransaction: (
    transactionId: string,
  ) => Promise<{ success: boolean; feedback?: unknown[]; error?: string }>;
  getMetrics: (
    userId: string,
    fieldName: string,
  ) => Promise<{ success: boolean; metrics?: unknown; error?: string }>;
  getSuggestion: (
    userId: string,
    fieldName: string,
    extractedValue: unknown,
    confidence: number,
  ) => Promise<{ success: boolean; suggestion?: unknown; confidence?: number; error?: string }>;
  getLearningStats: (
    userId: string,
    fieldName: string,
  ) => Promise<{ success: boolean; stats?: unknown; error?: string }>;
  recordTransaction: (
    userId: string,
    feedback: {
      detectedTransactionId: string;
      action: "confirm" | "reject" | "merge";
      corrections?: {
        propertyAddress?: string;
        transactionType?: string;
        addCommunications?: string[];
        removeCommunications?: string[];
        reason?: string;
      };
      modelVersion?: string;
      promptVersion?: string;
    },
  ) => Promise<{ success: boolean; error?: string }>;
  recordRole: (
    userId: string,
    feedback: {
      transactionId: string;
      contactId: string;
      originalRole: string;
      correctedRole: string;
      modelVersion?: string;
      promptVersion?: string;
    },
  ) => Promise<{ success: boolean; error?: string }>;
  recordRelevance: (
    userId: string,
    feedback: {
      communicationId: string;
      wasRelevant: boolean;
      correctTransactionId?: string;
      modelVersion?: string;
      promptVersion?: string;
    },
  ) => Promise<{ success: boolean; error?: string }>;
  getStats: (
    userId: string,
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
}

/**
 * User preference methods (stored in local database)
 */
export interface WindowApiUser {
  getPhoneType: (userId: string) => Promise<{
    success: boolean;
    phoneType: "iphone" | "android" | null;
    error?: string;
  }>;
  setPhoneType: (
    userId: string,
    phoneType: "iphone" | "android",
  ) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Address lookup methods on window.api
 */
export interface WindowApiAddress {
  initialize: (
    apiKey: string,
  ) => Promise<{ success: boolean; error?: string }>;
  getSuggestions: (
    input: string,
    sessionToken?: string,
  ) => Promise<{
    success: boolean;
    suggestions?: Array<{ description: string; placeId: string }>;
    error?: string;
  }>;
  getDetails: (placeId: string) => Promise<{
    success: boolean;
    address?: {
      formatted_address?: string;
      street?: string;
      city?: string;
      state?: string;
      state_short?: string;
      zip?: string;
      coordinates?: { lat: number; lng: number };
    };
    formatted_address?: string;
    street?: string;
    city?: string;
    state?: string;
    state_short?: string;
    zip?: string;
    coordinates?: { lat: number; lng: number };
    error?: string;
  }>;
  geocode: (
    address: string,
  ) => Promise<{ lat: number; lng: number; formattedAddress: string }>;
}

/**
 * Shell methods on window.api
 */
export interface WindowApiShell {
  /**
   * Open a URL in the user's default external browser.
   *
   * BACKLOG-2126: The main-process handler ("shell:open-external", wrapped by
   * wrapHandler) ALWAYS RESOLVES with `{ success, error? }` and never rejects —
   * a blocked protocol, invalid URL, or shell failure comes back as a resolved
   * `{ success: false, error }`, NOT a thrown rejection. The type must reflect
   * that so callers can inspect the result and surface a real failure (a
   * `Promise<void>` type here hid failures as silent successes).
   */
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  openPopup: (url: string, title?: string) => Promise<{ success: boolean }>;
  openFolder: (folderPath: string) => Promise<{ success: boolean }>;
}

/**
 * OS Notifications on window.api
 */
export interface WindowApiNotification {
  /** Check if notifications are supported on this platform */
  isSupported: () => Promise<{ success: boolean; supported: boolean }>;
  /** Send an OS notification */
  send: (title: string, body: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * BACKLOG-1903: Fingerprint classes for an auto-updater failure. Mirrors
 * `UpdaterErrorType` in electron/services/updateDiagnostics.ts. Kept as a plain
 * string union here so renderer/preload types don't import main-process code.
 */
export type UpdateErrorType =
  | "checksum_mismatch"
  | "signature_codesign"
  | "network_timeout"
  | "disk_space"
  | "permission"
  | "manifest_parse"
  | "feed_not_found"
  | "unknown";

/**
 * BACKLOG-1903: Structured payload delivered to the renderer on `update-error`.
 * `sentryEventId` is only populated when Sentry is enabled (null in dev).
 */
export interface UpdateErrorPayload {
  message: string;
  errorType: UpdateErrorType;
  sentryEventId: string | null;
}

/**
 * Auto-update methods (migrated from window.electron)
 */
export interface WindowApiUpdate {
  onAvailable: (callback: (info: unknown) => void) => () => void;
  onProgress: (callback: (progress: unknown) => void) => () => void;
  onDownloaded: (callback: (info: unknown) => void) => () => void;
  /**
   * BACKLOG-1641/1903: Listen for auto-updater errors (checksum failure,
   * network, etc.). The payload is a structured {@link UpdateErrorPayload};
   * a bare string may still arrive from legacy emitters, so consumers must
   * guard with a typeof check before reading `.message`.
   */
  onError: (callback: (error: UpdateErrorPayload | string) => void) => () => void;
  install: () => void;
  checkForUpdates: () => Promise<{
    updateAvailable: boolean;
    version?: string;
    currentVersion: string;
    error?: string;
    translocationDetected?: boolean;
  }>;
  /** Fires when macOS App Translocation is detected (app not in /Applications) */
  onTranslocationDetected: (callback: () => void) => () => void;
  /**
   * BACKLOG-1905: open the one-click, platform-correct manual installer for the
   * exact target-version asset. Used by the failed-update recovery card so a
   * user can self-recover in one click.
   */
  openManualInstaller: () => Promise<{
    success: boolean;
    url?: string;
    error?: string;
  }>;
  /**
   * BACKLOG-1903 DEV-ONLY: deterministically trigger an updater failure of a
   * given fingerprint class through the real error path (QA harness). Resolves
   * `undefined`/throws in packaged builds where the IPC is not registered.
   */
  simulateUpdateError?: (
    errorClass?: UpdateErrorType,
  ) => Promise<{ success: boolean; simulated: string }>;
}

/**
 * Error Logging API (TASK-1800)
 */
export interface WindowApiErrorLogging {
  /**
   * Submit an error report to Supabase
   * @param payload - Error details and optional user feedback
   * @returns Result with success status and error ID
   */
  submit: (payload: {
    errorType: string;
    errorCode?: string;
    errorMessage: string;
    stackTrace?: string;
    currentScreen?: string;
    userFeedback?: string;
    breadcrumbs?: Record<string, unknown>[];
    appState?: Record<string, unknown>;
  }) => Promise<{
    success: boolean;
    errorId?: string;
    error?: string;
  }>;
  /**
   * Process queued errors (call when connection restored)
   * @returns Number of errors successfully processed
   */
  processQueue: () => Promise<{
    success: boolean;
    processedCount?: number;
    error?: string;
  }>;
  /**
   * Get current queue size (for diagnostics)
   * @returns Queue size
   */
  getQueueSize: () => Promise<{
    success: boolean;
    queueSize?: number;
    error?: string;
  }>;
}

/**
 * App Reset API (TASK-1802)
 */
export interface WindowApiApp {
  /**
   * Perform a complete app data reset
   * WARNING: This is a destructive operation that will:
   * - Delete all local data (database, preferences, cached data)
   * - Restart the app fresh
   *
   * Cloud data (Supabase) is NOT affected.
   *
   * @returns Result with success status
   */
  reset: () => Promise<{
    success: boolean;
    error?: string;
  }>;
}

/**
 * App-data cleanup engine (BACKLOG-2111).
 *
 * Full wipe of every local artifact Keepr owns plus OS secret stores
 * (macOS keychain / Windows Credential Manager), via a detached helper that
 * outlives the app process. Cloud data (Supabase) is NOT affected.
 */

/** Result of a cleanup operation (mirrors CleanupResult in appCleanupService). */
export interface AppCleanupResult {
  success: boolean;
  mode: "reset" | "uninstall";
  removedPaths?: string[];
  /**
   * True when uninstall was requested but app removal was skipped because the
   * install location failed sanity checks. App data is still wiped. (BACKLOG-2111)
   */
  appRemovalSkipped?: boolean;
  error?: string;
}

/**
 * Optional payload accepted by both cleanup modes (BACKLOG-2112). The `reason`
 * is forwarded to the lifecycle log (BACKLOG-2113) BEFORE any wipe.
 */
export interface AppCleanupOptions {
  reason?: string;
}

export interface WindowApiAppCleanup {
  /**
   * Wipe all local app data + OS secrets, then relaunch into onboarding.
   * WARNING: destructive.
   *
   * @param options optional `{ reason?: string }` recorded pre-wipe.
   */
  reset: (options?: AppCleanupOptions) => Promise<AppCleanupResult>;
  /**
   * Wipe all local app data + OS secrets AND remove the application itself,
   * then quit. WARNING: destructive.
   *
   * @param options optional `{ reason?: string }` recorded pre-wipe.
   */
  uninstall: (options?: AppCleanupOptions) => Promise<AppCleanupResult>;
}
