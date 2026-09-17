/**
 * Authentication Handlers - Facade
 *
 * This file provides backward compatibility by re-exporting the registration
 * function. All auth handler implementations have been extracted to:
 *
 * - handlers/googleAuthHandlers.ts - Google OAuth login and Gmail mailbox
 * - handlers/microsoftAuthHandlers.ts - Microsoft OAuth login and Outlook mailbox
 * - handlers/sessionHandlers.ts - Session management, logout, terms acceptance
 * - handlers/sharedAuthHandlers.ts - Cross-provider handlers (pending login, mailbox disconnect)
 */

import type { BrowserWindow } from "electron";

// Import services for initializeDatabase
import databaseService from "../services/databaseService";
import supabaseService from "../services/supabaseService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import { getSupportAccess } from "../services/supportAccess";

// Import handler registrations
import { registerGoogleAuthHandlers } from "./googleAuthHandlers";
import { registerMicrosoftAuthHandlers } from "./microsoftAuthHandlers";
import { registerSessionHandlers } from "./sessionHandlers";
import { registerSharedAuthHandlers } from "./sharedAuthHandlers";

/**
 * Initialize database and audit service
 */
export const initializeDatabase = async (): Promise<void> => {
  try {
    // BACKLOG-2999: startup is the ONE context where quitting on an
    // unrecoverable migration failure is the right outcome — there is no
    // half-working app to fall back to, and the alternative is the user
    // working against a half-migrated or unopened database. The option
    // defaults to false precisely so the other call sites
    // (sqliteBackupService's restore, which calls initialize() mid-recovery)
    // cannot quit by accident. Note the FIX is initialize() rejecting; this
    // flag only upgrades the outcome from "error screen" to "clean exit".
    await databaseService.initialize({ quitOnUnrecoverableFailure: true });
    await logService.debug("Database initialized", "AuthHandlers");

    // Initialize audit service with dependencies
    auditService.initialize(databaseService, supabaseService);

    // BACKLOG-3052: contact names and property addresses only leave this
    // machine while a support-access window is open.
    //
    // Read lazily, inside the closure, for two reasons. It keeps
    // `getSupportAccess()` — which builds a singleton over disk state — off
    // the startup path; and a grant is a wall-clock window that opens and
    // closes while the app runs, so a value captured here would be a snapshot
    // of the moment the database came up. Every sync tick asks again.
    auditService.setSupportAccessGate({
      isActive: () => getSupportAccess().access.isActive(),
    });
    await logService.debug("Audit service initialized", "AuthHandlers");
  } catch (error) {
    await logService.error("Failed to initialize database", "AuthHandlers", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};

/**
 * Register all authentication handlers
 * This is the main entry point called from main.ts
 */
export function registerAuthHandlers(mainWindow: BrowserWindow | null): void {
  // Google OAuth handlers (login, mailbox connection)
  registerGoogleAuthHandlers(mainWindow);

  // Microsoft OAuth handlers (login, mailbox connection)
  registerMicrosoftAuthHandlers(mainWindow);

  // Session handlers (logout, terms, validation)
  registerSessionHandlers();

  // Shared handlers (pending login completion, mailbox disconnect)
  registerSharedAuthHandlers(mainWindow);
}

// Re-export for backward compatibility
export { registerAuthHandlers as default };
