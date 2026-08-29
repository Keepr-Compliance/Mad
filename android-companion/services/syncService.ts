/**
 * Sync Service (Android Companion)
 * HTTP client for sending encrypted SMS messages and contacts
 * to the Electron desktop app.
 *
 * TASK-1429: Android Companion — Encrypted HTTP Transport
 * BACKLOG-1449: Android contacts sync
 */

import * as Sentry from "@sentry/react-native";
import { encrypt } from "./encryption";
import { deriveTransportKeys } from "./keyDerivation";
import { getSession } from "./authService";
import { setContactDiffSupported } from "./contactSyncState";
import { isPrivateLanIPv4 } from "./lanAddress";
import type {
  SyncMessage,
  SyncPayload,
  SyncResult,
  SyncErrorType,
  PairingInfo,
  ContactSyncPayload,
} from "../types/sync";
import type { SyncContact } from "../types/contacts";

/**
 * BACKLOG-2224: read the phone's Supabase identity from the current session.
 *
 * Returns the user id (embedded in sync payloads as the soft backstop) and the
 * access token (sent at /register for authoritative desktop-side verification).
 * Never throws — a missing/unreadable session yields empty fields so pairing on
 * legacy desktops (which ignore these) still works.
 */
async function getPhoneIdentity(): Promise<{
  supabaseUserId?: string;
  supabaseAccessToken?: string;
}> {
  try {
    const session = await getSession();
    return {
      supabaseUserId: session?.user?.id,
      supabaseAccessToken: session?.access_token,
    };
  } catch {
    return {};
  }
}

/**
 * Classify a network error into a specific SyncErrorType.
 *
 * BACKLOG-1496: Distinguish network errors so the UI can show
 * targeted guidance instead of a generic "Desktop not reachable" message.
 *
 * Classification logic:
 * - AbortError → timeout (request exceeded REQUEST_TIMEOUT_MS)
 * - "Network request failed" / ECONNREFUSED → connection_refused (desktop not running)
 * - Any other Error → unknown
 */
function classifySyncError(err: Error): SyncErrorType {
  // BACKLOG-2956: a LAN-guard refusal is not a transport failure. It must never
  // be classified as connection_refused/timeout, which would tell the user to
  // check their Wi-Fi for a problem Wi-Fi cannot fix.
  if (isLanAddressRefusal(err)) {
    return "invalid_address";
  }

  if (err.name === "AbortError") {
    return "timeout";
  }

  const msg = err.message.toLowerCase();

  // Connection refused — desktop app is not running or port is blocked
  if (
    msg.includes("econnrefused") ||
    msg.includes("connection refused") ||
    msg.includes("network request failed")
  ) {
    return "connection_refused";
  }

  // Connection reset / broken pipe — connected but transfer failed
  if (
    msg.includes("econnreset") ||
    msg.includes("broken pipe") ||
    msg.includes("epipe") ||
    msg.includes("socket hang up") ||
    msg.includes("network error")
  ) {
    return "network_after_connect";
  }

  return "unknown";
}

/** Map a SyncErrorType to a user-facing error message */
function userMessageForErrorType(errorType: SyncErrorType): string {
  switch (errorType) {
    case "connection_refused":
      return "Desktop app is not running. Open Keepr on your computer and try again.";
    case "timeout":
      return "Connection timed out. Your network may limit device-to-device transfers.";
    case "network_after_connect":
      return "Connected to desktop but unable to sync data. Try a different WiFi network or use your phone's hotspot.";
    case "server_error":
      return "Desktop received the request but returned an error.";
    case "invalid_address":
      // BACKLOG-2956: say what is actually wrong and what fixes it. Offering the
      // reachability copy here would send the user to check a network that is
      // working fine (the BACKLOG-2913 defect class).
      return "This pairing is no longer valid — it points at a computer that isn't on your local network. Pair with your computer again from the home screen.";
    case "unknown":
    default:
      return "Could not reach the desktop app. Make sure both devices are on the same network.";
  }
}

/** HTTP request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10_000;

/** Ping timeout — shorter since it's a health check */
const PING_TIMEOUT_MS = 5_000;

/**
 * Thrown when a request would go to an address outside the permitted private
 * LAN ranges. Carries the offending host so the log and Sentry breadcrumb name
 * it. Distinguished by a marker property rather than `instanceof`, which is
 * unreliable for Error subclasses under Hermes/Babel down-levelling.
 */
class LanAddressRefusedError extends Error {
  readonly isLanAddressRefusal = true;

  constructor(readonly host: string) {
    super(`Refused non-LAN destination: ${host}`);
    this.name = "LanAddressRefusedError";
  }
}

function isLanAddressRefusal(err: unknown): err is LanAddressRefusedError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isLanAddressRefusal?: boolean }).isLanAddressRefusal === true
  );
}

/**
 * Extract the host from one of this module's request URLs.
 *
 * Every URL here is built by this file as `http://<host>:<port>/<path>`, so a
 * strict regex is both sufficient and safer than `new URL()`, whose availability
 * and parsing behaviour under Hermes is not something a security guard should
 * depend on. Anything that does not match returns null and is REFUSED — an
 * unparseable destination is never assumed safe.
 */
function hostFromRequestUrl(url: string): string | null {
  const match = /^http:\/\/([^:/?#]+):\d+(?:[/?#]|$)/.exec(url);
  return match ? match[1] : null;
}

/**
 * Perform a fetch request with a timeout.
 * AbortController is used to cancel the request if it exceeds the timeout.
 *
 * BACKLOG-2956 — LAN ENFORCEMENT CHOKE POINT.
 *
 * The LAN address check previously ran only in the two QR-scan handlers
 * (`app/onboarding/pair-device.tsx` and `app/(main)/home.tsx`). That left two
 * real holes: a pairing saved by a build that predates the check survives an app
 * upgrade completely unchecked, and BACKGROUND sync never passes through a scan
 * handler at all, so it was permanently unguarded.
 *
 * This matters because the app ships a blanket `usesCleartextTraffic="true"`
 * (Android's network-security-config has no CIDR syntax, so "cleartext to the
 * LAN only" cannot be expressed at the OS layer). The LAN check is the only
 * thing bounding what that flag opens up; a stored pairing pointing at a public
 * host would send message and contact payloads over plain HTTP to the internet.
 *
 * Enforcing here — rather than at the four call sites — means every outbound
 * request is checked however its address was obtained, and a fifth call site
 * added later is covered the day it is written. `sendMessages`, `sendContacts`,
 * `registerDevice` and `pingDesktop` all funnel through this function.
 *
 * The refusal happens BEFORE the AbortController and before `fetch` — no request
 * is issued, not even a connection attempt.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const host = hostFromRequestUrl(url);
  if (host === null || !isPrivateLanIPv4(host)) {
    const shown = host ?? "an unrecognised address";
    console.warn(
      `[syncService] Refused request to ${shown}: not a private LAN address. ` +
        "The stored pairing is no longer valid; the user must pair again."
    );
    Sentry.captureMessage("Refused non-LAN sync destination", {
      level: "warning",
      // Host only — never the URL, which carries no PII but also no value here.
      tags: { component: "syncService", lan_guard: "refused" },
    });
    throw new LanAddressRefusedError(shown);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Send a batch of messages to the desktop Electron app.
 *
 * Encrypts the payload using the shared secret from QR pairing,
 * then POSTs the encrypted envelope to the desktop's sync server.
 *
 * @param messages - Array of SMS messages to sync
 * @param pairingInfo - Connection details from QR pairing (TASK-1428)
 * @returns SyncResult indicating success/failure and message count
 */
export async function sendMessages(
  messages: SyncMessage[],
  pairingInfo: PairingInfo
): Promise<SyncResult> {
  const { ip, port, secret, deviceId } = pairingInfo;

  // Derive separate auth token and encryption key from the shared secret.
  // The auth token is sent as Bearer header; the encryption key is used
  // for AES-256-GCM. They are cryptographically independent so capturing
  // the bearer token on the wire does not reveal the encryption key.
  const { authToken, encryptionKey } = await deriveTransportKeys(secret);

  // BACKLOG-2224: attach the phone's Supabase user id so the desktop can reject
  // batches from a different account (soft backstop). Optional — legacy desktops
  // ignore it; when absent the desktop allows + logs an "unverified legacy sync".
  const { supabaseUserId } = await getPhoneIdentity();

  // Build the plaintext sync payload
  const payload: SyncPayload = {
    deviceId,
    messages,
    syncTimestamp: Date.now(),
    ...(supabaseUserId ? { supabaseUserId } : {}),
  };

  // Encrypt the payload using the derived encryption key
  const encryptedPayload = await encrypt(JSON.stringify(payload), encryptionKey);

  const url = `http://${ip}:${port}/sync/messages`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(encryptedPayload),
      },
      REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      Sentry.addBreadcrumb({
        category: "sync",
        message: `sendMessages failed: ${response.status}`,
        level: "error",
        data: { status: response.status, messageCount: messages.length },
      });
      return {
        success: false,
        error: `Server responded with ${response.status}: ${errorBody}`,
        errorType: "server_error",
      };
    }

    const result = (await response.json()) as SyncResult;
    Sentry.addBreadcrumb({
      category: "sync",
      message: "sendMessages succeeded",
      level: "info",
      data: { messageCount: messages.length },
    });
    return result;
  } catch (err) {
    if (err instanceof Error) {
      const errorType = classifySyncError(err);
      Sentry.captureException(err, {
        tags: { component: "syncService", operation: "sendMessages", errorType },
      });
      return {
        success: false,
        error: userMessageForErrorType(errorType),
        errorType,
      };
    }
    return { success: false, error: "Unknown error", errorType: "unknown" };
  }
}

/**
 * Send a batch of contacts to the desktop Electron app.
 *
 * Encrypts the payload using the shared secret from QR pairing,
 * then POSTs the encrypted envelope to the desktop's contact sync endpoint.
 *
 * BACKLOG-1449: Android contacts sync
 *
 * @param contacts - Array of contacts to sync (the full set on a full sync, only
 *   new/changed on an incremental diff — BACKLOG-2208)
 * @param pairingInfo - Connection details from QR pairing (TASK-1428)
 * @param isFullSync - BACKLOG-2208: whether `contacts` is a FULL snapshot of the
 *   address book. Sent to the desktop so it only stale-deletes on a full
 *   snapshot, never on a partial diff. When omitted the field is left off the
 *   wire and the desktop treats the batch as full (legacy behavior).
 * @returns SyncResult indicating success/failure
 */
export async function sendContacts(
  contacts: SyncContact[],
  pairingInfo: PairingInfo,
  isFullSync?: boolean
): Promise<SyncResult> {
  const { ip, port, secret, deviceId } = pairingInfo;

  const { authToken, encryptionKey } = await deriveTransportKeys(secret);

  // BACKLOG-2224: attach the phone's Supabase user id (soft backstop). See
  // sendMessages for rationale.
  const { supabaseUserId } = await getPhoneIdentity();

  const payload: ContactSyncPayload = {
    deviceId,
    contacts,
    syncTimestamp: Date.now(),
    ...(supabaseUserId ? { supabaseUserId } : {}),
    ...(isFullSync !== undefined ? { isFullSync } : {}),
  };

  const encryptedPayload = await encrypt(JSON.stringify(payload), encryptionKey);

  const url = `http://${ip}:${port}/sync/contacts`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(encryptedPayload),
      },
      REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      Sentry.addBreadcrumb({
        category: "sync",
        message: `sendContacts failed: ${response.status}`,
        level: "error",
        data: { status: response.status, contactCount: contacts.length },
      });
      return {
        success: false,
        error: `Server responded with ${response.status}: ${errorBody}`,
        errorType: "server_error",
      };
    }

    const result = (await response.json()) as SyncResult;
    Sentry.addBreadcrumb({
      category: "sync",
      message: "sendContacts succeeded",
      level: "info",
      data: { contactCount: contacts.length },
    });
    return result;
  } catch (err) {
    if (err instanceof Error) {
      const errorType = classifySyncError(err);
      Sentry.captureException(err, {
        tags: { component: "syncService", operation: "sendContacts", errorType },
      });
      return {
        success: false,
        error: userMessageForErrorType(errorType),
        errorType,
      };
    }
    return { success: false, error: "Unknown error", errorType: "unknown" };
  }
}

/**
 * Register this device with the desktop app immediately after QR pairing.
 *
 * Sends an authenticated POST /register to notify the desktop that the phone
 * has scanned the QR code and is paired. This causes the desktop onboarding
 * QR screen to transition to "Connected" without waiting for the first sync.
 *
 * BACKLOG-1456: Phone auto-pings on pair + auto-first-sync
 * WARNING: This logic must be preserved if the pairing screen is rewritten (BACKLOG-1463).
 *
 * BACKLOG-2210: the desktop MINTS the device identity and returns it as
 * `deviceId`. The caller adopts that id (persists it into the stored pairing)
 * so all later sync payloads use the desktop-minted UUID instead of the
 * name-derived id — this is what stops two same-named phones colliding on one
 * deviceId. The returned `deviceId` is surfaced on the result for the caller.
 *
 * @param pairingInfo - Connection details from QR pairing
 * @returns SyncResult plus the desktop-assigned `deviceId` (when the desktop is
 *   new enough to mint one) and its advertised `capabilities`.
 */
export async function registerDevice(
  pairingInfo: PairingInfo
): Promise<
  SyncResult & {
    deviceId?: string;
    capabilities?: { contactDiff?: boolean };
    /**
     * BACKLOG-2212: HTTP status of a non-ok desktop response. Surfaced so the
     * caller can distinguish an authoritative account-rejection (403) from a
     * transport/reachability failure and show the correct message. Absent on
     * success and on network-level failures (which carry `errorType` instead).
     */
    status?: number;
  }
> {
  const { ip, port, secret, deviceId } = pairingInfo;

  const { authToken } = await deriveTransportKeys(secret);

  // BACKLOG-2224: send the phone's Supabase identity so the desktop can
  // authoritatively verify (via getUser(accessToken)) that this phone belongs
  // to the same account before accepting the pairing. Optional — legacy
  // desktops ignore these fields; when absent the desktop allows + logs.
  const { supabaseUserId, supabaseAccessToken } = await getPhoneIdentity();

  const url = `http://${ip}:${port}/register`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          deviceId,
          deviceName: deviceId,
          ...(supabaseUserId ? { supabaseUserId } : {}),
          ...(supabaseAccessToken ? { supabaseAccessToken } : {}),
        }),
      },
      PING_TIMEOUT_MS
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      Sentry.addBreadcrumb({
        category: "sync",
        message: `registerDevice failed: ${response.status}`,
        level: "error",
        data: { status: response.status },
      });
      return {
        success: false,
        error: `Server responded with ${response.status}: ${errorBody}`,
        errorType: "server_error",
        // BACKLOG-2212: surface the status so the pairing UI can tell a 403
        // account-rejection apart from a generic server error.
        status: response.status,
      };
    }

    const result = (await response.json()) as SyncResult & {
      deviceId?: string;
      capabilities?: { contactDiff?: boolean };
    };

    // BACKLOG-2208: record whether THIS desktop supports incremental contact
    // diffs. An old desktop omits `capabilities`, so this persists `false` and
    // the companion keeps sending the FULL address book — it only opts into
    // diffs against a desktop that explicitly advertised support. Re-read on
    // every (re-)pair; cleared on unpair via resetContactSyncState.
    await setContactDiffSupported(result.capabilities?.contactDiff === true);

    Sentry.addBreadcrumb({
      category: "sync",
      message: "registerDevice succeeded",
      level: "info",
    });
    return result;
  } catch (err) {
    if (err instanceof Error) {
      const errorType = classifySyncError(err);
      Sentry.captureException(err, {
        tags: { component: "syncService", operation: "registerDevice", errorType },
      });
      return {
        success: false,
        error: userMessageForErrorType(errorType),
        errorType,
      };
    }
    return { success: false, error: "Unknown error", errorType: "unknown" };
  }
}

/**
 * Ping the desktop app to check if it's reachable and the sync server is running.
 *
 * @param pairingInfo - Connection details from QR pairing
 * @returns true if the desktop responds to the health check
 */
export async function pingDesktop(pairingInfo: PairingInfo): Promise<boolean> {
  const { ip, port } = pairingInfo;
  const url = `http://${ip}:${port}/ping`;

  try {
    const response = await fetchWithTimeout(
      url,
      { method: "GET" },
      PING_TIMEOUT_MS
    );

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}
