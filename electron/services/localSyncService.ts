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
import supabaseService from "./supabaseService";
import { normalizePhone } from "./messageMatchingService";
import { pairingService } from "./pairingService";
import * as externalContactDb from "./db/externalContactDbService";
import type { ContactOrigin } from "./db/contactOriginLink";
import { findClaimedSourceRecordIds } from "./db/contactOriginLink";
import { autoLinkNewMessagesForUserDebounced } from "./autoLinkService";
import { toMatchingKey } from "../utils/phoneNormalization";
// BACKLOG-2986: the Android contact WRITE gate. Same helper the picker gate and
// the iPhone write gate read.
import { isContactSourceEnabled } from "../utils/preferenceHelper";
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
 * BACKLOG-2224 / BACKLOG-2284: upper bound on the Supabase getUser() identity
 * check at /register. A network black-hole resolves to `unverified` after this
 * deadline so the pairing fails closed instead of hanging the request handler.
 */
const VERIFY_TIMEOUT_MS = 4000;

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
 * Result of cryptographically verifying a phone's Supabase identity against the
 * desktop's logged-in user (BACKLOG-2224).
 *
 * - `verified_match`    — the access token was validated by Supabase and its
 *                         user id equals the desktop's logged-in user id.
 * - `verified_mismatch` — the token was validated but belongs to a DIFFERENT
 *                         user → the pairing must be rejected (403).
 * - `unverified`        — the token could not be validated (desktop offline,
 *                         network error, request timed out, or Supabase rejected
 *                         the token). At /register this now fails CLOSED: the
 *                         caller rejects (no claim-compare fallback).
 */
export type PhoneIdentityResult =
  | { status: "verified_match" }
  | { status: "verified_mismatch"; actualUserId: string | null }
  | { status: "unverified"; reason: string };

/**
 * Verify that the phone's Supabase access token actually belongs to
 * `expectedUserId` (the desktop's logged-in user).
 *
 * BACKLOG-2224: the authoritative account-match check. Calls
 * `supabaseService.getClient().auth.getUser(accessToken)` — which validates the
 * JWT against Supabase's auth server — and compares the returned user id.
 *
 * This function never throws: any failure (offline, timeout, invalid/expired
 * token) is reported as `unverified` so the caller can fail closed rather than
 * crashing the request handler.
 *
 * The network call is bounded by {@link VERIFY_TIMEOUT_MS}: a black-holed
 * connection resolves to `unverified` (reason `"timeout"`) instead of hanging
 * the /register handler indefinitely (BACKLOG-2224 / BACKLOG-2284).
 *
 * @param accessToken - The phone's Supabase access token (JWT) from /register.
 * @param expectedUserId - The desktop's logged-in Supabase user id.
 */
export async function verifyPhoneIdentity(
  accessToken: string,
  expectedUserId: string
): Promise<PhoneIdentityResult> {
  try {
    const client = supabaseService.getClient();

    // The verify promise never rejects — every failure resolves to `unverified`
    // so a late rejection after the timeout wins the race cannot become an
    // unhandled rejection.
    const verify = (async (): Promise<PhoneIdentityResult> => {
      try {
        const { data, error } = await client.auth.getUser(accessToken);
        if (error || !data?.user) {
          return {
            status: "unverified",
            reason: error?.message ?? "No user for access token",
          };
        }
        if (data.user.id === expectedUserId) {
          return { status: "verified_match" };
        }
        return { status: "verified_mismatch", actualUserId: data.user.id };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "getUser threw";
        return { status: "unverified", reason };
      }
    })();

    // Bound the call so a hung network cannot stall /register (fails closed).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PhoneIdentityResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "unverified", reason: "timeout" }),
        VERIFY_TIMEOUT_MS
      );
    });

    try {
      return await Promise.race([verify, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "verify threw";
    return { status: "unverified", reason };
  }
}

/**
 * SESSION-FIX: which human-readable body a pairing/sync 403 reject should carry.
 *
 * The allow/reject DECISION is owned by decideRegisterAccount (BACKLOG-2224) and
 * isSyncAccountAllowed (BACKLOG-2284) and is NOT affected by this mapping — it
 * only makes the emitted message match the reason those functions already
 * computed and logged. Previously EVERY reject returned the same "different
 * Keepr account" body, so a phone whose Supabase session was revoked
 * ("Auth session missing!") was mislabeled as being signed into a wrong account.
 *
 * Reject kinds:
 *   - account_mismatch → the phone verifiably belongs to a DIFFERENT Keepr user.
 *   - session_expired  → the phone's identity could NOT be verified (expired /
 *                        revoked / offline / timeout). NOT a wrong account.
 *   - identity_missing → the phone sent no verifiable identity at all (legacy
 *                        build or claim-only payload).
 */
export type PairingRejectKind =
  | "account_mismatch"
  | "session_expired"
  | "identity_missing";

/** The 403 body strings, keyed by reject kind. Message text only. */
export const PAIRING_REJECT_BODY: Record<PairingRejectKind, string> = {
  // Unchanged 2224/2284 copy — genuine wrong-account rejects read exactly as
  // before (the companion also keys pairing feedback on HTTP 403, not this text).
  account_mismatch:
    "Account mismatch: this phone is signed into a different Keepr account than the desktop.",
  session_expired:
    "Your phone's session has expired — sign in again on your phone, then re-pair.",
  identity_missing:
    "This phone didn't send a verifiable Keepr identity. Update Keepr on your phone, sign in, then re-pair.",
};

/**
 * Classify a decideRegisterAccount reject `reason` (the SAME string it logs)
 * into a 403 body kind. Message text only — never changes the reject decision.
 *
 * decideRegisterAccount emits exactly three reject reasons:
 *   - "identity verification required"        (no access token)      → identity_missing
 *   - "verified phone user … != desktop user" (verified_mismatch)    → account_mismatch
 *   - "could not verify phone identity: …"    (unverified: expired /  → session_expired
 *                                              revoked / offline / timeout)
 * Any unforeseen reason falls through to identity_missing so a reject is never
 * mislabeled as a wrong account.
 */
export function registerRejectKind(reason: string): PairingRejectKind {
  if (reason.startsWith("verified phone user")) return "account_mismatch";
  if (reason.startsWith("could not verify phone identity"))
    return "session_expired";
  return "identity_missing";
}

/**
 * Pick the 403 body kind for a /sync reject. isSyncAccountAllowed (BACKLOG-2284)
 * returns false for exactly two reasons, both derivable here from the claim it
 * already inspected:
 *   - claim present but ≠ desktop user → account_mismatch
 *   - claim absent                     → identity_missing
 * A /sync batch never carries an access token, so there is no online verify step
 * and therefore no session_expired case here. Message text only.
 */
export function syncRejectKind(
  claimedUserId: string | undefined,
  desktopUserId: string | null | undefined
): PairingRejectKind {
  if (claimedUserId && claimedUserId !== desktopUserId)
    return "account_mismatch";
  return "identity_missing";
}

/**
 * BACKLOG-2210: shape of a desktop-minted device id (crypto.randomUUID()).
 *
 * The desktop mints a per-pairing UUID at /register and returns it; the phone
 * adopts it as its identity. On any subsequent /register the phone sends that
 * UUID back — recognising the shape lets the desktop REUSE it (idempotent, even
 * across a desktop restart that empties the in-memory paired-device map) instead
 * of minting a fresh one and forcing a needless re-key. A name-derived id (the
 * legacy `deviceId = deviceName` value an un-migrated companion still sends) is
 * never UUID-shaped, so it always triggers a fresh mint — which is exactly the
 * fix: two phones with the same NAME can no longer collide on one identity.
 */
function isMintedDeviceId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
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
   * BACKLOG-2224 / BACKLOG-2284: one-shot flags so the "no phone identity"
   * Sentry warnings (emitted when a phone syncs without sending its Supabase
   * identity) fire at most once per endpoint per server session instead of once
   * per batch. As of BACKLOG-2284 an absent identity is REJECTED (fail-closed),
   * not allowed — the flags now rate-limit the *rejection* telemetry so we can
   * still observe any lingering legacy phones without Sentry spam. /register and
   * /sync/* are both strict now. Reset whenever the server (re)starts or stops.
   */
  private legacySyncMessagesLogged = false;
  private legacySyncContactsLogged = false;

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
    this.legacySyncMessagesLogged = false;
    this.legacySyncContactsLogged = false;

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
        this.legacySyncMessagesLogged = false;
        this.legacySyncContactsLogged = false;
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
   *
   * ## BACKLOG-2956 — why this logs the way it does
   *
   * This server used to be effectively SILENT about traffic. The entry line
   * below was `logService.debug`, and `logService`'s `minLevel` defaults to
   * `"info"` (see logService.ts), so it was DROPPED in every normal run. The
   * unknown-route branch at the bottom logged nothing at all. The consequence
   * was measured on the founder's machine: his phone's BROWSER reached this
   * server and got a 404, and the desktop log recorded **nothing** — leaving an
   * Android cleartext block (which never opens a socket) and a genuine network
   * fault indistinguishable from each other and from the server never having
   * been contacted. That is what made the failure undiagnosable, here and on a
   * field tester's machine.
   *
   * So: one `info` line per request with method, path and remote address, and
   * one on completion with the status code and duration. The pair is what
   * separates "nothing arrived" from "something arrived and we refused it" —
   * the single most useful distinction when local sync is not working.
   *
   * NEVER log the request body or the bearer token. Bodies are SMS content.
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const urlPath = req.url?.split("?")[0] ?? "";
    const method = req.method?.toUpperCase() ?? "";
    const remote = req.socket.remoteAddress ?? "unknown";
    const startedAt = Date.now();

    logService.info(
      `[LocalSync] --> ${method} ${urlPath} from ${remote}`,
      LOG_TAG
    );

    // One completion line per request, whichever branch answered it — including
    // branches added later, and including the `catch`-all 500s. Attaching to
    // "finish" rather than instrumenting each `sendJSON` call site is what makes
    // that coverage structural instead of a convention someone can forget.
    res.on("finish", () => {
      const status = res.statusCode;
      const durationMs = Date.now() - startedAt;
      const line = `[LocalSync] <-- ${status} ${method} ${urlPath} from ${remote} (${durationMs}ms)`;
      if (status >= 400) {
        logService.warn(line, LOG_TAG);
      } else {
        logService.info(line, LOG_TAG);
      }

      // A failed PAIRING is the outcome users report and the one we have been
      // unable to see. Send a Sentry EVENT, not a breadcrumb: breadcrumbs are
      // discarded unless some other event happens to be captured in the same
      // session (BACKLOG-2913 / BACKLOG-2950), which is exactly why the pairing
      // failures reported so far left no trace. Remote address is deliberately
      // NOT sent — it stays in the local log.
      if (urlPath === "/register" && status >= 400) {
        Sentry.captureMessage(
          `[LocalSync] Pairing request failed with ${status}`,
          {
            level: "warning",
            tags: {
              component: "localSyncService",
              reason: "register_failed",
              status: String(status),
            },
            extra: { method, durationMs },
          }
        );
      }
    });

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

    // Unknown route. Logged with the reason because this is the branch a
    // browser (or a probe, or a companion built against a future API) lands on,
    // and a bare 404 with no log is indistinguishable from silence.
    logService.warn(
      `[LocalSync] No route for ${method} ${urlPath} (from ${remote}) — responding 404`,
      LOG_TAG
    );
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
   * BACKLOG-2224: decide whether a /register request is allowed based on a
   * cryptographically verified account-match between the phone and the
   * desktop's logged-in user.
   *
   * STRICT / fail-closed. When the desktop is logged in the ONLY allow path is
   * a Supabase-verified identity whose user id equals the desktop's:
   *   - Desktop logged out           → allow (nothing gets stored anyway).
   *   - No access token              → reject (cannot verify — covers legacy
   *                                     builds AND claim-only payloads).
   *   - verified_match               → allow (records verifiedUserId).
   *   - verified_mismatch            → reject (different Supabase account).
   *   - unverified (expired / offline → reject (NO claim-compare fallback).
   *     / network / timeout)
   *
   * This removes every user-controlled allow path except the cryptographic
   * match, closing CodeQL js/user-controlled-bypass. All Sentry logging for
   * reject paths happens here; the caller only maps the decision to an HTTP
   * response. The phone's *claimed* user id is no longer consulted for the
   * decision.
   */
  private async decideRegisterAccount(
    accessToken: string | undefined
  ): Promise<
    | { action: "reject"; reason: string }
    | { action: "allow"; verifiedUserId?: string }
  > {
    // Desktop logged out — no user context to enforce against.
    if (!this.userId) {
      return { action: "allow" };
    }

    // Identity verification is mandatory. Without an access token we cannot
    // cryptographically prove the phone's account, so reject. This single check
    // covers both legacy builds (no identity) and claim-only payloads (a
    // supabaseUserId with no token) that the old soft path used to allow.
    if (!accessToken) {
      return { action: "reject", reason: "identity verification required" };
    }

    const result = await verifyPhoneIdentity(accessToken, this.userId);

    if (result.status === "verified_match") {
      return { action: "allow", verifiedUserId: this.userId };
    }

    if (result.status === "verified_mismatch") {
      Sentry.captureMessage(
        "[LocalSync] Pairing rejected: verified account mismatch",
        {
          level: "warning",
          tags: {
            component: "localSyncService",
            reason: "account_mismatch_verified",
          },
        }
      );
      return {
        action: "reject",
        reason: `verified phone user ${result.actualUserId ?? "unknown"} != desktop user`,
      };
    }

    // status === "unverified" (expired / offline / network / timeout): fail
    // closed. The old offline claim-compare fallback WAS the user-controlled
    // bypass, so there is deliberately no allow path here.
    Sentry.captureMessage(
      "[LocalSync] Pairing rejected: could not verify phone identity",
      {
        level: "warning",
        tags: {
          component: "localSyncService",
          reason: "register_verify_failed",
        },
      }
    );
    return {
      action: "reject",
      reason: `could not verify phone identity: ${result.reason}`,
    };
  }

  /**
   * BACKLOG-2284 STRICT account gate for /sync/* batches (replaces the
   * BACKLOG-2224 soft backstop). Decides whether a decrypted /sync batch is
   * allowed based on the phone's Supabase user id claim in the payload.
   *
   * STRICT / fail-closed, mirroring the strict /register contract:
   *   - Desktop logged OUT (no userId)  → allow (nothing is stored to enforce
   *     against — same carve-out as decideRegisterAccount).
   *   - claim === desktop user          → allow.
   *   - claim !== desktop user          → reject (account mismatch).
   *   - claim ABSENT                    → reject (was allow + log). This closes
   *     the last soft path: a legacy phone that sends no identity can no longer
   *     sync into a logged-in desktop.
   *
   * NOTE — why this is CLAIM-based, not a token verify with a timeout like
   * /register: a /sync batch carries only the phone's CLAIMED user id. The
   * companion deliberately omits the Supabase access token on the hot sync path
   * (android-companion/services/syncService.ts sends `supabaseUserId` but not
   * `supabaseAccessToken` on /sync/*), so there is no online getUser() call and
   * therefore no network timeout to guard on /sync — an online verify would
   * reject every legitimate sync. The fail-closed guarantee here is structural:
   * an absent or mismatched claim is rejected outright. Identity was
   * cryptographically verified once at strict /register (BACKLOG-2224), before
   * the pairing secret needed to reach this handler ever existed.
   *
   * Returning false makes the caller respond with the SAME 403 + "Account
   * mismatch…" body used by the strict /register reject, so the companion's
   * pairing-feedback (BACKLOG-2212) classifies it as an account/identity
   * failure rather than a generic network error.
   */
  private isSyncAccountAllowed(
    claimedUserId: string | undefined,
    endpoint: "messages" | "contacts"
  ): boolean {
    // Desktop logged out — nothing gets stored anyway.
    if (!this.userId) {
      return true;
    }

    if (claimedUserId) {
      if (claimedUserId === this.userId) {
        return true;
      }
      Sentry.captureMessage(
        `[LocalSync] Sync rejected: account mismatch (${endpoint})`,
        {
          level: "warning",
          tags: {
            component: "localSyncService",
            reason: "sync_account_mismatch",
            endpoint,
          },
        }
      );
      return false;
    }

    // BACKLOG-2284: absent identity is now REJECTED (fail-closed). Previously
    // the soft backstop allowed this for legacy phone builds. Log once per
    // endpoint per server session so lingering legacy phones are observable
    // without Sentry spam.
    const alreadyLogged =
      endpoint === "messages"
        ? this.legacySyncMessagesLogged
        : this.legacySyncContactsLogged;
    if (!alreadyLogged) {
      if (endpoint === "messages") {
        this.legacySyncMessagesLogged = true;
      } else {
        this.legacySyncContactsLogged = true;
      }
      Sentry.captureMessage(
        `[LocalSync] Sync rejected: no phone identity (strict, ${endpoint})`,
        {
          level: "warning",
          tags: {
            component: "localSyncService",
            reason: "sync_no_identity_rejected",
            endpoint,
          },
        }
      );
    }
    return false;
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

      let registerPayload: {
        deviceId?: string;
        deviceName?: string;
        // BACKLOG-2224: phone identity for account-match verification. Only
        // supabaseAccessToken drives the decision (it is cryptographically
        // verified); supabaseUserId is now informational only — the claimed id
        // is never trusted for allow/reject.
        supabaseUserId?: string;
        supabaseAccessToken?: string;
      };
      try {
        registerPayload = JSON.parse(body) as typeof registerPayload;
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

      // BACKLOG-2210: the desktop MINTS the device identity. A phone's
      // name-derived deviceId (legacy `deviceId = deviceName`) is never trusted
      // as an identity — two phones with the same name would collide on it and
      // overwrite each other's paired-device entry / sync namespace. We mint a
      // fresh UUID for it and return it for the phone to adopt. A phone that has
      // ALREADY adopted a minted UUID sends it back on re-register; we recognise
      // the shape and REUSE it (idempotent — no churn across desktop restarts,
      // which empty the in-memory paired-device map).
      const claimedDeviceId = registerPayload.deviceId;
      const deviceId = isMintedDeviceId(claimedDeviceId)
        ? claimedDeviceId
        : crypto.randomUUID();
      const deviceName = registerPayload.deviceName || `Android-${deviceId.substring(0, 8)}`;

      logService.info(
        `[LocalSync] Device registration: ${deviceName} (${deviceId})` +
          (deviceId === claimedDeviceId ? "" : ` [minted for claim '${claimedDeviceId}']`),
        LOG_TAG
      );

      // BACKLOG-2224: STRICT, fail-closed account-match at pair time. The only
      // allow path (desktop logged in) is a Supabase-verified access token whose
      // user id equals the desktop's — so a phone on account A can never pair to
      // a desktop on account B and leak its texts/contacts, and an unverifiable
      // request (no token / expired / offline / timeout) is rejected rather than
      // trusted. A logged-out desktop is handled inside decideRegisterAccount.
      // Closes CodeQL js/user-controlled-bypass.
      const decision = await this.decideRegisterAccount(
        registerPayload.supabaseAccessToken
      );
      if (decision.action === "reject") {
        logService.warn(
          `[LocalSync] Register REJECTED: ${decision.reason}`,
          LOG_TAG
        );
        // SESSION-FIX: reflect the ACTUAL reject reason so a revoked/expired
        // phone session isn't mislabeled as a wrong account. The reject decision
        // itself (BACKLOG-2224) is unchanged — this only selects the body text.
        sendJSON(res, 403, {
          error: PAIRING_REJECT_BODY[registerRejectKind(decision.reason)],
        });
        return;
      }

      // Register the device as paired if not already known
      const existingStatus = pairingService.getStatus();
      const alreadyPaired = existingStatus.devices.some(
        (d) => d.deviceId === deviceId
      );
      if (!alreadyPaired) {
        pairingService.addPairedDevice(
          deviceId,
          deviceName,
          "", // secret not needed after pairing — auth already validated via bearer token
          decision.verifiedUserId
        );
      }
      pairingService.updateLastSeen(deviceId);

      // BACKLOG-2210: return the (possibly minted) device identity so the phone
      // adopts it for all subsequent /sync/* payloads — this is what ends the
      // deviceId=deviceName collision. Additive: an OLD companion ignores this
      // field and keeps its name-derived id (no regression, same as today).
      // BACKLOG-2208: advertise desktop capabilities so a NEW companion knows
      // whether this desktop understands incremental contact diffs. An OLD
      // desktop never sends this field, so the companion fails safe to sending
      // the FULL address book every cycle (never opening the partial-diff window
      // that an old desktop would mis-handle by stale-deleting the rest).
      sendJSON(res, 200, {
        success: true,
        deviceId,
        capabilities: { contactDiff: true },
      });
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

      // BACKLOG-2284 strict gate: reject on an account mismatch OR an absent
      // phone identity (fail-closed). Only a matching claim (or a logged-out
      // desktop) is allowed.
      if (!this.isSyncAccountAllowed(syncPayload.supabaseUserId, "messages")) {
        logService.warn(
          "[LocalSync] Sync REJECTED (messages): phone account/identity check failed",
          LOG_TAG
        );
        // SESSION-FIX: reason-specific body (account mismatch vs. absent
        // identity). The reject decision (BACKLOG-2284) is unchanged.
        sendJSON(res, 403, {
          error:
            PAIRING_REJECT_BODY[
              syncRejectKind(syncPayload.supabaseUserId, this.userId)
            ],
        });
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
   *   - Standard phone numbers (7+ digits): raw digits from sender (e.g., "5555550112")
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

      // BACKLOG-2284 strict gate: reject on an account mismatch OR an absent
      // phone identity (fail-closed). Only a matching claim (or a logged-out
      // desktop) is allowed.
      if (!this.isSyncAccountAllowed(contactPayload.supabaseUserId, "contacts")) {
        logService.warn(
          "[LocalSync] Sync REJECTED (contacts): phone account/identity check failed",
          LOG_TAG
        );
        // SESSION-FIX: reason-specific body (account mismatch vs. absent
        // identity). The reject decision (BACKLOG-2284) is unchanged.
        sendJSON(res, 403, {
          error:
            PAIRING_REJECT_BODY[
              syncRejectKind(contactPayload.supabaseUserId, this.userId)
            ],
        });
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
          // BACKLOG-2986: `storeContacts` became async when it grew the
          // `androidContacts` gate — it reads the preference before writing.
          // This handler was already async, so the await costs nothing
          // structurally; it does mean the phone's POST now waits on one
          // Supabase round trip. Worst case on a network blip is latency and
          // then fail-open, and a phone retry is safe because BACKLOG-2987's
          // record claims make promotion idempotent.
          storedCount = await this.storeContacts(
            this.userId,
            contactPayload.deviceId,
            contactPayload.contacts,
            contactPayload.isFullSync
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
   * The `external_contacts.external_record_id` for one Android contact.
   *
   * ONE SPELLING, TWO CALLERS (BACKLOG-2556). `storeContacts` writes the record
   * under this id and `promoteToMainContacts` CLAIMS that same id in the
   * crosswalk. If the two ever disagree the claim silently matches nothing, the
   * record looks un-imported, and the promoted contact appears twice — which is
   * exactly the failure mode this helper exists to make impossible. It is the
   * same trap `contactOriginLink.ts` guards against with its single
   * `contacts.source` -> crosswalk `source_type` map: one address book must not
   * acquire a second spelling.
   *
   * The composition itself is unchanged and still carries the BACKLOG-2407
   * defect recorded inside `storeContacts` — this only stops it being written
   * out twice.
   */
  private androidExternalRecordId(deviceId: string, contactId: string): string {
    return `android-${deviceId}-${contactId}`;
  }

  /**
   * Store received contacts in the external_contacts shadow table.
   * Uses the same pattern as Outlook/Google contact sync — stores
   * in the shadow table with source 'android_sync', matching by
   * device ID + display name as the external_record_id.
   *
   * BACKLOG-1449: Android contacts sync
   * BACKLOG-2208: full snapshot vs incremental diff.
   * BACKLOG-2986: the `androidContacts` preference now gates the PROMOTION at
   *   the bottom of this method. It does NOT gate the shadow-table write above
   *   it — see the gate for why, and note that this is why the method is async.
   *
   * @param userId - User ID for contact ownership
   * @param deviceId - Android device ID from pairing
   * @param contacts - Array of SyncContact from the Android device (the full
   *   address book on a full sync, only new/changed contacts on a diff)
   * @param isFullSync - whether `contacts` is a FULL snapshot. On a full sync we
   *   upsert + stale-DELETE any `android_sync` contact missing from the batch
   *   (reconciles phone-side deletions). On a partial diff we upsert ONLY — a
   *   diff omits unchanged contacts, so stale-deletion would wrongly remove
   *   them. ABSENT (legacy phone that always sends everything) is treated as a
   *   full sync, preserving the pre-2208 behavior.
   * @returns Number of contacts stored/upserted
   */
  private async storeContacts(
    userId: string,
    deviceId: string,
    contacts: SyncContact[],
    isFullSync?: boolean
  ): Promise<number> {
    /**
     * =====================================================================
     * BACKLOG-2986 — THE WRITE GATE. Read before moving it or narrowing it.
     * =====================================================================
     * Read at the TOP, used at the bottom, on purpose: the Supabase round trip
     * happens BEFORE any DB work rather than interleaved between
     * `syncContactsBySource` and `promoteToMainContacts`.
     *
     * WHY THE PREFERENCE IS READ HERE AND NOT PASSED IN. It could have been
     * hoisted into `handleSyncContacts` and threaded down as a parameter,
     * keeping this method synchronous. It is read here so that the read and the
     * gate it feeds sit in the same function, which is the only arrangement a
     * `storeContacts` test can observe: with the read hoisted, a mutation
     * replacing it with a literal `true` stays green in every suite that drives
     * this method. `handleSyncContacts` was already `async`, so nothing had to
     * be restructured to allow this.
     *
     * The precedent is `iPhoneSyncStorageService.storeContacts`, which reads the
     * same helper at the top of the method it gates, with the same fail-open
     * default and the same info-level skip log.
     *
     * ONE DELIBERATE DIVERGENCE FROM THAT PRECEDENT: the iPhone gate skips the
     * WHOLE store. This one skips only the promotion, and the shadow-table write
     * below runs unconditionally. iPhone contacts are desktop-PULLED — a record
     * we decline to store can be read off the backup again. Android contacts are
     * phone-PUSHED and the companion sends a DIFF (BACKLOG-2411), so a record we
     * refuse to store is one the desktop cannot ask for again on any INCREMENTAL
     * cycle: `handleSyncContacts` answers 200 whatever the store did, and on a
     * 200 the companion advances its fingerprint map for exactly what it sent
     * (`android-companion/services/contactSyncState.ts` `commitContactSync`), so
     * it has no reason to mention those contacts again. They return only on the
     * next FULL snapshot — `FULL_RESYNC_INTERVAL_MS`, 24h — so gating the store
     * would open a silent up-to-24h window in which the shadow ledger disagrees
     * with the phone. Per the DECISION on BACKLOG-3001, no operation may treat
     * `android_sync` as re-fetchable. `external_contacts` therefore stays LOSSLESS and only the
     * automatic write into the main `contacts` table is gated — the user's route
     * back is the picker, which the same key already governs.
     *
     * `defaultValue: true` is the picker's value, not a guess. It is reached
     * only when preferences cannot be READ AT ALL, where a failed read cannot
     * see `phone_type` either — so both gates fail open together and can never
     * disagree about a user who is offline.
     */
    const androidEnabled = await isContactSourceEnabled(
      userId,
      "direct",
      "androidContacts",
      true,
    );

    // Map SyncContact to ExternalContactInput for the generic upsert
    const externalContacts: externalContactDb.ExternalContactInput[] = contacts.map(
      (contact) => {
        // ---------------------------------------------------------------
        // BACKLOG-2407 — RECORDED DECISION ON THE `deviceId` COMPONENT.
        // The key is UNCHANGED here. Read this before assuming lookupKey
        // capture fixed device replacement, because it did not.
        // ---------------------------------------------------------------
        // THE DEFECT. `contact.id` is `ContactsContract.Contacts._ID`, a row id
        // Android explicitly does NOT designate as sync-stable, and `deviceId`
        // is worse: a DESKTOP-minted per-pairing UUID (see the /register handler
        // in this file — `isMintedDeviceId(claimed) ? claimed : randomUUID()`).
        // A phone that re-pairs without presenting its previous minted UUID gets
        // a NEW one, so EVERY android contact re-keys — even when the phone, and
        // therefore every `_ID` and `lookupKey` on it, is completely unchanged.
        // The device-scoping is the larger half of the defect, not the id choice.
        //
        // WHY IT IS NOT FIXED IN THIS TASK. Re-keying a live namespace is a data
        // migration with a pairing story attached; it does not belong in a task
        // whose contract is to capture identifiers and change no behaviour.
        // Capturing `lookupKey` is a PREREQUISITE for that fix, not the fix.
        //
        // THE RECOMMENDED FIX. Move device identity to the companion: persist it
        // in the phone's own storage and re-present it on every pairing, so the
        // desktop reuses rather than mints. `isMintedDeviceId` already implements
        // the reuse half. Not purely a storage change — Android wipes app storage
        // on uninstall, so reinstall still needs an answer.
        //
        // WHAT HAPPENS TODAY WHEN IT RE-KEYS, verified rather than assumed. The
        // BACKLOG-2401 crosswalk re-links the new record to the same contact by
        // email then phone: `linkExternalContactsForUser` filters only on
        // `user_id` and `external_record_id IS NOT NULL`, with no source filter,
        // so android_sync genuinely reaches that fallback. It is a partial
        // recovery, not a repair. On a re-pairing FULL sync,
        // `syncContactsBySource` -> `deleteStaleContactsBySource` DELETES the old
        // `android-<old>-<id>` rows outright, while `contact_source_links` keys on
        // (source_type, source_record_id) with its FK on `contact_id` — so the
        // external row is destroyed underneath a surviving crosswalk row rather
        // than merely going stale. And a contact carrying neither an email nor a
        // phone recovers nothing at all.
        const externalRecordId = this.androidExternalRecordId(deviceId, contact.id);

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
          // BACKLOG-2407: capture the lookup key beside the key, matched on by
          // nothing. Absent for any contact with no structured-name row, which
          // the serializer drops rather than storing as a null entry.
          source_identity: { lookupKey: contact.lookupKey ?? null },
        };
      }
    );

    // BACKLOG-2208: a partial diff omits unchanged contacts, so it must NOT
    // trigger the stale-deletion inside syncContactsBySource (that would delete
    // every unchanged contact). A FULL snapshot (or a legacy phone with no flag)
    // keeps the reconcile-with-deletion behavior. `isFullSync !== false` treats
    // absent/true as full, false as partial.
    const isFull = isFullSync !== false;
    let inserted: number;
    let deleted = 0;
    if (isFull) {
      // Full snapshot: upsert + stale-delete + last_message_at (unchanged path).
      const syncResult = externalContactDb.syncContactsBySource(
        userId,
        "android_sync",
        externalContacts
      );
      inserted = syncResult.inserted;
      deleted = syncResult.deleted;
    } else {
      // Incremental diff: upsert only, no stale-deletion.
      inserted = externalContactDb.upsertExternalContacts(
        userId,
        "android_sync",
        externalContacts
      );

      // BACKLOG-2401: re-stamp EVERY android row as seen in this sync.
      //
      // A diff upserts only what CHANGED, so without this each unchanged row
      // keeps an older `synced_at` and reads as "not present in the latest
      // sync". That is the marker `deleteStaleContactsBySource` prunes on and
      // the identity crosswalk's currency test reads — so between full
      // snapshots the crosswalk's reassignment guard would be silently DISABLED
      // for android_sync, and a phone number that had moved between two people
      // would be bound to the WRONG contact without ever being flagged.
      //
      // This asserts nothing new: skipping the stale-deletion two lines above
      // already means "rows I did not mention are still present". It writes that
      // down instead of leaving it implicit. See markSourceRecordsCurrent for
      // the audit of every other `synced_at` reader.
      externalContactDb.markSourceRecordsCurrent(userId, "android_sync");

      externalContactDb.updateLastMessageAtFromLookupTable(userId);
    }

    logService.info(
      `[LocalSync] Android contact sync complete (${isFull ? "full" : "diff"}): ` +
        `inserted=${inserted}, deleted=${deleted}, total=${externalContactDb.getCount(userId)}`,
      LOG_TAG
    );

    // BACKLOG-1469 / BACKLOG-2986: promote Android contacts to the main contacts
    // table — ONLY when the user has the Android contact source switched on.
    //
    // Outlook/Google contacts rely on user-initiated import from the "Available"
    // list; Android auto-promotes so the phone's address book appears
    // immediately in the main contacts view. Match by phone number to avoid
    // duplicates. On a partial diff this only promotes the new/changed contacts,
    // which is correct — unchanged contacts were promoted on a prior sync
    // (BACKLOG-2208).
    //
    // BACKLOG-2986 ADDED THE CONDITION, and the paragraph above used to argue
    // for it being unconditional. Until this change `androidContacts` gated the
    // PICKER and nothing else, so a user who switched Android contacts off
    // watched them disappear from the picker while this line kept writing new
    // ones straight into their contacts table on every sync. Founder,
    // 2026-08-30: "contacts aren't auto imported." A control that does not
    // control the thing it names is the defect BACKLOG-2986 exists to fix, not a
    // smaller version of the feature.
    //
    // NOT re-promoted on switch-on. Contacts that arrived while the switch was
    // off stay unpromoted until the next FULL sync mentions them again — at most
    // 24h away (`FULL_RESYNC_INTERVAL_MS` on the companion). They are NOT in the
    // picker while the switch is off: `contactHandlers.ts:1619` gates
    // `android_sync` on this same key, so an off switch hides them from both
    // places. Switching it back ON opens the picker on the whole backlog
    // immediately, and that is the user-driven route back. Auto-promoting a
    // backlog the user had deliberately switched off would be the same
    // auto-import this gate exists to stop.
    if (androidEnabled) {
      this.promoteToMainContacts(userId, deviceId, contacts);
    } else {
      // Info, not debug, and it names the reason: a silent skip is
      // indistinguishable in the field from a sync that failed.
      logService.info(
        `[LocalSync] Android contact promotion skipped: the Android Phone Contacts source ` +
          `is off for this user (${contacts.length} contacts stored in external_contacts, ` +
          `none written to the contacts table, and none offered in the picker — the same ` +
          `preference hides them there until the user switches the source back on)`,
        LOG_TAG
      );
    }

    return inserted;
  }

  /**
   * Promote Android-synced contacts into the main contacts table.
   * For each contact, checks if a matching contact already exists by phone
   * number. Only creates new entries for contacts not already in the main table.
   *
   * BACKLOG-1469: Android contacts were only stored in external_contacts shadow
   * table but never promoted to the main contacts table, making them invisible.
   *
   * BACKLOG-2986: THIS METHOD STILL READS NO PREFERENCE, and must not start —
   * its caller decides. The gate lives at the top of `storeContacts`, which is
   * where the read can be observed by the suites that drive the write path. Do
   * not add a second read here: two gates on one decision is how they come to
   * disagree.
   *
   * BACKLOG-2556 — `deviceId` is a parameter because THE PROMOTED CONTACT MUST
   * CLAIM THE RECORD IT CAME FROM. See the origin below.
   */
  private promoteToMainContacts(
    userId: string,
    deviceId: string,
    contacts: SyncContact[],
  ): void {
    // BACKLOG-2593 — KNOWN DEFECTS IN THE SKIP BELOW. Read before relying on
    // this method's claims.
    //
    // 1. The PHONE test is a shared normalized number with NO NAME CHECK — the
    //    BACKLOG-2416 shape, on a create path. Two people on one office line:
    //    the second is never created. STILL OPEN (a person-identity rule, and
    //    founder-decided; deliberately not touched by BACKLOG-2987).
    // 2. When it skips, NOTHING IS CLAIMED, while `storeContacts` has already
    //    written the record to `external_contacts`. The create path below claims
    //    its record (BACKLOG-2556); this skip does not. STILL OPEN.
    //
    // The third — a contact with NO phone was re-created on EVERY sync, because
    // it never entered the phone loop at all — is CLOSED by the record-claim
    // probe below (BACKLOG-2987).
    //
    // The BACKLOG-2407 block in `storeContacts` used to make the skip the COMMON
    // case: a re-pairing minted a new `deviceId`, every record re-keyed, and
    // every contact then phone-matched its own previously-promoted twin. The
    // companion now re-presents its identity at /register (BACKLOG-2987,
    // android-companion/services/deviceIdentity.ts) so the id is stable across
    // re-pairs and the record key no longer churns.
    //
    // Blocker-level for the BACKLOG-2556 deletion PR: claim on the skip path, or
    // have the founder accept it. Deliberately not decided here.
    const contactsToCreate: Array<{
      user_id: string;
      display_name: string;
      company?: string;
      title?: string;
      source: string;
      is_imported: boolean;
      allPhones: string[];
      allEmails: string[];
      origin: ContactOrigin;
    }> = [];

    // =====================================================================
    // BACKLOG-2987 — HAVE WE ALREADY IMPORTED THIS RECORD?
    // =====================================================================
    // Asked BEFORE the phone probe, and answered from our OWN bookkeeping
    // rather than from a guess about who a person is.
    //
    // THE DEFECT IT CLOSES. The phone probe below is the only test this method
    // had, so a contact carrying no phone number — an email-only address-book
    // entry — never entered the loop, `alreadyExists` stayed false, and it was
    // created again on every single sync. Measured on the founder's machine:
    // the SAME 26 of 389 contacts re-created on three consecutive runs (log
    // comparison across runs: 0 differing entries), 25 of them carrying an
    // email and no matchable phone.
    //
    // WHY NOT "ALSO MATCH ON EMAIL". That is a new person-identity rule and it
    // is not this fix's to make (BACKLOG-2416: two people on one shared address
    // would collapse into one contact). The claim probe asks a bookkeeping
    // question with a definite answer, so it carries no false-positive risk and
    // needs no founder ruling.
    //
    // IT DEPENDS ON A STABLE deviceId, which is the other half of BACKLOG-2987:
    // the claim key embeds the device id, so before the companion learned to
    // re-present its identity at /register this probe would have missed on every
    // re-pair exactly as the old code did. The two halves ship together.
    //
    // ONE QUERY FOR THE BATCH, not one per contact — this runs inside an HTTP
    // handler against ~400 records.
    const claimedRecordIds = findClaimedSourceRecordIds(
      userId,
      "android_sync",
      contacts.map((contact) => this.androidExternalRecordId(deviceId, contact.id)),
    );

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

      // BACKLOG-2987: already promoted on an earlier sync — this exact external
      // record is claimed by a contact we created. Skip before the phone probe,
      // which cannot answer for a contact that has no matchable phone.
      if (claimedRecordIds.has(this.androidExternalRecordId(deviceId, contact.id))) {
        continue;
      }

      // Check if any phone number already exists in the main contacts table
      //
      // =====================================================================
      // BACKLOG-2630 — THIS MUST USE THE SHARED HELPER, NOT A LOCAL RULE
      // =====================================================================
      // `findContactByNormalizedPhone` compares `contact_phones.phone_normalized`,
      // and migration v64 re-keyed that column to the libphonenumber form. This
      // site used to hand-roll the OLD key (`digits.slice(-10)`), so it asked for
      // "4155550188" while the column held "14155550188". Every probe returned
      // null, nothing looked like a duplicate, and per the BACKLOG-2556 note
      // below a re-pairing re-promoted the ENTIRE Android address book as
      // duplicate contacts.
      //
      // `toMatchingKey` rather than `toLookupKey` because this is a MATCHING
      // decision — "is this Android contact already one of ours?" — and it also
      // subsumes the `< 7` floor this loop used to carry by hand: below the
      // floor the helper emits "" and the value is skipped, which is what the
      // old guard did. One rule, one place, no second transcription.
      let alreadyExists = false;
      for (const phone of phones) {
        const normalized = toMatchingKey(phone);
        if (!normalized) continue;

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
          // BACKLOG-2496 — this path wrote NO crosswalk row at all before, so
          // an Android-promoted contact could never say where it came from and
          // was recoverable only by a later content-matching pass.
          //
          // BACKLOG-2556 — AND IT MUST CLAIM THE RECORD, not merely record that
          // it was derived. The earlier `{ kind: "derived" }` said this path
          // "holds no external record id to point at". It does: `storeContacts`,
          // one call frame up, has just written this very contact to
          // `external_contacts` under the id below.
          //
          // A derived origin writes the SYNTHETIC key `origin:<contactId>`,
          // which matches no external record. Once the content-matching
          // fallbacks in `contacts:get-available` are deleted — the founder's
          // "no consolidation, 100% raw list" rule — the crosswalk key is the
          // ONLY thing left that can suppress an already-imported record. So a
          // derived origin here would show every Android-promoted contact
          // TWICE: once as the saved contact, once as its unclaimed record.
          //
          // The id comes from the shared helper, never a second copy of the
          // format. See `androidExternalRecordId`.
          origin: {
            kind: "sourceRecords",
            identities: [
              {
                sourceType: "android_sync",
                sourceRecordId: this.androidExternalRecordId(deviceId, contact.id),
              },
            ],
          },
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
