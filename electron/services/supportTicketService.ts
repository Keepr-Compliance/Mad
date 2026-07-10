/**
 * Support Ticket Service
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 *
 * Provides:
 * - collectDiagnostics(): Gather app diagnostics (PII-safe)
 * - captureScreenshot(): Capture screen via desktopCapturer
 * - sanitizeDiagnostics(): Strip PII from diagnostics data
 */

import { app, BrowserWindow } from "electron";
import * as os from "os";
import databaseService from "./databaseService";
import databaseEncryptionService from "./databaseEncryptionService";
import { syncStatusService } from "./syncStatusService";
import { getDeviceId } from "./deviceService";
import failureLogService from "./failureLogService";
import sessionService from "./sessionService";
import connectionStatusService from "./connectionStatusService";
import logService from "./logService";
import { getRecentUpdaterFailure } from "./updaterFailureStore";

/**
 * Diagnostics data collected from the app for support tickets.
 * All fields are PII-safe.
 */
export interface AppDiagnostics {
  app_version: string;
  electron_version: string;
  os_platform: string;
  os_version: string;
  os_arch: string;
  node_version: string;
  db_initialized: boolean;
  db_encrypted: boolean;
  sync_status: {
    is_running: boolean;
    current_operation: string | null;
  };
  email_connections: {
    google: boolean;
    microsoft: boolean;
  };
  memory_usage: {
    rss: number;
    heap_used: number;
    heap_total: number;
  };
  recent_errors: Array<{
    operation: string;
    error_message: string;
    timestamp: string;
  }>;
  device_id: string;
  uptime_seconds: number;
  collected_at: string;
  /**
   * BACKLOG-1903: When a support ticket is filed within ~10 min of an
   * auto-updater failure, these link the ticket to its Sentry event so it
   * arrives pre-diagnosed. Both are omitted when there is no recent failure.
   */
  sentry_event_id?: string | null;
  updater_failure?: {
    error_type: string;
    target_version?: string;
    at: string;
  };
}

/**
 * Collect app diagnostics for a support ticket.
 * Each field is wrapped in try-catch so partial failure doesn't break collection.
 */
export async function collectDiagnostics(): Promise<AppDiagnostics> {
  const diagnostics: AppDiagnostics = {
    app_version: "",
    electron_version: "",
    os_platform: "",
    os_version: "",
    os_arch: "",
    node_version: "",
    db_initialized: false,
    db_encrypted: false,
    sync_status: { is_running: false, current_operation: null },
    email_connections: { google: false, microsoft: false },
    memory_usage: { rss: 0, heap_used: 0, heap_total: 0 },
    recent_errors: [],
    device_id: "",
    uptime_seconds: 0,
    collected_at: new Date().toISOString(),
  };

  // App & platform info
  try {
    diagnostics.app_version = app.getVersion();
  } catch {
    /* ignore */
  }
  try {
    diagnostics.electron_version = process.versions.electron;
  } catch {
    /* ignore */
  }
  try {
    diagnostics.os_platform = process.platform;
  } catch {
    /* ignore */
  }
  try {
    diagnostics.os_version = os.release();
  } catch {
    /* ignore */
  }
  try {
    diagnostics.os_arch = process.arch;
  } catch {
    /* ignore */
  }
  try {
    diagnostics.node_version = process.versions.node;
  } catch {
    /* ignore */
  }

  // Database status
  try {
    diagnostics.db_initialized = databaseService.isInitialized();
  } catch {
    /* ignore */
  }
  try {
    diagnostics.db_encrypted = databaseEncryptionService.isEncryptionAvailable();
  } catch {
    /* ignore */
  }

  // Sync status
  try {
    const syncStatus = syncStatusService.getStatus();
    diagnostics.sync_status = {
      is_running: syncStatus.isAnyOperationRunning,
      current_operation: syncStatus.currentOperation,
    };
  } catch {
    /* ignore */
  }

  // Email connections (only connected status, no tokens or email content)
  try {
    const session = await sessionService.loadSession();
    if (session?.user?.id) {
      const connectionStatus = await connectionStatusService.checkAllConnections(session.user.id);
      diagnostics.email_connections = {
        google: connectionStatus.google.connected,
        microsoft: connectionStatus.microsoft.connected,
      };
    }
  } catch {
    /* ignore */
  }

  // Memory usage
  try {
    const mem = process.memoryUsage();
    diagnostics.memory_usage = {
      rss: mem.rss,
      heap_used: mem.heapUsed,
      heap_total: mem.heapTotal,
    };
  } catch {
    /* ignore */
  }

  // Recent errors from failure log (last 10, sanitized)
  try {
    const failures = await failureLogService.getRecentFailures(10);
    diagnostics.recent_errors = failures.map((f) => ({
      operation: f.operation,
      error_message: f.error_message,
      timestamp: f.timestamp,
    }));
  } catch {
    /* ignore */
  }

  // Device info
  try {
    diagnostics.device_id = getDeviceId();
  } catch {
    /* ignore */
  }

  // Uptime
  try {
    diagnostics.uptime_seconds = Math.round(process.uptime());
  } catch {
    /* ignore */
  }

  // BACKLOG-1903: link this ticket to a recent auto-updater failure's Sentry
  // event so support tickets arrive pre-diagnosed. Only present if a failure
  // occurred within the ~10-minute linkage window.
  try {
    const failure = getRecentUpdaterFailure();
    if (failure) {
      diagnostics.sentry_event_id = failure.sentryEventId;
      diagnostics.updater_failure = {
        error_type: failure.errorType,
        target_version: failure.targetVersion,
        at: new Date(failure.at).toISOString(),
      };
    }
  } catch {
    /* ignore */
  }

  return sanitizeDiagnostics(diagnostics);
}

/**
 * Capture a screenshot of the focused app window via webContents.capturePage().
 * Uses Chromium's built-in page capture — no screen recording permission needed.
 * Returns a base64-encoded PNG string, or null on failure.
 */
export async function captureScreenshot(): Promise<string | null> {
  try {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) {
      logService.warn("[Support] No focused window for screenshot", "SupportTicketService");
      return null;
    }

    // BACKLOG-1353: Hide support dialog/widget before capturing so the
    // screenshot shows the actual app content, not the overlay.
    await win.webContents.executeJavaScript(`
      document.querySelectorAll('[data-support-widget]').forEach(el => el.style.visibility = 'hidden');
    `);

    // Brief delay for the DOM to repaint after hiding
    await new Promise((resolve) => setTimeout(resolve, 150));

    try {
      const image = await win.webContents.capturePage();
      const pngBuffer = image.toPNG();

      return pngBuffer.toString("base64");
    } finally {
      // Always restore support widget visibility, even if capture fails
      await win.webContents.executeJavaScript(`
        document.querySelectorAll('[data-support-widget]').forEach(el => el.style.visibility = 'visible');
      `);
    }
  } catch (err) {
    logService.error(
      "[Support] Screenshot capture failed",
      "SupportTicketService",
      { error: err instanceof Error ? err.message : String(err) }
    );
    return null;
  }
}

/**
 * Sanitize diagnostics to remove PII patterns.
 * - Replaces home directory paths with ~
 * - Removes token/key patterns from error messages
 * - Truncates error messages
 */
function sanitizeDiagnostics(diag: AppDiagnostics): AppDiagnostics {
  const homeDir = os.homedir();

  // Sanitize recent errors
  diag.recent_errors = diag.recent_errors.map((err) => ({
    ...err,
    error_message: sanitizeString(err.error_message, 200),
  }));

  // Deep-sanitize the entire object by converting to string and replacing home paths
  const serialized = JSON.stringify(diag);
  const sanitized = serialized.replace(
    new RegExp(escapeRegExp(homeDir), "g"),
    "~"
  );

  return JSON.parse(sanitized) as AppDiagnostics;
}

/**
 * Sanitize a string by removing PII patterns and truncating.
 */
function sanitizeString(str: string, maxLength: number): string {
  let sanitized = str;

  // Remove bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]");

  // Remove common key/token patterns (hex or base64 strings > 20 chars)
  sanitized = sanitized.replace(
    /(?:key|token|secret|password|apikey|api_key)[\s=:]+["']?[A-Za-z0-9\-._~+/]{20,}["']?/gi,
    "[REDACTED_CREDENTIAL]"
  );

  // Remove email addresses
  sanitized = sanitized.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]"
  );

  // Replace home directory
  try {
    const homeDir = os.homedir();
    sanitized = sanitized.replace(new RegExp(escapeRegExp(homeDir), "g"), "~");
  } catch {
    /* ignore */
  }

  // Truncate
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "...";
  }

  return sanitized;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
