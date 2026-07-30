/**
 * Local Sync IPC Handlers
 * Exposes the local sync HTTP server to the renderer process via IPC.
 *
 * TASK-1429: Android Companion — Encrypted HTTP Transport
 * TASK-1431: Message pipeline integration + userId passthrough
 */

import { ipcMain } from "electron";
import localSyncService from "../services/localSyncService";
import logService from "../services/logService";
import { checkInboundFirewallAllowed } from "../services/firewallService";

const LOG_TAG = "LocalSyncHandlers";

/**
 * Register local sync IPC handlers.
 */
export function registerLocalSyncHandlers(): void {
  // Start the local sync HTTP server
  ipcMain.handle(
    "sync:start-server",
    async (
      _event,
      options: { port: number; secret: string; userId?: string }
    ): Promise<{ port: number; address: string }> => {
      logService.info("[LocalSync] IPC: start-server requested", LOG_TAG);
      return localSyncService.startServer(options.port, options.secret, options.userId);
    }
  );

  // Stop the local sync HTTP server
  ipcMain.handle("sync:stop-server", async (): Promise<void> => {
    logService.info("[LocalSync] IPC: stop-server requested", LOG_TAG);
    return localSyncService.stopServer();
  });

  // Get server running status
  ipcMain.handle("sync:get-status", () => {
    return localSyncService.getStatus();
  });

  // Check whether the app already has an inbound "Allow" firewall rule
  // (Windows only). Lets the Android pairing UI pre-warn about the OS
  // network-permission prompt only when it hasn't been granted yet. (BACKLOG-2348)
  ipcMain.handle("sync:check-firewall", async () => {
    logService.info("[LocalSync] IPC: check-firewall requested", LOG_TAG);
    return checkInboundFirewallAllowed();
  });

  // Clear all Android-synced data from local DB (BACKLOG-1468)
  ipcMain.handle(
    "sync:clear-android-data",
    async (
      _event,
      options: { userId: string }
    ): Promise<{ messagesDeleted: number; contactsDeleted: number }> => {
      logService.info("[LocalSync] IPC: clear-android-data requested", LOG_TAG);
      return localSyncService.clearAndroidData(options.userId);
    }
  );
}

/**
 * Clean up: stop the server if running.
 * Called from app.on('before-quit').
 */
export function cleanupLocalSyncHandlers(): void {
  logService.info("[LocalSync] Cleaning up sync server", LOG_TAG);
  // Fire-and-forget — we're shutting down
  localSyncService.stopServer().catch((err) => {
    logService.error(
      `[LocalSync] Cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      LOG_TAG
    );
  });
}
