/**
 * WindowApi Pairing sub-interface
 * Android companion app QR code pairing (TASK-1428)
 */

/**
 * Pairing API for Android companion app
 */
export interface WindowApiPairing {
  /**
   * Generate a QR code for pairing with the Android companion app.
   * @param userId - Desktop's logged-in Supabase user id (BACKLOG-2224), used to
   *   embed a SHA-256 hash in the QR for the phone-side account-match pre-check.
   */
  generateQR: (userId?: string) => Promise<{
    success: boolean;
    error?: string;
    result?: {
      qrDataUrl: string;
      pairingInfo: {
        ip: string;
        port: number;
        secret: string;
        deviceName: string;
        /** SHA-256 hash (hex) of the desktop user id (BACKLOG-2224); absent when logged out */
        desktopUserIdHash?: string;
      };
    };
  }>;

  /** Get the current pairing status including paired devices */
  getStatus: () => Promise<{
    success: boolean;
    error?: string;
    status?: {
      isPaired: boolean;
      devices: Array<{
        deviceId: string;
        deviceName: string;
        secret: string;
        pairedAt: string;
        lastSeen: string;
        /** Verified Supabase user id (BACKLOG-2224); absent for legacy/unverified pairings */
        verifiedUserId?: string;
      }>;
    };
  }>;

  /** Disconnect a paired device */
  disconnect: (deviceId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
}
