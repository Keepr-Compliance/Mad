/**
 * Support Bridge
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 *
 * Exposes support ticket IPC methods to the renderer process.
 */

import { ipcRenderer } from "electron";
// Type-only imports: erased at compile time, so no main-process code is pulled
// into the preload bundle. Importing the types rather than re-declaring them is
// deliberate — the four hand-copied AppDiagnostics declarations in this repo
// have already drifted out of sync with each other.
import type {
  SupportAccessDuration,
  SupportAccessDurationId,
  SupportAccessState,
  SupportConsentRecord,
  SupportReportListItem,
  SupportReportMeta,
} from "../services/supportAccess/types";
import type {
  SupportLogScope,
  SupportLogScopeId,
} from "../services/supportAccess/scopes";
import type { SupportCaptureFailure } from "../services/supportAccess/supportUploadScheduler";

/** Everything the support access Settings section needs in one round trip. */
export interface SupportAccessSnapshot {
  success: boolean;
  state?: SupportAccessState;
  reports?: SupportReportListItem[];
  durations?: readonly SupportAccessDuration[];
  defaultDurationId?: SupportAccessDurationId;
  scopes?: SupportLogScope[];
  defaultScopes?: SupportLogScopeId[];
  /** The exact wording to display, plus its id and hash. */
  disclosure?: { id: string; text: string; hash: string };
  retentionDays?: number;
  /**
   * The last capture that failed, or null (BACKLOG-2430). A scheduled capture
   * throws at a timer with nobody to catch it, so without this the only
   * symptom is an empty report list — which reads as a quiet machine rather
   * than one recording nothing.
   */
  captureFailure?: SupportCaptureFailure | null;
  error?: string;
}

/** Parameters for creating a support ticket */
interface CreateTicketParams {
  subject: string;
  description: string;
  priority: string;
  category_id: string | null;
  requester_email: string;
  requester_name: string;
}

/** Diagnostics data shape (must match main process type) */
interface AppDiagnostics {
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
}

/** Support category from Supabase */
interface SupportCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
}

export const supportBridge = {
  /**
   * Collect app diagnostics (PII-safe) for a support ticket
   */
  collectDiagnostics: (): Promise<{
    success: boolean;
    diagnostics?: AppDiagnostics;
    error?: string;
  }> => ipcRenderer.invoke("support:collect-diagnostics"),

  /**
   * Capture a screenshot of the primary screen
   */
  captureScreenshot: (): Promise<{
    success: boolean;
    screenshot?: string | null;
    error?: string;
  }> => ipcRenderer.invoke("support:capture-screenshot"),

  /**
   * Get support categories from Supabase
   */
  getCategories: (): Promise<{
    success: boolean;
    categories?: SupportCategory[];
    error?: string;
  }> => ipcRenderer.invoke("support:get-categories"),

  /**
   * Submit a support ticket with optional screenshot and diagnostics
   */
  submitTicket: (
    params: CreateTicketParams,
    screenshotBase64: string | null,
    diagnosticsData: AppDiagnostics | null
  ): Promise<{
    success: boolean;
    ticket_id?: string;
    ticket_number?: number;
    error?: string;
  }> =>
    ipcRenderer.invoke(
      "support:submit-ticket",
      params,
      screenshotBase64,
      diagnosticsData
    ),

  /**
   * Support access mode (BACKLOG-2393): a time-boxed grant during which the app
   * captures deeper detail and uploads it, plus the list of what it captured.
   */
  access: {
    /** Window state, report list, offered durations, scopes and disclosure. */
    getState: (): Promise<SupportAccessSnapshot> =>
      ipcRenderer.invoke("support-access:get-state"),

    /**
     * BACKLOG-2431: fires whenever the grant window opens or closes.
     *
     * The persistent "support access is on" banner used to rely solely on a
     * 60-second poll, so it could lag a grant by nearly a minute. Since it is
     * the only always-visible sign that client data is being collected, it now
     * reacts to the grant itself. Returns an unsubscribe function.
     */
    onChanged: (
      callback: (state: SupportAccessState) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: SupportAccessState,
      ): void => callback(state);
      ipcRenderer.on("support-access:changed", listener);
      return () => {
        ipcRenderer.removeListener("support-access:changed", listener);
      };
    },

    /**
     * `disclosureText` is the text the renderer actually put on screen. It is
     * sent back so the consent record names what was read, not what main
     * assumed was read.
     */
    grant: (request: {
      durationId: SupportAccessDurationId;
      scopes?: SupportLogScopeId[];
      disclosureId?: string;
      disclosureText?: string;
    }): Promise<{
      success: boolean;
      consent?: SupportConsentRecord;
      state?: SupportAccessState;
      error?: string;
    }> => ipcRenderer.invoke("support-access:grant", request),

    revoke: (): Promise<{
      success: boolean;
      state?: SupportAccessState;
      error?: string;
    }> => ipcRenderer.invoke("support-access:revoke"),

    listReports: (): Promise<{
      success: boolean;
      reports?: SupportReportListItem[];
      error?: string;
    }> => ipcRenderer.invoke("support-access:list-reports"),

    captureNow: (): Promise<{
      success: boolean;
      report?: SupportReportMeta;
      reports?: SupportReportListItem[];
      error?: string;
    }> => ipcRenderer.invoke("support-access:capture-now"),

    sendNow: (
      id: string
    ): Promise<{
      success: boolean;
      report?: SupportReportMeta;
      reports?: SupportReportListItem[];
      error?: string;
    }> => ipcRenderer.invoke("support-access:send-now", id),

    /**
     * `success` means the call completed; `deleted` means the data is gone.
     * They are separate because a server that could not be reached must not
     * make a row disappear from the list.
     */
    deleteReport: (
      id: string
    ): Promise<{
      success: boolean;
      deleted?: boolean;
      remoteRemains?: boolean;
      reports?: SupportReportListItem[];
      error?: string;
    }> => ipcRenderer.invoke("support-access:delete-report", id),
  },
};
