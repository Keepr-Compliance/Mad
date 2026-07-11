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
import { createHash } from "crypto";
import databaseService from "./databaseService";
import databaseEncryptionService from "./databaseEncryptionService";
import { syncStatusService } from "./syncStatusService";
import { getDeviceId } from "./deviceService";
import failureLogService from "./failureLogService";
import sessionService from "./sessionService";
import connectionStatusService from "./connectionStatusService";
import logService from "./logService";
// BACKLOG-1903: link support tickets to a recent auto-updater failure's Sentry event.
import { getRecentUpdaterFailure } from "./updaterFailureStore";
// BACKLOG-1918: iPhone-sync / Apple-driver diagnostics sources.
import { deviceDetectionService } from "./deviceDetectionService";
import type { IphoneSyncDiagnostic } from "./deviceDetectionService";
import { checkAppleDrivers } from "./appleDriverService";
import { pairingService } from "./pairingService";
import localSyncService from "./localSyncService";
import supabaseService from "./supabaseService";

/**
 * BACKLOG-1918: iPhone-sync / Apple-driver diagnostics section attached to
 * support tickets so iPhone-sync issues are self-diagnosing (incident: Zoe,
 * support ticket #64 — Apple Mobile Device driver not enumerating the device).
 *
 * PII-safe: status enums/booleans/counts only. NO UDID or serial numbers.
 * The section is keyed off `phone_type`: iPhone users get driver/USB signals,
 * Android users get WiFi-companion state (Keepr's Android path is a companion
 * app, not a USB driver).
 */
export interface IphoneSyncDiagnostics {
  /** User's selected phone type (from user_preferences), or "unknown". */
  phone_type: "iphone" | "android" | "unknown";
  /** libimobiledevice CLI tools available. */
  libimobiledevice_available: boolean;
  /** libimobiledevice reachable on PATH/bundled (macOS-focused signal). */
  libimobiledevice_in_path: boolean;
  /** Count of USB-detected devices (idevice_id -l). */
  connected_device_count: number;
  /** OS/USB level: device physically mounted (Windows PnP / macOS detection). */
  device_mounted: boolean;
  /** libimobiledevice level: connected_device_count > 0. */
  device_detected: boolean;
  /** device_mounted && !device_detected → Apple driver likely missing (Zoe's fingerprint). */
  driver_missing_suspected: boolean;
  /** Trust/lock state when a device is present-but-unusable; null otherwise. */
  trust_state: "locked" | "trust_pending" | "unknown" | null;
  /** Windows-only USB/driver/service/PnP block; null on other platforms. */
  windows: {
    apple_mobile_device_service: "running" | "stopped" | "not_found";
    apple_usb_driver_present: boolean;
    pnp_iphone_present: boolean;
  } | null;
  /** Explicit Apple Mobile Device Support driver status (checkAppleDrivers). */
  apple_driver: {
    is_installed: boolean;
    service_running: boolean;
    version: string | null;
  };
  /**
   * Android WiFi-companion state. Populated best-effort for all users but most
   * meaningful when phone_type === "android". In-memory only (not persisted).
   */
  android_companion: {
    paired: boolean;
    connected: boolean;
    device_count: number;
    last_seen: string | null;
    server_running: boolean;
    last_sync_at: string | null;
  };
  /** Supabase-synced user settings relevant to sync (from user_preferences). */
  user_settings: {
    phone_type: string | null;
    contact_sources_configured: boolean;
    iphone_sync_enabled: boolean | null;
  };
}

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
  /** BACKLOG-1918: iPhone-sync / Apple-driver diagnostics section. */
  iphone_sync: IphoneSyncDiagnostics;
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
 * BACKLOG-1917: Marker line that opens the inline diagnostics block appended
 * to a ticket's `description`. Kept as a constant so both the composer and the
 * consumer/tests reference the same delimiter and the user's own message stays
 * clearly separated from the machine-generated section.
 */
export const DIAGNOSTICS_BLOCK_HEADER = "--- Keepr Diagnostics ---";

/**
 * BACKLOG-1917: Compose a human-readable, PII-safe diagnostics summary from the
 * already-sanitized `AppDiagnostics` object, for appending to a support ticket's
 * `description`. This surfaces the key signals (OS, versions, sync/email status,
 * recent-error COUNT, and the iPhone-sync fingerprint that pinpointed Zoe's
 * driver issue) inline in EVERY ticket view — no attachment download required.
 *
 * PII-safety: this only reads status enums / booleans / counts / versions from
 * the collector, which is itself sanitized (paths, tokens, emails redacted). It
 * deliberately does NOT include raw error strings (only the count), UDID/serial,
 * device_id, or memory internals. Keep it that way when editing.
 */
export function composeDiagnosticsSummary(diag: AppDiagnostics): string {
  const yn = (v: boolean): string => (v ? "yes" : "no");

  const lines: string[] = [];
  lines.push(DIAGNOSTICS_BLOCK_HEADER);
  lines.push(
    `App: ${diag.app_version || "unknown"} (Electron ${diag.electron_version || "unknown"})`
  );
  lines.push(
    `OS: ${diag.os_platform || "unknown"} ${diag.os_version || ""} (${diag.os_arch || "unknown"})`.trim()
  );
  lines.push(`DB: initialized=${yn(diag.db_initialized)}, encrypted=${yn(diag.db_encrypted)}`);
  lines.push(
    `Sync: running=${yn(diag.sync_status.is_running)}` +
      (diag.sync_status.current_operation
        ? `, operation=${diag.sync_status.current_operation}`
        : "")
  );
  lines.push(
    `Email connections: google=${yn(diag.email_connections.google)}, microsoft=${yn(diag.email_connections.microsoft)}`
  );
  lines.push(`Recent errors (count): ${diag.recent_errors.length}`);
  lines.push(`Uptime: ${diag.uptime_seconds}s`);
  lines.push(composeIphoneSyncLine(diag.iphone_sync));
  lines.push(`Collected at: ${diag.collected_at}`);

  return lines.join("\n");
}

/**
 * BACKLOG-1917 / BACKLOG-1918: Compact one-to-two-line iPhone-sync summary. This
 * is the line that would have instantly shown Zoe's root cause (device mounted
 * at the OS level but not detected by libimobiledevice ⇒ Apple driver missing).
 * PII-safe: enums/booleans/counts only (no UDID/serial).
 */
function composeIphoneSyncLine(s: IphoneSyncDiagnostics): string {
  const yn = (v: boolean): string => (v ? "yes" : "no");
  const parts = [
    `phone_type=${s.phone_type}`,
    `devices=${s.connected_device_count}`,
    `mounted=${yn(s.device_mounted)}`,
    `detected=${yn(s.device_detected)}`,
    `driver_missing_suspected=${yn(s.driver_missing_suspected)}`,
    `apple_driver.installed=${yn(s.apple_driver.is_installed)}`,
    `apple_driver.service_running=${yn(s.apple_driver.service_running)}`,
    `iphone_sync_enabled=${s.user_settings.iphone_sync_enabled === null ? "unknown" : yn(s.user_settings.iphone_sync_enabled)}`,
  ];
  return `iPhone Sync: ${parts.join(", ")}`;
}

/**
 * BACKLOG-1917: Append the composed diagnostics summary block to a ticket's
 * description, keeping the user's original message clearly separated. Returns
 * the original description unchanged when no diagnostics were collected.
 */
export function appendDiagnosticsToDescription(
  description: string,
  diag: AppDiagnostics | null
): string {
  if (!diag) return description;
  const block = composeDiagnosticsSummary(diag);
  const base = description ?? "";
  // Two blank lines separate the human message from the machine block.
  return `${base}\n\n${block}`;
}

/**
 * BACKLOG-1932: Redact the raw machine ID before it enters the diagnostics
 * payload (diagnostics.json, uploaded to the support-attachments bucket).
 * `getDeviceId()` returns `machineIdSync(true)` — the full, unhashed, stable
 * machine GUID — which must never leave the device in that raw form. A
 * one-way SHA-256 hash (truncated for readability) keeps the value stable
 * per-machine, so support can still correlate tickets by `device_id`,
 * without exposing the underlying hardware identifier. `getDeviceId()`
 * itself and its other callers (deviceService registration/heartbeat, etc.)
 * are unchanged — only this write site is redacted.
 */
function redactDeviceId(rawDeviceId: string): string {
  return createHash("sha256").update(rawDeviceId).digest("hex").slice(0, 16);
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
    iphone_sync: defaultIphoneSyncDiagnostics(),
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
  // BACKLOG-1932: never write the raw machine ID into the diagnostics
  // payload — redact via one-way hash (stable per machine, non-reversible).
  try {
    diagnostics.device_id = redactDeviceId(getDeviceId());
  } catch {
    /* ignore */
  }

  // Uptime
  try {
    diagnostics.uptime_seconds = Math.round(process.uptime());
  } catch {
    /* ignore */
  }

  // BACKLOG-1918: iPhone-sync / Apple-driver diagnostics. Wrapped so partial
  // failure (e.g. no session, driver check throws) never breaks collection.
  try {
    diagnostics.iphone_sync = await collectIphoneSyncDiagnostics();
  } catch (err) {
    logService.warn(
      "[Support] iPhone-sync diagnostics collection failed",
      "SupportTicketService",
      { error: err instanceof Error ? err.message : String(err) }
    );
    /* keep default section */
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

/** PII-safe empty iphone_sync section used as the default/fallback. */
function defaultIphoneSyncDiagnostics(): IphoneSyncDiagnostics {
  return {
    phone_type: "unknown",
    libimobiledevice_available: false,
    libimobiledevice_in_path: false,
    connected_device_count: 0,
    device_mounted: false,
    device_detected: false,
    driver_missing_suspected: false,
    trust_state: null,
    windows: null,
    apple_driver: { is_installed: false, service_running: false, version: null },
    android_companion: {
      paired: false,
      connected: false,
      device_count: 0,
      last_seen: null,
      server_running: false,
      last_sync_at: null,
    },
    user_settings: {
      phone_type: null,
      contact_sources_configured: false,
      iphone_sync_enabled: null,
    },
  };
}

/**
 * BACKLOG-1918: Assemble the iphone_sync diagnostics section from existing
 * plumbing. Each source is independently guarded so one failure never blocks
 * the others. NO UDID/serial is ever read into the payload.
 */
async function collectIphoneSyncDiagnostics(): Promise<IphoneSyncDiagnostics> {
  const section = defaultIphoneSyncDiagnostics();

  // Device / driver signals (libimobiledevice, USB/PnP, trust, mounted-vs-detected).
  try {
    const dev: IphoneSyncDiagnostic =
      await deviceDetectionService.collectIphoneSyncDiagnostics();
    section.libimobiledevice_available = dev.libimobiledeviceAvailable;
    section.libimobiledevice_in_path = dev.libimobiledeviceInPath;
    section.connected_device_count = dev.connectedDeviceCount;
    section.device_mounted = dev.deviceMounted;
    section.device_detected = dev.deviceDetected;
    section.driver_missing_suspected = dev.driverMissingSuspected;
    section.trust_state = dev.trustState;
    section.windows = dev.windows
      ? {
          apple_mobile_device_service:
            dev.windows.appleUsbDriverService === "running"
              ? "running"
              : dev.windows.appleUsbDriverService === "stopped"
                ? "stopped"
                : "not_found",
          apple_usb_driver_present:
            dev.windows.appleUsbDriverService !== "not_found",
          pnp_iphone_present: dev.windows.pnpDeviceFound,
        }
      : null;
  } catch {
    /* keep defaults */
  }

  // Explicit Apple Mobile Device Support driver status.
  try {
    const driver = await checkAppleDrivers();
    section.apple_driver = {
      is_installed: driver.isInstalled,
      service_running: driver.serviceRunning,
      version: driver.version,
    };
  } catch {
    /* keep defaults */
  }

  // Android WiFi-companion state (in-memory; most meaningful for android users).
  try {
    const pairing = pairingService.getStatus();
    const lastSeen = pairing.devices.reduce<string | null>((latest, d) => {
      if (!d.lastSeen) return latest;
      if (!latest || d.lastSeen > latest) return d.lastSeen;
      return latest;
    }, null);
    // "connected" = a paired device was seen within the recency window.
    const CONNECTED_RECENCY_MS = 60_000;
    const connected =
      lastSeen !== null &&
      Date.now() - new Date(lastSeen).getTime() <= CONNECTED_RECENCY_MS;

    let serverRunning = false;
    let lastSyncAt: string | null = null;
    try {
      const sync = localSyncService.getStatus();
      serverRunning = sync.running;
      lastSyncAt =
        typeof sync.lastSyncTimestamp === "number"
          ? new Date(sync.lastSyncTimestamp).toISOString()
          : null;
    } catch {
      /* companion server status optional */
    }

    section.android_companion = {
      paired: pairing.isPaired,
      connected,
      device_count: pairing.devices.length,
      last_seen: lastSeen,
      server_running: serverRunning,
      last_sync_at: lastSyncAt,
    };
  } catch {
    /* keep defaults */
  }

  // Supabase-synced user settings (phone_type / contactSources / iphoneSyncEnabled).
  try {
    const session = await sessionService.loadSession();
    const userId = session?.user?.id;
    if (userId) {
      const prefs = await supabaseService.getPreferences(userId);
      const phoneType =
        typeof prefs?.phone_type === "string" ? prefs.phone_type : null;
      const iphoneSyncEnabled =
        typeof prefs?.integrations?.iphoneSyncEnabled === "boolean"
          ? prefs.integrations.iphoneSyncEnabled
          : null;
      const contactSourcesConfigured = hasConfiguredContactSources(
        prefs?.contactSources
      );

      section.user_settings = {
        phone_type: phoneType,
        contact_sources_configured: contactSourcesConfigured,
        iphone_sync_enabled: iphoneSyncEnabled,
      };

      // phone_type on the section is derived from the user's setting.
      if (phoneType === "iphone" || phoneType === "android") {
        section.phone_type = phoneType;
      }
    }
  } catch {
    /* keep defaults */
  }

  return section;
}

/**
 * Returns true if the user has enabled at least one contact source.
 * Only a boolean status is derived — the full config is NOT copied into the
 * payload. Shape: { direct?: {...bools}, inferred?: {...bools} }.
 */
function hasConfiguredContactSources(sources: unknown): boolean {
  if (!sources || typeof sources !== "object") return false;
  for (const group of Object.values(sources as Record<string, unknown>)) {
    if (group && typeof group === "object") {
      for (const val of Object.values(group as Record<string, unknown>)) {
        if (val === true) return true;
      }
    }
  }
  return false;
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
