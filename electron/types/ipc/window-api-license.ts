/**
 * WindowApi License, Feature Gate, Support, and related sub-interfaces
 * License management, device registration, feature gates, support tickets,
 * database backup, privacy/CCPA, and failure logging
 */

import type { UserLicense } from "../models";

/**
 * License API (BACKLOG-426, SPRINT-062)
 */
export interface WindowApiLicense {
  /** Get current user's license information */
  get: () => Promise<{
    success: boolean;
    license?: UserLicense;
    error?: string;
  }>;
  /** Refresh license data from database */
  refresh: () => Promise<{
    success: boolean;
    license?: UserLicense;
    error?: string;
  }>;

  // ============================================
  // SPRINT-062: License Validation Methods
  // ============================================

  /** Validates the user's license status */
  validate: (userId: string) => Promise<{
    isValid: boolean;
    licenseType: "trial" | "individual" | "team";
    trialStatus?: "active" | "expired" | "converted";
    trialDaysRemaining?: number;
    transactionCount: number;
    transactionLimit: number;
    canCreateTransaction: boolean;
    deviceCount: number;
    deviceLimit: number;
    aiEnabled: boolean;
    // BACKLOG-2148: 'load_error' is a soft, non-blocking reason (always isValid:true).
    blockReason?: "expired" | "limit_reached" | "no_license" | "suspended" | "load_error";
  }>;

  /** Creates a trial license for a new user */
  create: (userId: string) => Promise<{
    isValid: boolean;
    licenseType: "trial" | "individual" | "team";
    trialStatus?: "active" | "expired" | "converted";
    trialDaysRemaining?: number;
    transactionCount: number;
    transactionLimit: number;
    canCreateTransaction: boolean;
    deviceCount: number;
    deviceLimit: number;
    aiEnabled: boolean;
    // BACKLOG-2148: 'load_error' is a soft, non-blocking reason (always isValid:true).
    blockReason?: "expired" | "limit_reached" | "no_license" | "suspended" | "load_error";
  }>;

  /** Increments the user's transaction count */
  incrementTransactionCount: (userId: string) => Promise<number>;

  /** Clears the license cache (call on logout) */
  clearCache: () => Promise<void>;

  // canPerformAction removed (BACKLOG-1783): the former IPC accepted a
  // renderer-supplied (spoofable) status and echoed an allow/deny decision.
  // Entitlements are derived from the main-owned `validate` result instead.

  // ============================================
  // SPRINT-062: Device Registration Methods
  // ============================================

  /** Registers the current device for the user */
  registerDevice: (userId: string) => Promise<{
    success: boolean;
    device?: {
      id: string;
      user_id: string;
      device_id: string;
      device_name: string | null;
      os: string | null;
      platform: "macos" | "windows" | "linux" | null;
      app_version: string | null;
      is_active: boolean;
      last_seen_at: string;
      activated_at: string;
    };
    error?: "device_limit_reached" | "already_registered" | "unknown";
  }>;

  /** Lists all registered devices for a user */
  listRegisteredDevices: (userId: string) => Promise<Array<{
    id: string;
    user_id: string;
    device_id: string;
    device_name: string | null;
    os: string | null;
    platform: "macos" | "windows" | "linux" | null;
    app_version: string | null;
    is_active: boolean;
    last_seen_at: string;
    activated_at: string;
  }>>;

  /** Deactivates a device */
  deactivateDevice: (userId: string, deviceId: string) => Promise<void>;

  /** Deletes a device registration */
  deleteDevice: (userId: string, deviceId: string) => Promise<void>;

  /** Gets the current device's ID */
  getCurrentDeviceId: () => Promise<string>;

  /** Checks if the current device is registered */
  isDeviceRegistered: (userId: string) => Promise<boolean>;

  /** Sends a heartbeat to update device last_seen_at */
  deviceHeartbeat: (userId: string) => Promise<void>;
}

/**
 * Database Backup & Restore API (TASK-2052)
 */
export interface WindowApiDatabaseBackup {
  /** Create a backup of the local SQLite database (opens save dialog) */
  backup: () => Promise<{
    success: boolean;
    cancelled?: boolean;
    filePath?: string;
    fileSize?: number;
    error?: string;
  }>;
  /** Restore database from a backup file (opens file picker + confirmation) */
  restore: () => Promise<{
    success: boolean;
    cancelled?: boolean;
    error?: string;
    requiresRestart?: boolean;
  }>;
  /** Get database file info (size, last modified date) */
  getInfo: () => Promise<{
    success: boolean;
    info?: {
      filePath: string;
      fileSize: number;
      lastModified: string;
    } | null;
    error?: string;
  }>;
}

/**
 * Privacy / CCPA Data Export API (TASK-2053)
 */
export interface WindowApiPrivacy {
  /** Export all personal data as a JSON file (CCPA compliance) */
  exportData: (userId: string) => Promise<{
    success: boolean;
    filePath?: string;
    error?: string;
  }>;
  /** Listen for export progress updates */
  onExportProgress: (callback: (progress: {
    category: string;
    progress: number;
  }) => void) => () => void;
}

/**
 * Failure Log API for offline diagnostics (TASK-2058)
 */
export interface WindowApiFailureLog {
  /** Get recent failure log entries */
  getRecent: (limit?: number) => Promise<{
    success: boolean;
    entries: Array<{
      id: number;
      timestamp: string;
      operation: string;
      error_message: string;
      metadata: string | null;
      acknowledged: number;
    }>;
    error?: string;
  }>;
  /** Get count of unacknowledged failures */
  getCount: () => Promise<{
    success: boolean;
    count: number;
    error?: string;
  }>;
  /** Mark all failures as acknowledged */
  acknowledgeAll: () => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Clear entire failure log */
  clear: () => Promise<{
    success: boolean;
    error?: string;
  }>;
}

/**
 * Feature Gate API (SPRINT-122)
 */
export interface WindowApiFeatureGate {
  /** Check access to a specific feature */
  check: (featureKey: string) => Promise<{
    allowed: boolean;
    value: string;
    source: "plan" | "override" | "default";
  }>;
  /** Get all features for the current organization */
  getAll: () => Promise<Record<string, {
    allowed: boolean;
    value: string;
    source: "plan" | "override" | "default";
  }>>;
  /** Invalidate the feature gate cache */
  invalidateCache: () => Promise<void>;
}

/**
 * Support Ticket API (TASK-2180)
 */
export interface WindowApiSupport {
  /** Collect app diagnostics (PII-safe) */
  collectDiagnostics: () => Promise<{
    success: boolean;
    diagnostics?: {
      app_version: string;
      electron_version: string;
      os_platform: string;
      os_version: string;
      os_arch: string;
      node_version: string;
      db_initialized: boolean;
      db_encrypted: boolean;
      sync_status: { is_running: boolean; current_operation: string | null };
      email_connections: { google: boolean; microsoft: boolean };
      memory_usage: { rss: number; heap_used: number; heap_total: number };
      recent_errors: Array<{ operation: string; error_message: string; timestamp: string }>;
      device_id: string;
      uptime_seconds: number;
      collected_at: string;
    };
    error?: string;
  }>;
  /** Capture a screenshot */
  captureScreenshot: () => Promise<{
    success: boolean;
    screenshot?: string | null;
    error?: string;
  }>;
  /** Get support categories */
  getCategories: () => Promise<{
    success: boolean;
    categories?: Array<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      parent_id: string | null;
      sort_order: number;
      is_active: boolean;
    }>;
    error?: string;
  }>;
  /** Submit a support ticket */
  submitTicket: (
    params: {
      subject: string;
      description: string;
      priority: string;
      category_id: string | null;
      requester_email: string;
      requester_name: string;
    },
    screenshotBase64: string | null,
    diagnosticsData: Record<string, unknown> | null
  ) => Promise<{
    success: boolean;
    ticket_id?: string;
    ticket_number?: number;
    error?: string;
  }>;
}
