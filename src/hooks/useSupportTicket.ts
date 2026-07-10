/**
 * useSupportTicket Hook
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 *
 * Manages the state and submission logic for in-app support tickets.
 * All operations go through IPC to the main process (no direct Supabase access).
 */

import { useState, useCallback, useEffect } from "react";
import logger from "../utils/logger";

/** Priority values matching the support platform */
export type TicketPriority = "low" | "normal" | "high" | "urgent";

/**
 * BACKLOG-1918: iPhone-sync / Apple-driver diagnostics section.
 * Mirrors the main-process `IphoneSyncDiagnostics` shape (electron/services/
 * supportTicketService.ts). PII-safe: status enums/booleans/counts only.
 */
export interface IphoneSyncDiagnostics {
  phone_type: "iphone" | "android" | "unknown";
  libimobiledevice_available: boolean;
  libimobiledevice_in_path: boolean;
  connected_device_count: number;
  device_mounted: boolean;
  device_detected: boolean;
  driver_missing_suspected: boolean;
  trust_state: "locked" | "trust_pending" | "unknown" | null;
  windows: {
    apple_mobile_device_service: "running" | "stopped" | "not_found";
    apple_usb_driver_present: boolean;
    pnp_iphone_present: boolean;
  } | null;
  apple_driver: {
    is_installed: boolean;
    service_running: boolean;
    version: string | null;
  };
  android_companion: {
    paired: boolean;
    connected: boolean;
    device_count: number;
    last_seen: string | null;
    server_running: boolean;
    last_sync_at: string | null;
  };
  user_settings: {
    phone_type: string | null;
    contact_sources_configured: boolean;
    iphone_sync_enabled: boolean | null;
  };
}

/** Diagnostics data from the main process */
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
}

/** Category from the support platform */
export interface SupportCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
}

/** Ticket form data */
export interface TicketFormData {
  subject: string;
  description: string;
  priority: TicketPriority;
  category_id: string | null;
}

/** Hook state */
export interface SupportTicketState {
  diagnostics: AppDiagnostics | null;
  diagnosticsLoading: boolean;
  screenshot: string | null;
  screenshotLoading: boolean;
  categories: SupportCategory[];
  categoriesLoading: boolean;
  submitting: boolean;
  ticketNumber: number | null;
  error: string | null;
  success: boolean;
}

/** Hook actions */
export interface SupportTicketActions {
  collectDiagnostics: () => Promise<void>;
  captureScreenshot: () => Promise<void>;
  removeScreenshot: () => void;
  submitTicket: (
    form: TicketFormData,
    userEmail: string,
    userName: string
  ) => Promise<void>;
  reset: () => void;
}

/**
 * Hook for managing support ticket creation flow.
 * All Supabase operations go through the main process IPC handlers.
 */
export function useSupportTicket(initialScreenshot?: string | null): SupportTicketState & SupportTicketActions {
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(initialScreenshot || null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ticketNumber, setTicketNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Load categories on mount
  useEffect(() => {
    let cancelled = false;

    const loadCategories = async () => {
      setCategoriesLoading(true);
      try {
        const result = await window.api.support.getCategories();
        if (!cancelled && result.success && result.categories) {
          setCategories(result.categories);
        }
      } catch {
        // Categories are optional - allow submission without them
        logger.warn("[Support] Failed to load categories, continuing without");
      } finally {
        if (!cancelled) {
          setCategoriesLoading(false);
        }
      }
    };

    loadCategories();

    return () => {
      cancelled = true;
    };
  }, []);

  const collectDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      const result = await window.api.support.collectDiagnostics();
      if (result.success && result.diagnostics) {
        setDiagnostics(result.diagnostics as AppDiagnostics);
      } else {
        logger.warn("[Support] Failed to collect diagnostics:", result.error);
      }
    } catch (err) {
      logger.error("[Support] Diagnostics collection error:", err);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  const captureScreenshot = useCallback(async () => {
    setScreenshotLoading(true);
    try {
      const result = await window.api.support.captureScreenshot();
      if (result.success && result.screenshot) {
        setScreenshot(result.screenshot);
      } else {
        logger.warn("[Support] Screenshot capture returned null");
      }
    } catch (err) {
      logger.error("[Support] Screenshot capture error:", err);
    } finally {
      setScreenshotLoading(false);
    }
  }, []);

  const removeScreenshot = useCallback(() => {
    setScreenshot(null);
  }, []);

  const submitTicket = useCallback(
    async (form: TicketFormData, userEmail: string, userName: string) => {
      setSubmitting(true);
      setError(null);

      try {
        const result = await window.api.support.submitTicket(
          {
            subject: form.subject,
            description: form.description,
            priority: form.priority,
            category_id: form.category_id || null,
            requester_email: userEmail,
            requester_name: userName,
          },
          screenshot,
          diagnostics as unknown as Record<string, unknown> | null
        );

        if (!result.success) {
          throw new Error(result.error || "Failed to submit ticket");
        }

        setTicketNumber(result.ticket_number ?? null);
        setSuccess(true);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to submit ticket";
        setError(message);
        logger.error("[Support] Ticket submission failed:", err);
      } finally {
        setSubmitting(false);
      }
    },
    [screenshot, diagnostics]
  );

  const reset = useCallback(() => {
    setDiagnostics(null);
    setScreenshot(null);
    setTicketNumber(null);
    setError(null);
    setSuccess(false);
    setSubmitting(false);
  }, []);

  return {
    diagnostics,
    diagnosticsLoading,
    screenshot,
    screenshotLoading,
    categories,
    categoriesLoading,
    submitting,
    ticketNumber,
    error,
    success,
    collectDiagnostics,
    captureScreenshot,
    removeScreenshot,
    submitTicket,
    reset,
  };
}
