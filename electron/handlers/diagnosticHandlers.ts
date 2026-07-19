// ============================================
// DIAGNOSTIC IPC HANDLERS
// Handles: health checks, diagnostics, database maintenance
// ============================================

import { ipcMain, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import os from "os";
// These 2 services use require() instead of ES imports because
// the test mocks (system-handlers.test.ts) don't set __esModule: true.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const permissionService = require("../services/permissionService").default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectionStatusService = require("../services/connectionStatusService").default;
import databaseService from "../services/databaseService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";
import {
  ValidationError,
  validateUserId,
  validateString,
  validateProvider,
} from "../utils/validation";

// Type definitions
interface HealthCheckResponse {
  success: boolean;
  healthy?: boolean;
  permissions?: unknown;
  connection?: unknown;
  contactsLoading?: unknown;
  issues?: unknown[];
  summary?: {
    totalIssues: number;
    criticalIssues: number;
    warnings: number;
  };
  error?:
    | string
    | {
        type: string;
        userMessage: string;
        details?: string;
      };
}

/**
 * BACKLOG-2142: build the reconnect-banner subtitle "No email captured since
 * <date>" from a provider's last successful email-sync timestamp. Returns
 * undefined when there is no prior sync (null/absent) or the value is
 * unparseable, so the caller omits the subtitle cleanly. Display-only.
 */
function formatSinceMessage(lastSyncAt: string | null | undefined): string | undefined {
  if (!lastSyncAt) return undefined;
  const date = new Date(lastSyncAt);
  if (isNaN(date.getTime())) return undefined;
  const formatted = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `No email captured since ${formatted}`;
}

/**
 * Register all diagnostic IPC handlers
 */
export function registerDiagnosticHandlers(): void {
  // ===== HEALTH CHECK =====
  // Note: This handler preserves its original try/catch because it returns
  // structured error objects (type/userMessage/details) which is incompatible
  // with wrapHandler's flat error string format.

  /**
   * Get system health status (all checks combined)
   */
  ipcMain.handle(
    "system:health-check",
    async (
      event: IpcMainInvokeEvent,
      userId: string | null = null,
      provider: string | null = null,
    ): Promise<HealthCheckResponse> => {
      try {
        // Validate inputs (both optional)
        const validatedUserId = userId ? validateUserId(userId) : null;
        const validatedProvider = provider ? validateProvider(provider) : null;

        // Skip permission checks on Windows (macOS-only features)
        const isMacOS = os.platform() === "darwin";

        // BACKLOG-2127: check ALL stored mailbox connections, not just the
        // login provider. SystemHealthMonitor only ever passes the login
        // provider, so the previous single-provider check missed a broken
        // Outlook mailbox when the user logged in with Google. The `provider`
        // arg is now advisory (used only to populate the `connection` field
        // for backward compatibility).
        const [permissions, allConnections, contactsLoading] = await Promise.all([
          isMacOS
            ? permissionService.checkAllPermissions()
            : { allGranted: true, permissions: {}, errors: [] },
          validatedUserId
            ? connectionStatusService.checkAllConnections(validatedUserId)
            : null,
          isMacOS
            ? permissionService.checkContactsLoading()
            : { canLoadContacts: true, contactCount: 0 },
        ]);

        const issues: unknown[] = [];

        // Add permission issues
        if (!permissions.allGranted) {
          issues.push(...permissions.errors);
        }

        // Add contacts loading issue
        const contactsResult = contactsLoading as { canLoadContacts: boolean; error?: unknown };
        if (!contactsResult.canLoadContacts && contactsResult.error) {
          issues.push(contactsResult.error);
        }

        // BACKLOG-2127: Raise a reconnect issue for ANY provider whose stored
        // token is broken (TOKEN_REFRESH_FAILED / TOKEN_EXPIRED /
        // CONNECTION_CHECK_FAILED). Skip pure NOT_CONNECTED — a provider that
        // was never connected is the setup prompt's job, not a health error.
        const brokenTokenTypes = new Set([
          "TOKEN_REFRESH_FAILED",
          "TOKEN_EXPIRED",
          "CONNECTION_CHECK_FAILED",
        ]);
        const providerStatuses: Array<[
          "google" | "microsoft",
          { error: { type?: string } | null; lastSyncAt?: string | null } | undefined,
        ]> = allConnections
          ? [
              ["google", allConnections.google],
              ["microsoft", allConnections.microsoft],
            ]
          : [];
        for (const [providerName, status] of providerStatuses) {
          const connError = status?.error;
          if (connError && connError.type && brokenTokenTypes.has(connError.type)) {
            // BACKLOG-2142: when a prior successful email sync exists, add a
            // "No email captured since <date>" subtitle to the reconnect banner.
            // Display-only — composed here so the discriminator stays `type` and
            // no new renderer plumbing is needed (SystemHealthMonitor renders
            // `issue.message` as the subtitle). Omitted cleanly when null.
            const sinceMessage = formatSinceMessage(status?.lastSyncAt);
            issues.push({
              type: "OAUTH_CONNECTION" as string,
              provider: providerName,
              severity: "error",
              ...(connError as unknown as Record<string, unknown>),
              ...(sinceMessage ? { message: sinceMessage } : {}),
            });
          }
        }

        // Backward-compat `connection` field: the single login-provider status.
        const connection = allConnections
          ? validatedProvider === "google"
            ? allConnections.google
            : validatedProvider === "microsoft"
              ? allConnections.microsoft
              : null
          : null;

        return {
          success: true,
          healthy: issues.length === 0,
          permissions,
          connection,
          contactsLoading,
          issues,
          summary: {
            totalIssues: issues.length,
            criticalIssues: issues.filter(
              (i) => (i as { severity?: string }).severity === "error",
            ).length,
            warnings: issues.filter(
              (i) => (i as { severity?: string }).severity === "warning",
            ).length,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("System health check failed", "Diagnostics", {
          error: errorMessage,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            healthy: false,
            error: {
              type: "VALIDATION_ERROR",
              userMessage: "Invalid input parameters",
              details: error.message,
            },
          };
        }
        return {
          success: false,
          healthy: false,
          error: {
            type: "HEALTH_CHECK_FAILED",
            userMessage: "Could not check system status",
            details: errorMessage,
          },
        };
      }
    },
  );

  // ===== DIAGNOSTICS =====

  /**
   * Get diagnostic information for support requests
   */
  ipcMain.handle(
    "system:get-diagnostics",
    wrapHandler(async (): Promise<{
      success: boolean;
      diagnostics?: string;
      error?: string;
    }> => {
      const diagnostics = {
        app: {
          version: app.getVersion(),
          name: app.getName(),
          locale: app.getLocale(),
        },
        system: {
          platform: process.platform,
          arch: process.arch,
          osVersion: os.release(),
          osType: os.type(),
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
        },
        memory: {
          total: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
          free: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
        },
        timestamp: new Date().toISOString(),
      };

      const diagnosticString = Object.entries(diagnostics)
        .map(([category, values]) => {
          if (typeof values === "object") {
            const items = Object.entries(values as Record<string, unknown>)
              .map(([key, val]) => `  ${key}: ${val}`)
              .join("\n");
            return `${category.toUpperCase()}:\n${items}`;
          }
          return `${category}: ${values}`;
        })
        .join("\n\n");

      return { success: true, diagnostics: diagnosticString };
    }, { module: "Diagnostics" }),
  );

  // ============================================
  // DATA DIAGNOSTIC HANDLERS
  // ============================================

  ipcMain.handle(
    "diagnostic:message-health-report",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticMessageHealthReport(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:messages-null-thread-id",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticGetMessagesWithNullThreadId(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:messages-garbage-text",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticGetMessagesWithGarbageText(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:threads-for-contact",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string, phoneDigits: string) => {
      validateUserId(userId);
      validateString(phoneDigits, "phoneDigits");
      return await databaseService.diagnosticGetThreadsForContact(userId, phoneDigits);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:null-thread-id-analysis",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticNullThreadIdAnalysis(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:unknown-recipient-messages",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticUnknownRecipientMessages(userId);
    }, { module: "Diagnostics" }),
  );

  // Diagnostic: Check email data for a specific contact email
  ipcMain.handle(
    "diagnostic:check-email-data",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string, emailAddress: string) => {
      validateUserId(userId);
      validateString(emailAddress, "emailAddress", { required: true, maxLength: 255 });

      const db = databaseService.getRawDatabase();

      // Check contact_emails junction table
      const contactEmails = db.prepare(`
        SELECT ce.*, c.display_name
        FROM contact_emails ce
        JOIN contacts c ON ce.contact_id = c.id
        WHERE c.user_id = ? AND LOWER(ce.email) = LOWER(?)
      `).all(userId, emailAddress);

      // BACKLOG-506: Check emails table (communications is now junction only)
      // BACKLOG-1722: indexed exact match via email_participants junction.
      // The previous LIKE scan was unindexed AND missed BCC-only matches
      // for diagnostic triage of "where is this address mentioned".
      const communications = db.prepare(`
        SELECT DISTINCT e.id, e.sender, e.recipients, e.subject, e.sent_at,
               c.transaction_id
        FROM email_participants ep
        JOIN emails e ON e.id = ep.email_id
        LEFT JOIN communications c ON c.email_id = e.id
        WHERE e.user_id = ?
          AND ep.email_address = ?
        ORDER BY e.sent_at DESC
        LIMIT 20
      `).all(userId, emailAddress.toLowerCase().trim());

      // Count total emails for this user
      const totalEmails = db.prepare(`
        SELECT COUNT(*) as count FROM emails
        WHERE user_id = ?
      `).get(userId) as { count: number };

      return {
        success: true,
        emailAddress,
        contactEmailsFound: contactEmails.length,
        contactEmails,
        communicationsFound: communications.length,
        communications,
        totalEmailsInDb: totalEmails.count,
      };
    }, { module: "Diagnostics" }),
  );

  // ============================================
  // DATABASE MAINTENANCE HANDLERS
  // ============================================

  /**
   * Reindex the database for performance optimization
   * Rebuilds all performance indexes and runs ANALYZE
   */
  ipcMain.handle(
    "system:reindex-database",
    wrapHandler(async (): Promise<{
      success: boolean;
      indexesRebuilt?: number;
      durationMs?: number;
      error?: string;
    }> => {
      logService.info("Database reindex requested via UI", "Diagnostics");
      const result = await databaseService.reindexDatabase();
      return result;
    }, { module: "Diagnostics" }),
  );
}
