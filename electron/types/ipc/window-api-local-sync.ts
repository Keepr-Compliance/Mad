/**
 * WindowApi Local Sync sub-interface
 * Android companion WiFi sync server control (TASK-1431)
 */

/**
 * Local Sync API for Android companion WiFi message sync
 */
export interface WindowApiLocalSync {
  /** Start the local sync HTTP server */
  startServer: (options: {
    port: number;
    secret: string;
    userId?: string;
  }) => Promise<{ port: number; address: string }>;

  /** Stop the local sync HTTP server */
  stopServer: () => Promise<void>;

  /** Get the current sync server status including statistics */
  getStatus: () => Promise<{
    running: boolean;
    port: number | null;
    address: string | null;
    totalMessagesReceived: number;
    lastSyncTimestamp: number | null;
  }>;

  /**
   * Check whether the app already has an inbound "Allow" firewall rule
   * (Windows only). Used to pre-warn about the OS network-permission prompt
   * before the sync server binds the LAN IP. (BACKLOG-2348)
   */
  checkFirewallAllowed: () => Promise<{ allowed: boolean; checked: boolean }>;

  /** Clear all Android-synced messages and contacts from local DB (BACKLOG-1468) */
  clearAndroidData: (options: { userId: string }) => Promise<{
    messagesDeleted: number;
    contactsDeleted: number;
  }>;
}
