/**
 * Local Sync HTTP Server Service
 * Runs a temporary HTTP server on the local network for receiving encrypted
 * SMS sync payloads from the Android companion app.
 *
 * Modeled after the OAuth callback server pattern in googleAuthService.ts
 * and microsoftAuthService.ts. Uses Node built-in http module (NOT Express).
 *
 * TASK-1429: Android Companion — Encrypted HTTP Transport
 * TASK-1431: Message pipeline integration + storage
 */

import crypto from "crypto";
import http from "http";
import os from "os";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import { decrypt } from "./localSyncEncryption";
import { secureCompare } from "../utils/keyDerivation";
import databaseService from "./databaseService";
import { normalizePhone } from "./messageMatchingService";
import { pairingService } from "./pairingService";
import * as externalContactDb from "./db/externalContactDbService";
import { autoLinkNewMessagesForUserDebounced } from "./autoLinkService";
import type {
  EncryptedPayload,
  SyncPayload,
  SyncMessage,
  LocalSyncResult,
  LocalSyncServerStatus,
  ContactSyncPayload,
  ContactSyncResult,
  SyncContact,
} from "../types/localSync";

const LOG_TAG = "LocalSync";

/**
 * Get the first non-internal IPv4 address on the local network.
 * Binds to a specific interface rather than 0.0.0.0 for security.
 */
function getLocalNetworkIP(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (!addr.internal && addr.family === "IPv4") {
        return addr.address;
      }
    }
  }
  return null;
}

/**
 * Read the full request body as a string.
 */
function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB limit

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Send a JSON response.
 */
function sendJSON(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

// ============================================
// SERVICE CLASS
// ============================================

/**
 * Derive separate auth token and encryption key from the shared secret.
 * Uses HMAC-SHA256 with domain-specific labels so the bearer token (sent
 * in plaintext over HTTP) cannot be used to decrypt payloads.
 *
 * @param secretBase64 - Base64-encoded shared secret from QR pairing
 * @returns { authToken, encryptionKey } — hex auth token + 32-byte key buffer
 */
export function deriveTransportKeys(secretBase64: string): {
  authToken: string;
  encryptionKey: Buffer;
} {
  const secretBuf = Buffer.from(secretBase64, "base64");
  if (secretBuf.length < 16) {
    throw new Error(
      `Shared secret too short: expected at least 16 bytes, got ${secretBuf.length}`
    );
  }

  // Auth token: HMAC-SHA256(secret, "auth") → hex string (for Bearer header)
  const authToken = crypto
    .createHmac("sha256", secretBuf)
    .update("auth")
    .digest("hex");

  // Encryption key: HMAC-SHA256(secret, "encryption") → 32-byte Buffer
  const encryptionKey = crypto
    .createHmac("sha256", secretBuf)
    .update("encryption")
    .digest();

  return { authToken, encryptionKey };
}

/**
 * Generate a dedup external_id from sender + timestamp + body.
 * Uses SHA-256 hash to create a deterministic, unique identifier.
 */
function generateExternalId(sender: string, timestamp: number, body: string): string {
  return crypto
    .createHash("sha256")
    .update(`${sender}|${timestamp}|${body}`)
    .digest("hex");
}

/**
 * Normalize a phone number for storage and matching.
 * Strips non-digits, handles +1 prefix for US numbers.
 */
function normalizePhoneNumber(phone: string): string {
  const normalized = normalizePhone(phone);
  return normalized ?? phone.replace(/\D/g, "");
}

class LocalSyncService {
  private server: http.Server | null = null;
  private authToken: string | null = null;
  private encryptionKey: Buffer | null = null;
  private boundAddress: string | null = null;
  private boundPort: number | null = null;

  /** User ID for storing messages — set when server starts */
  private userId: string | null = null;

  /** Callback invoked when a valid sync payload is received */
  private onMessagesReceived:
    | ((payload: SyncPayload) => Promise<void>)
    | null = null;

  /** Sync statistics tracked across the server session */
  private totalMessagesReceived = 0;
  private lastSyncTimestamp: number | null = null;

  /**
   * Start the local sync HTTP server.
   *
   * @param port - Port to listen on (0 for OS-assigned)
   * @param secret - Base64-encoded shared secret from QR pairing
   * @param userId - User ID for message storage
   * @param onMessages - Optional additional callback for received message payloads
   * @returns The actual port and address the server is bound to
   */
  async startServer(
    port: number,
    secret: string,
    userId?: string,
    onMessages?: (payload: SyncPayload) => Promise<void>
  ): Promise<{ port: number; address: string }> {
    if (this.server) {
      logService.warn(
        "[LocalSync] Server already running, stopping first",
        LOG_TAG
      );
      await this.stopServer();
    }

    // Derive separate auth token and encryption key from the shared secret.
    // The auth token is used for bearer authentication; the encryption key
    // is used for AES-256-GCM. They are cryptographically independent so
    // capturing the bearer token on the wire does not reveal the encryption key.
    const derived = deriveTransportKeys(secret);
    this.authToken = derived.authToken;
    this.encryptionKey = derived.encryptionKey;
    this.userId = userId ?? null;
    this.onMessagesReceived = onMessages ?? null;
    this.totalMessagesReceived = 0;
    this.lastSyncTimestamp = null;

    const localIP = getLocalNetworkIP();
    if (!localIP) {
      throw new Error(
        "No local network interface found. Ensure WiFi or Ethernet is connected."
      );
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (err) => {
        logService.error(
          `[LocalSync] Server error: ${err.message}`,
          LOG_TAG
        );
        Sentry.captureException(err, {
          tags: { component: "localSyncService" },
        });
        reject(err);
      });

      // Bind to specific local network IP (not 0.0.0.0)
      this.server.listen(port, localIP, () => {
        const addr = this.server!.address();
        if (typeof addr === "object" && addr) {
          this.boundPort = addr.port;
          this.boundAddress = addr.address;
          logService.info(
            `[LocalSync] Server listening on ${this.boundAddress}:${this.boundPort}`,
            LOG_TAG
          );
          Sentry.addBreadcrumb({
            category: "localSync",
            message: "Server started",
            level: "info",
            data: { address: this.boundAddress, port: this.boundPort },
          });
          resolve({ port: this.boundPort, address: this.boundAddress });
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
    });
  }

  /**
   * Stop the local sync HTTP server.
   */
  async stopServer(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        logService.info("[LocalSync] Server stopped", LOG_TAG);
        Sentry.addBreadcrumb({
          category: "localSync",
          message: "Server stopped",
          level: "info",
        });
        this.server = null;
        this.authToken = null;
        this.encryptionKey = null;
        this.boundAddress = null;
        this.boundPort = null;
        this.userId = null;
        this.onMessagesReceived = null;
        this.totalMessagesReceived = 0;
        this.lastSyncTimestamp = null;
        resolve();
      });
    });
  }

  /**
   * Clear all Android-synced data from the local database.
   * Deletes messages with metadata source 'android_wifi_sync' and
   * external contacts with source 'android_sync'.
   *
   * BACKLOG-1468: Android Force Re-import clears synced data
   *
   * @param userId - User ID for data ownership
   * @returns Counts of deleted messages and contacts
   */
  clearAndroidData(userId: string): { messagesDeleted: number; contactsDeleted: number } {
    const messagesDeleted = databaseService.deleteMessagesByMetadataSource(userId, "android_wifi_sync");
    const contactsDeleted = externalContactDb.deleteBySource(userId, "android_sync");

    logService.info(
      `[LocalSync] Cleared Android data: ${messagesDeleted} messages, ${contactsDeleted} contacts`,
      LOG_TAG
    );

    return { messagesDeleted, contactsDeleted };
  }

  /**
   * Get the current server status including sync statistics.
   */
  getStatus(): LocalSyncServerStatus {
    return {
      running: this.server !== null,
      port: this.boundPort,
      address: this.boundAddress,
      totalMessagesReceived: this.totalMessagesReceived,
      lastSyncTimestamp: this.lastSyncTimestamp,
    };
  }

  /**
   * Route incoming HTTP requests.
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const urlPath = req.url?.split("?")[0] ?? "";
    const method = req.method?.toUpperCase() ?? "";

    logService.debug(
      `[LocalSync] ${method} ${urlPath}`,
      LOG_TAG
    );

    if (method === "GET" && urlPath === "/ping") {
      this.handlePing(res);
      return;
    }

    if (method === "POST" && urlPath === "/register") {
      this.handleRegister(req, res);
      return;
    }

    if (method === "POST" && urlPath === "/sync/messages") {
      this.handleSyncMessages(req, res);
      return;
    }

    if (method === "POST" && urlPath === "/sync/contacts") {
      this.handleSyncContacts(req, res);
      return;
    }

    // Unknown route
    sendJSON(res, 404, { error: "Not found" });
  }

  /**
   * GET /ping — connection health check.
   * No authentication required (used for discovery).
   */
  private handlePing(res: http.ServerResponse): void {
    sendJSON(res, 200, { status: "ok", timestamp: Date.now() });
  }

  /**
   * POST /register — register a paired device immediately after QR scan.
   * Requires bearer token authentication (same as /sync/messages).
   * No encryption needed — the body is a simple JSON with deviceId and deviceName.
   *
   * This endpoint allows the phone to notify the desktop that pairing succeeded,
   * so the desktop QR screen transitions to "Connected" without waiting for
   * the first full sync.
   *
   * BACKLOG-1456: Phone auto-pings on pair + auto-first-sync
   */
  private async handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      // Validate bearer token (same auth as /sync/messages)
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        logService.warn("[LocalSync] Missing or invalid Authorization header (register)", LOG_TAG);
        sendJSON(res, 401, { error: "Unauthorized" });
        return;
      }

      const token = authHeader.substring(7);
      if (
        !this.authToken ||
        !secureCompare(Buffer.from(token, "utf8"), Buffer.from(this.authToken, "utf8"))
      ) {
        logService.warn("[LocalSync] Invalid bearer token (register)", LOG_TAG);
        sendJSON(res, 401, { error: "Unauthorized" });
        return;
      }

      // Read and parse request body (plaintext JSON — no encryption for registration)
      let body: string;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to read body";
        logService.error(`[LocalSync] Body read error (register): ${message}`, LOG_TAG);
        sendJSON(res, 400, { error: message });
        return;
      }

      let registerPayload: { deviceId?: string; deviceName?: string };
      try {
        registerPayload = JSON.parse(body) as { deviceId?: string; deviceName?: string };
      } catch {
        logService.warn("[LocalSync] Invalid JSON in request body (register)", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!registerPayload.deviceId) {
        logService.warn("[LocalSync] Missing deviceId in register payload", LOG_TAG);
        sendJSON(res, 400, { error: "Missing deviceId" });
        return;
      }

      const deviceId = registerPayload.deviceId;
      const deviceName = registerPayload.deviceName || `Android-${deviceId.substring(0, 8)}`;

      logService.info(
        `[LocalSync] Device registration: ${deviceName} (${deviceId})`,
        LOG_TAG
      );

      // Register the device as paired if not already known
      const existingStatus = pairingService.getStatus();
      const alreadyPaired = existingStatus.devices.some(
        (d) => d.deviceId === deviceId
      );
      if (!alreadyPaired) {
        pairingService.addPairedDevice(
          deviceId,
          deviceName,
          "" // secret not needed after pairing — auth already validated via bearer token
        );
      }
      pairingService.updateLastSeen(deviceId);

      sendJSON(res, 200, { success: true, deviceId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logService.error(`[LocalSync] Unhandled error (register): ${message}`, LOG_TAG);
      sendJSON(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * POST /sync/messages — receive encrypted message batch.
   * Requires bearer token authentication + AES-256-GCM decryption.
   */
  private async handleSyncMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      // Validate bearer token
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        logService.warn("[LocalSync] Missing or invalid Authorization header", LOG_TAG);
        sendJSON(res, 401, { error: "Unauthorized" });
        return;
      }

      const token = authHeader.substring(7); // Remove "Bearer "
      if (
        !this.authToken ||
        !secureCompare(Buffer.from(token, "utf8"), Buffer.from(this.authToken, "utf8"))
      ) {
        logService.warn("[LocalSync] Invalid bearer token", LOG_TAG);
        sendJSON(res, 401, { error: "Unauthorized" });
        return;
      }

      // Read and parse request body
      let body: string;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to read body";
        logService.error(`[LocalSync] Body read error: ${message}`, LOG_TAG);
        sendJSON(res, 400, { error: message });
        return;
      }

      let encryptedPayload: EncryptedPayload;
      try {
        encryptedPayload = JSON.parse(body) as EncryptedPayload;
      } catch {
        logService.warn("[LocalSync] Invalid JSON in request body", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      // Validate encrypted payload structure
      if (!encryptedPayload.iv || !encryptedPayload.encrypted || !encryptedPayload.tag) {
        logService.warn("[LocalSync] Missing encrypted payload fields", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid payload: missing iv, encrypted, or tag" });
        return;
      }

      // Decrypt
      if (!this.encryptionKey) {
        logService.error("[LocalSync] Encryption key not set", LOG_TAG);
        sendJSON(res, 500, { error: "Server not configured" });
        return;
      }

      let decryptedJson: string;
      try {
        decryptedJson = decrypt(encryptedPayload, this.encryptionKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Decryption failed";
        logService.warn(`[LocalSync] Decryption failed: ${message}`, LOG_TAG);
        sendJSON(res, 400, { error: "Decryption failed" });
        return;
      }

      // Parse decrypted payload
      let syncPayload: SyncPayload;
      try {
        syncPayload = JSON.parse(decryptedJson) as SyncPayload;
      } catch {
        logService.warn("[LocalSync] Invalid JSON in decrypted payload", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid decrypted payload" });
        return;
      }

      // Validate sync payload structure
      if (!syncPayload.deviceId || !Array.isArray(syncPayload.messages)) {
        logService.warn("[LocalSync] Invalid sync payload structure", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid sync payload: missing deviceId or messages" });
        return;
      }

      logService.info(
        `[LocalSync] Received ${syncPayload.messages.length} messages from device ${syncPayload.deviceId}`,
        LOG_TAG
      );

      Sentry.addBreadcrumb({
        category: "localSync",
        message: "Messages received",
        level: "info",
        data: {
          messageCount: syncPayload.messages.length,
          deviceId: syncPayload.deviceId,
        },
      });

      // Register the device as paired if not already known, then update last seen.
      // BACKLOG-1454: pairingService.addPairedDevice() was never called, so
      // getStatus() always returned isPaired=false and the desktop onboarding
      // QR screen never transitioned to "Connected".
      const existingStatus = pairingService.getStatus();
      const alreadyPaired = existingStatus.devices.some(
        (d) => d.deviceId === syncPayload.deviceId
      );
      if (!alreadyPaired) {
        pairingService.addPairedDevice(
          syncPayload.deviceId,
          `Android-${syncPayload.deviceId.substring(0, 8)}`,
          "" // secret not needed after pairing — auth already validated via bearer token
        );
      }
      pairingService.updateLastSeen(syncPayload.deviceId);

      // TASK-1431: Store messages in the database via the message pipeline
      let storedCount = 0;
      if (this.userId && syncPayload.messages.length > 0) {
        try {
          storedCount = this.storeMessages(this.userId, syncPayload.deviceId, syncPayload.messages);
          this.totalMessagesReceived += storedCount;
          this.lastSyncTimestamp = Date.now();
          logService.info(
            `[LocalSync] Stored ${storedCount} messages (${syncPayload.messages.length - storedCount} duplicates skipped)`,
            LOG_TAG
          );

          // BACKLOG-1546: Auto-link newly synced messages to transactions.
          // Debounced because Android sends messages in small batches — we wait
          // until the stream settles (2s) before running auto-link once.
          // BACKLOG-2285: the debounced wrapper also runs expandAttachedThreadsForUser
          // after auto-link, so backfilled/older history synced from the companion
          // is picked up in already-attached threads (inherits the same debounce).
          if (storedCount > 0) {
            autoLinkNewMessagesForUserDebounced(this.userId);
          }
        } catch (err) {
          const storeError = err instanceof Error ? err.message : "Storage failed";
          logService.error(`[LocalSync] Message storage error: ${storeError}`, LOG_TAG);
          // Continue — still respond success since messages were received
        }
      }

      // Invoke additional callback if registered
      if (this.onMessagesReceived) {
        try {
          await this.onMessagesReceived(syncPayload);
        } catch (err) {
          const cbError = err instanceof Error ? err.message : "Callback error";
          logService.error(`[LocalSync] onMessagesReceived callback error: ${cbError}`, LOG_TAG);
        }
      }

      const result: LocalSyncResult = {
        success: true,
        messagesReceived: syncPayload.messages.length,
        messagesStored: storedCount,
      };

      sendJSON(res, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logService.error(`[LocalSync] Unhandled error: ${message}`, LOG_TAG);
      sendJSON(res, 500, { error: "Internal server error" });
    }
  }
  /**
   * Store received SMS messages in the local database.
   * Follows the same pattern as iPhoneSyncStorageService for message storage.
   *
   * BACKLOG-1493: Fixed participants_flat to always contain a value for all sender types.
   * BACKLOG-1495: Data parsing specification — see inline comments for normalization rules.
   *
   * ## Data Parsing Spec (BACKLOG-1495)
   *
   * **participants_flat** — Used for conversation grouping and contact matching:
   *   - Standard phone numbers (7+ digits): raw digits from sender (e.g., "5551234567")
   *   - Short codes (< 7 digits): digits as-is (e.g., "72645")
   *   - Alphanumeric senders: full normalized string (e.g., "T-Mobile", "BANK OF AMERICA")
   *   - Never empty — falls back to normalized sender string
   *
   * **thread_id** — Conversation grouping key:
   *   - If Android provides a thread_id: "android-thread-{androidThreadId}"
   *   - Fallback: "android-thread-{normalizedSender}" for consistent grouping
   *
   * **Dedup**: SHA-256 hash of sender + timestamp + body (generateExternalId)
   *
   * @param userId - User ID for message ownership
   * @param deviceId - Android device ID from pairing
   * @param messages - Array of SyncMessage from the Android device
   * @returns Number of messages actually stored (excluding duplicates)
   */
  private storeMessages(userId: string, deviceId: string, messages: SyncMessage[]): number {
    const messagesToInsert = messages.map((msg) => {
      const normalizedSender = normalizePhoneNumber(msg.sender);
      const externalId = generateExternalId(msg.sender, msg.timestamp, msg.body);

      // Build participants JSON matching the existing message format
      const participants = JSON.stringify({
        from: msg.direction === "inbound" ? normalizedSender : "me",
        to: msg.direction === "inbound" ? ["me"] : [normalizedSender],
      });

      // BACKLOG-1493: Build participants_flat for conversation grouping.
      // For numeric senders, use digits for phone matching.
      // For alphanumeric senders (carrier alerts, marketing), use the full string
      // so they are not filtered out or collapsed into empty groups.
      const senderDigits = msg.sender.replace(/\D/g, "");
      const participantsFlat = senderDigits.length > 0 ? senderDigits : normalizedSender;

      // BACKLOG-1493: Ensure thread_id is always set for consistent conversation grouping.
      // Use Android's thread_id when available, fall back to sender-based grouping.
      const threadId = msg.threadId
        ? `android-thread-${msg.threadId}`
        : `android-thread-${normalizedSender}`;

      const metadata = JSON.stringify({
        source: "android_wifi_sync",
        deviceId,
        androidThreadId: msg.threadId || null,
        originalSender: msg.sender,
      });

      return {
        id: crypto.randomUUID(),
        userId,
        channel: "sms" as const,
        externalId,
        direction: msg.direction,
        bodyText: msg.body,
        participants,
        participantsFlat,
        threadId,
        sentAt: new Date(msg.timestamp).toISOString(),
        hasAttachments: 0,
        messageType: "text" as const,
        metadata,
      };
    });

    const result = databaseService.batchInsertMessages(messagesToInsert, 500);
    return result.stored;
  }

  /**
   * POST /sync/contacts — receive encrypted contact batch.
   * Requires bearer token authentication + AES-256-GCM decryption.
   *
   * BACKLOG-1449: Android contacts sync
   */
  private async handleSyncContacts(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      // Validate bearer token (same auth as messages)
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        logService.warn("[LocalSync] Missing or invalid Authorization header (contacts)", LOG_TAG);
        sendJSON(res, 401, { error: "Unauthorized" });
        return;
      }

      const token = authHeader.substring(7);
      if (
        !this.authToken ||
        !secureCompare(Buffer.from(token, "utf8"), Buffer.from(this.authToken, "utf8"))
      ) {
        logService.warn("[LocalSync] Invalid bearer token (contacts)", LOG_TAG);
        sendJSON(res, 401, { error: "Unauthorized" });
        return;
      }

      // Read and parse request body
      let body: string;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to read body";
        logService.error(`[LocalSync] Body read error (contacts): ${message}`, LOG_TAG);
        sendJSON(res, 400, { error: message });
        return;
      }

      let encryptedPayload: EncryptedPayload;
      try {
        encryptedPayload = JSON.parse(body) as EncryptedPayload;
      } catch {
        logService.warn("[LocalSync] Invalid JSON in request body (contacts)", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid JSON" });
        return;
      }

      // Validate encrypted payload structure
      if (!encryptedPayload.iv || !encryptedPayload.encrypted || !encryptedPayload.tag) {
        logService.warn("[LocalSync] Missing encrypted payload fields (contacts)", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid payload: missing iv, encrypted, or tag" });
        return;
      }

      // Decrypt
      if (!this.encryptionKey) {
        logService.error("[LocalSync] Encryption key not set (contacts)", LOG_TAG);
        sendJSON(res, 500, { error: "Server not configured" });
        return;
      }

      let decryptedJson: string;
      try {
        decryptedJson = decrypt(encryptedPayload, this.encryptionKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Decryption failed";
        logService.warn(`[LocalSync] Decryption failed (contacts): ${message}`, LOG_TAG);
        sendJSON(res, 400, { error: "Decryption failed" });
        return;
      }

      // Parse decrypted payload
      let contactPayload: ContactSyncPayload;
      try {
        contactPayload = JSON.parse(decryptedJson) as ContactSyncPayload;
      } catch {
        logService.warn("[LocalSync] Invalid JSON in decrypted payload (contacts)", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid decrypted payload" });
        return;
      }

      // Validate contact payload structure
      if (!contactPayload.deviceId || !Array.isArray(contactPayload.contacts)) {
        logService.warn("[LocalSync] Invalid contact payload structure", LOG_TAG);
        sendJSON(res, 400, { error: "Invalid contact payload: missing deviceId or contacts" });
        return;
      }

      logService.info(
        `[LocalSync] Received ${contactPayload.contacts.length} contacts from device ${contactPayload.deviceId}`,
        LOG_TAG
      );

      Sentry.addBreadcrumb({
        category: "localSync",
        message: "Contacts received",
        level: "info",
        data: {
          contactCount: contactPayload.contacts.length,
          deviceId: contactPayload.deviceId,
        },
      });

      // Register the device as paired if not already known, then update last seen.
      // BACKLOG-1454: same fix as handleSyncMessages — ensure device is registered.
      const contactExistingStatus = pairingService.getStatus();
      const contactAlreadyPaired = contactExistingStatus.devices.some(
        (d) => d.deviceId === contactPayload.deviceId
      );
      if (!contactAlreadyPaired) {
        pairingService.addPairedDevice(
          contactPayload.deviceId,
          `Android-${contactPayload.deviceId.substring(0, 8)}`,
          ""
        );
      }
      pairingService.updateLastSeen(contactPayload.deviceId);

      // Store contacts using the externalContactDbService shadow table
      let storedCount = 0;
      if (this.userId && contactPayload.contacts.length > 0) {
        try {
          storedCount = this.storeContacts(
            this.userId,
            contactPayload.deviceId,
            contactPayload.contacts
          );
          logService.info(
            `[LocalSync] Stored ${storedCount} contacts from Android device`,
            LOG_TAG
          );
        } catch (err) {
          const storeError = err instanceof Error ? err.message : "Storage failed";
          logService.error(`[LocalSync] Contact storage error: ${storeError}`, LOG_TAG);
          // Continue — still respond success since contacts were received
        }
      }

      const result: ContactSyncResult = {
        success: true,
        contactsReceived: contactPayload.contacts.length,
        contactsStored: storedCount,
      };

      sendJSON(res, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logService.error(`[LocalSync] Unhandled error (contacts): ${message}`, LOG_TAG);
      sendJSON(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Store received contacts in the external_contacts shadow table.
   * Uses the same pattern as Outlook/Google contact sync — stores
   * in the shadow table with source 'android_sync', matching by
   * device ID + display name as the external_record_id.
   *
   * BACKLOG-1449: Android contacts sync
   *
   * @param userId - User ID for contact ownership
   * @param deviceId - Android device ID from pairing
   * @param contacts - Array of SyncContact from the Android device
   * @returns Number of contacts stored
   */
  private storeContacts(
    userId: string,
    deviceId: string,
    contacts: SyncContact[]
  ): number {
    // Map SyncContact to ExternalContactInput for the generic upsert
    const externalContacts: externalContactDb.ExternalContactInput[] = contacts.map(
      (contact) => {
        // Build external_record_id from deviceId + stable contact ID for dedup
        const externalRecordId = `android-${deviceId}-${contact.id}`;

        // Extract phone numbers as simple strings
        const phones = contact.phones
          .map((p) => p.number)
          .filter((n) => n.length > 0);

        // Extract email addresses as simple strings
        const emails = contact.emails
          .map((e) => e.address)
          .filter((a) => a.length > 0);

        return {
          external_record_id: externalRecordId,
          name: contact.displayName || null,
          emails,
          phones,
          company: contact.company ?? null,
        };
      }
    );

    // Use the existing syncContactsBySource which handles upsert + stale deletion + last_message_at
    const syncResult = externalContactDb.syncContactsBySource(
      userId,
      "android_sync",
      externalContacts
    );

    logService.info(
      `[LocalSync] Android contact sync complete: inserted=${syncResult.inserted}, deleted=${syncResult.deleted}, total=${syncResult.total}`,
      LOG_TAG
    );

    // BACKLOG-1469: Promote Android contacts to the main contacts table.
    // Outlook/Google contacts rely on user-initiated import from the "Available"
    // list, but Android contacts should auto-promote so they appear immediately
    // in the main contacts view. Match by phone number to avoid duplicates.
    this.promoteToMainContacts(userId, contacts);

    return syncResult.inserted;
  }

  /**
   * Promote Android-synced contacts into the main contacts table.
   * For each contact, checks if a matching contact already exists by phone
   * number. Only creates new entries for contacts not already in the main table.
   *
   * BACKLOG-1469: Android contacts were only stored in external_contacts shadow
   * table but never promoted to the main contacts table, making them invisible.
   */
  private promoteToMainContacts(userId: string, contacts: SyncContact[]): void {
    const contactsToCreate: Array<{
      user_id: string;
      display_name: string;
      company?: string;
      title?: string;
      source: string;
      is_imported: boolean;
      allPhones: string[];
      allEmails: string[];
    }> = [];

    for (const contact of contacts) {
      const phones = contact.phones
        .map((p) => p.number)
        .filter((n) => n.length > 0);
      const emails = contact.emails
        .map((e) => e.address)
        .filter((a) => a.length > 0);

      // Skip contacts with no phone numbers and no emails — nothing to match or display
      if (phones.length === 0 && emails.length === 0) {
        continue;
      }

      // Check if any phone number already exists in the main contacts table
      let alreadyExists = false;
      for (const phone of phones) {
        const digits = phone.replace(/\D/g, "");
        const normalized = digits.length >= 10 ? digits.slice(-10) : digits;
        if (normalized.length < 7) continue;

        // Synchronous check against contact_phones table
        const existing = databaseService.findContactByNormalizedPhone(userId, normalized);
        if (existing) {
          alreadyExists = true;
          break;
        }
      }

      if (!alreadyExists) {
        contactsToCreate.push({
          user_id: userId,
          display_name: contact.displayName || "Unknown",
          company: contact.company ?? undefined,
          title: contact.title ?? undefined,
          source: "android_sync", // Migration 36 added 'android_sync' to CHECK constraint (BACKLOG-1470)
          is_imported: true,
          allPhones: phones,
          allEmails: emails,
        });
      }
    }

    if (contactsToCreate.length > 0) {
      const createdIds = databaseService.createContactsBatch(contactsToCreate);
      logService.info(
        `[LocalSync] Promoted ${createdIds.length} Android contacts to main contacts table (${contacts.length - contactsToCreate.length} already existed)`,
        LOG_TAG
      );
    } else {
      logService.info(
        `[LocalSync] All ${contacts.length} Android contacts already exist in main contacts table, no promotion needed`,
        LOG_TAG
      );
    }
  }
}

// Export singleton instance
const localSyncService = new LocalSyncService();
export default localSyncService;
