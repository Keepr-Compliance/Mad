// ============================================
// PAIRING SERVICE
// Generates QR codes for Android companion pairing
// ============================================

import crypto from "crypto";
import os from "os";
import QRCode from "qrcode";
import log from "electron-log";
import * as Sentry from "@sentry/electron/main";

/**
 * Data encoded in the QR code for pairing
 */
export interface PairingQRData {
  ip: string;
  port: number;
  secret: string;
  deviceName: string;
  /**
   * SHA-256 hash (hex) of the desktop's logged-in Supabase user id.
   *
   * BACKLOG-2224: lets the phone abort BEFORE sending any data when it is
   * signed into a different Keepr account than the desktop (cross-account
   * data-leak pre-check). Optional/additive: older desktop builds omit it and
   * the phone simply skips the pre-check. Only a hash is embedded so the QR
   * never exposes the raw user id.
   */
  desktopUserIdHash?: string;
}

/**
 * Result returned when generating a QR code
 */
export interface PairingQRResult {
  qrDataUrl: string;
  pairingInfo: PairingQRData;
}

/**
 * A paired device session stored in memory
 */
export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  secret: string;
  pairedAt: string;
  lastSeen: string;
  /**
   * The Supabase user id that was cryptographically verified (via
   * getUser(accessToken)) to belong to this phone at /register time.
   *
   * BACKLOG-2224: present only when the desktop was able to online-verify the
   * phone's identity and it matched the desktop's logged-in user. Left
   * undefined for legacy (old-build) pairings and offline "matched but
   * unverified" pairings.
   */
  verifiedUserId?: string;
}

/**
 * Status of the pairing system
 */
export interface PairingStatus {
  isPaired: boolean;
  devices: PairedDevice[];
}

/**
 * Gets the first non-internal IPv4 address from network interfaces.
 * Falls back to "127.0.0.1" if no external interface is found.
 */
function getLocalIPAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addresses = interfaces[name];
    if (!addresses) continue;
    for (const addr of addresses) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (!addr.internal && addr.family === "IPv4") {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * PairingService manages QR code generation and paired device sessions.
 *
 * - Generates a shared secret + QR code data URL for the Android companion to scan
 * - Stores active pairing sessions in memory (Map of deviceId -> PairedDevice)
 * - The actual HTTP transport server is handled by TASK-1429
 */
class PairingService {
  /** Active paired devices, keyed by deviceId */
  private pairedDevices: Map<string, PairedDevice> = new Map();

  /**
   * Generates a QR code for pairing with the Android companion app.
   *
   * The QR code encodes JSON with:
   * - ip: The local network IP address
   * - port: A random high port (OS-assigned via port 0 pattern, picked here as random high port)
   * - secret: A 32-byte hex-encoded shared secret
   * - deviceName: The hostname of this machine
   *
   * @param userId - The desktop's logged-in Supabase user id. When provided, a
   *   SHA-256 hash of it is embedded in the QR (BACKLOG-2224) so the phone can
   *   abort pairing before sending data if it is signed into a different
   *   account. Omitted (undefined) when the desktop is logged out — no hash is
   *   embedded and the phone skips the pre-check.
   * @returns QR code as a data URL and the pairing info
   */
  async generateQR(userId?: string): Promise<PairingQRResult> {
    const secret = crypto.randomBytes(32).toString("hex");
    const ip = getLocalIPAddress();
    // Pick a random high port in the ephemeral range (49152-65535)
    // The actual server binding (port 0 for OS assignment) is TASK-1429's responsibility
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152));
    const deviceName = os.hostname();

    // BACKLOG-2224: embed a SHA-256 hash (hex) of the desktop user id — never
    // the raw id — so the phone can pre-check account match. Additive: absent
    // when logged out; older phones ignore it, newer phones enforce it.
    const desktopUserIdHash = userId
      ? crypto.createHash("sha256").update(userId, "utf8").digest("hex")
      : undefined;

    const pairingInfo: PairingQRData = {
      ip,
      port,
      secret,
      deviceName,
      ...(desktopUserIdHash ? { desktopUserIdHash } : {}),
    };

    log.info("[PairingService] Generating QR code", {
      ip,
      port,
      deviceName,
      secretPrefix: secret.substring(0, 8) + "...",
      hasUserIdHash: !!desktopUserIdHash,
    });

    Sentry.addBreadcrumb({
      category: "pairing",
      message: "QR code generated",
      level: "info",
      data: { ip, port, deviceName },
    });

    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairingInfo), {
      width: 300,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    return { qrDataUrl, pairingInfo };
  }

  /**
   * Returns the current pairing status including all paired devices.
   */
  getStatus(): PairingStatus {
    const devices = Array.from(this.pairedDevices.values());
    return {
      isPaired: devices.length > 0,
      devices,
    };
  }

  /**
   * Registers a new paired device. Called when the Android companion
   * successfully connects using the shared secret.
   *
   * @param deviceId Unique identifier for the paired device
   * @param deviceName Human-readable name of the paired device
   * @param secret The shared secret used for this pairing
   * @param verifiedUserId Optional Supabase user id that was cryptographically
   *   verified to belong to this phone (BACKLOG-2224). Undefined for legacy /
   *   unverified pairings.
   */
  addPairedDevice(
    deviceId: string,
    deviceName: string,
    secret: string,
    verifiedUserId?: string
  ): void {
    const now = new Date().toISOString();
    this.pairedDevices.set(deviceId, {
      deviceId,
      deviceName,
      secret,
      pairedAt: now,
      lastSeen: now,
      ...(verifiedUserId ? { verifiedUserId } : {}),
    });
    log.info("[PairingService] Device paired:", {
      deviceId,
      deviceName,
      verified: !!verifiedUserId,
    });
    Sentry.addBreadcrumb({
      category: "pairing",
      message: "Device added",
      level: "info",
      data: { deviceId, deviceName },
    });
  }

  /**
   * Updates the lastSeen timestamp for a paired device.
   *
   * @param deviceId The device to update
   */
  updateLastSeen(deviceId: string): void {
    const device = this.pairedDevices.get(deviceId);
    if (device) {
      device.lastSeen = new Date().toISOString();
    }
  }

  /**
   * Disconnects (removes) a paired device.
   *
   * @param deviceId The device to disconnect
   * @returns true if the device was found and removed, false otherwise
   */
  disconnect(deviceId: string): boolean {
    const existed = this.pairedDevices.has(deviceId);
    if (existed) {
      this.pairedDevices.delete(deviceId);
      log.info("[PairingService] Device disconnected:", { deviceId });
      Sentry.addBreadcrumb({
        category: "pairing",
        message: "Device disconnected",
        level: "info",
        data: { deviceId },
      });
    }
    return existed;
  }

  /**
   * Disconnects all paired devices. Used during cleanup/shutdown.
   */
  disconnectAll(): void {
    const count = this.pairedDevices.size;
    this.pairedDevices.clear();
    if (count > 0) {
      log.info("[PairingService] All devices disconnected:", { count });
    }
  }
}

/** Singleton instance of the pairing service */
export const pairingService = new PairingService();
