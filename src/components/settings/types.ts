/**
 * Shared types for Settings sub-components
 */

// BACKLOG-2142: tighten `type` from loose `string` to the shared
// ConnectionErrorType union so the three-state (connected / expired /
// not-connected) comparisons in EmailSettings are compile-checked. `import
// type` is erased at build — no electron runtime deps leak into the renderer
// (same pattern as src/utils/connectionStatus.ts and src/services/systemService.ts).
import type { ConnectionErrorType } from "../../../electron/services/connectionStatusService";

export interface ConnectionError {
  type: ConnectionErrorType;
  userMessage: string;
  action?: string;
  actionHandler?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  email?: string;
  error?: ConnectionError | null;
}

export interface Connections {
  google: ConnectionStatus | null;
  microsoft: ConnectionStatus | null;
}

export interface PreferencesResult {
  success: boolean;
  error?: string;
  preferences?: {
    export?: {
      defaultFormat?: string;
    };
    scan?: {
      lookbackMonths?: number; // Legacy (TASK-2072: no longer used for scan, kept for read compat)
    };
    sync?: {
      autoSyncOnLogin?: boolean;
    };
    updates?: {
      autoDownload?: boolean;
    };
    notifications?: {
      enabled?: boolean;
    };
    contactSources?: {
      direct?: {
        outlookContacts?: boolean;
        gmailContacts?: boolean;
        googleContacts?: boolean;
        macosContacts?: boolean;
      };
      inferred?: {
        outlookEmails?: boolean;
        gmailEmails?: boolean;
        messages?: boolean;
      };
    };
    emailSync?: {
      lookbackMonths?: number; // Legacy key (backward compat)
    };
    emailCache?: {
      durationMonths?: number; // TASK-2072: new canonical key
    };
    audit?: {
      startDateDefault?: "auto" | "manual";
    };
    contactAutoRole?: {
      enabled?: boolean;
    };
  };
}

export interface ConnectionResult {
  success: boolean;
}

// TASK-2058: Human-readable labels for failure log operations
export const OPERATION_LABELS: Record<string, string> = {
  outlook_contacts_sync: "Outlook Contacts Sync",
  google_contacts_sync: "Google Contacts Sync",
  gmail_email_fetch: "Gmail Email Fetch",
  outlook_email_fetch: "Outlook Email Fetch",
  preferences_sync: "Preferences Sync",
  sign_out_all_devices: "Sign Out All Devices",
  check_for_updates: "Check for Updates",
  session_sync: "Session Sync",
};

/**
 * TASK-2062: Format a timestamp into a human-readable relative time string.
 * E.g., "Just now", "2 minutes ago", "3 hours ago", "Yesterday", etc.
 */
export function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0 || isNaN(diffMs)) return "Just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  return new Date(isoDate).toLocaleDateString();
}
