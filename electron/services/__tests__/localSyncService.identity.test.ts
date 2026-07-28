/**
 * BACKLOG-2224 — Account-match verification for WiFi pairing.
 *
 * Proves the desktop-authoritative half of the cross-account data-leak fix:
 *   1. verifyPhoneIdentity() — unit tests over a mocked Supabase getUser(),
 *      including the bounded-timeout fail-closed path.
 *   2. POST /register — STRICT, fail-closed account-match. The ONLY allow path
 *      (desktop logged in) is a Supabase-verified access token whose user id
 *      equals the desktop's. Everything else — verified_mismatch, unverified
 *      (expired/offline/timeout), missing token (legacy / claim-only) — is
 *      rejected (403) and no device is persisted. A logged-out desktop allows.
 *   3. POST /sync/messages — SOFT backstop: reject on an EXPLICIT account
 *      mismatch inside the encrypted payload (unchanged — see BACKLOG-2284).
 *
 * The integration tests spin up the real localSyncService HTTP server on an
 * OS-assigned port and hit it with Node's http client.
 */

import http from "http";

// --- Control the Supabase getUser() result used by verifyPhoneIdentity ---
const mockGetUser = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ auth: { getUser: mockGetUser } }),
  },
}));

import * as Sentry from "@sentry/electron/main";
import localSyncService, {
  verifyPhoneIdentity,
  deriveTransportKeys,
} from "../localSyncService";
import { encrypt } from "../localSyncEncryption";
import { pairingService } from "../pairingService";
import type { SyncPayload } from "../../types/localSync";

const DESKTOP_USER = "desktop-user-11111111";
const OTHER_USER = "phone-user-22222222";

// A 32-byte base64 secret (deriveTransportKeys requires >= 16 decoded bytes).
const SECRET_B64 = Buffer.alloc(32, 7).toString("base64");

interface HttpResponse {
  status: number;
  body: string;
}

/** Minimal POST helper over Node http (avoids relying on global fetch under jsdom). */
function post(
  address: string,
  port: number,
  path: string,
  bearer: string,
  jsonBody: unknown
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(jsonBody);
    const req = http.request(
      {
        host: address,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("BACKLOG-2224 verifyPhoneIdentity()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns verified_match when the token's user id equals the desktop user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: DESKTOP_USER } }, error: null });
    const result = await verifyPhoneIdentity("tok", DESKTOP_USER);
    expect(result).toEqual({ status: "verified_match" });
    expect(mockGetUser).toHaveBeenCalledWith("tok");
  });

  it("returns verified_mismatch when the token belongs to a different user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: OTHER_USER } }, error: null });
    const result = await verifyPhoneIdentity("tok", DESKTOP_USER);
    expect(result).toEqual({ status: "verified_mismatch", actualUserId: OTHER_USER });
  });

  it("returns unverified when Supabase returns an error (e.g. expired token)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "jwt expired" } });
    const result = await verifyPhoneIdentity("tok", DESKTOP_USER);
    expect(result).toEqual({ status: "unverified", reason: "jwt expired" });
  });

  it("returns unverified (never throws) when getUser rejects (offline)", async () => {
    mockGetUser.mockRejectedValue(new Error("network down"));
    const result = await verifyPhoneIdentity("tok", DESKTOP_USER);
    expect(result).toEqual({ status: "unverified", reason: "network down" });
  });

  it("returns unverified (reason 'timeout') when getUser hangs past the deadline", async () => {
    jest.useFakeTimers();
    try {
      // getUser never resolves → the bounded race must win and fail closed.
      mockGetUser.mockReturnValue(new Promise<never>(() => {}));
      const pending = verifyPhoneIdentity("tok", DESKTOP_USER);
      await jest.advanceTimersByTimeAsync(4000);
      await expect(pending).resolves.toEqual({ status: "unverified", reason: "timeout" });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("BACKLOG-2224 /register account-match (integration, desktop logged in)", () => {
  let address: string;
  let port: number;
  let authToken: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingService.disconnectAll();
    const bound = await localSyncService.startServer(0, SECRET_B64, DESKTOP_USER);
    address = bound.address;
    port = bound.port;
    authToken = deriveTransportKeys(SECRET_B64).authToken;
  });

  afterEach(async () => {
    await localSyncService.stopServer();
    pairingService.disconnectAll();
  });

  it("rejects (403) a phone whose verified account differs, and does NOT persist the device", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: OTHER_USER } }, error: null });

    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-A",
      deviceName: "Wrong Account Phone",
      supabaseUserId: OTHER_USER,
      supabaseAccessToken: "phone-token",
    });

    expect(res.status).toBe(403);
    expect(pairingService.getStatus().devices.some((d) => d.deviceId === "dev-A")).toBe(false);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("verified account mismatch"),
      expect.objectContaining({ level: "warning" })
    );
  });

  it("accepts (200) a phone whose verified account matches and records verifiedUserId", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: DESKTOP_USER } }, error: null });

    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-B",
      deviceName: "Right Account Phone",
      supabaseUserId: DESKTOP_USER,
      supabaseAccessToken: "phone-token",
    });

    expect(res.status).toBe(200);
    const device = pairingService.getStatus().devices.find((d) => d.deviceId === "dev-B");
    expect(device).toBeDefined();
    expect(device?.verifiedUserId).toBe(DESKTOP_USER);
  });

  it("rejects (403) when online verification fails (unverified) EVEN IF the claimed id matches, and does NOT persist", async () => {
    // Offline / verify-fail: the old soft path allowed this because the claimed
    // id matched. Strict contract fails closed regardless of the claim.
    mockGetUser.mockRejectedValue(new Error("offline"));

    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-unverified",
      deviceName: "Offline Phone (matching claim)",
      supabaseUserId: DESKTOP_USER, // claim MATCHES desktop — still rejected.
      supabaseAccessToken: "phone-token",
    });

    expect(res.status).toBe(403);
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-unverified")
    ).toBe(false);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("could not verify phone identity"),
      expect.objectContaining({ level: "warning" })
    );
  });

  it("rejects (403) a legacy phone that sends NO identity (no access token), and does NOT persist", async () => {
    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-legacy",
      deviceName: "Old Build Phone",
    });

    expect(res.status).toBe(403);
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-legacy")
    ).toBe(false);
    // No token → we never even reach the Supabase verify call.
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects (403) a claim-only phone (supabaseUserId but no access token), and does NOT persist", async () => {
    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-claim-only",
      deviceName: "Claim Only Phone",
      supabaseUserId: DESKTOP_USER, // claim without a verifiable token → reject.
    });

    expect(res.status).toBe(403);
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-claim-only")
    ).toBe(false);
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-2224 /register — desktop logged OUT (no enforcement)", () => {
  let address: string;
  let port: number;
  let authToken: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingService.disconnectAll();
    // Start the server with NO userId → nothing gets stored to enforce against.
    const bound = await localSyncService.startServer(0, SECRET_B64);
    address = bound.address;
    port = bound.port;
    authToken = deriveTransportKeys(SECRET_B64).authToken;
  });

  afterEach(async () => {
    await localSyncService.stopServer();
    pairingService.disconnectAll();
  });

  it("allows (200) and persists the device when the desktop has no logged-in user", async () => {
    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-loggedout",
      deviceName: "Any Phone",
    });

    expect(res.status).toBe(200);
    const device = pairingService.getStatus().devices.find((d) => d.deviceId === "dev-loggedout");
    expect(device).toBeDefined();
    expect(device?.verifiedUserId).toBeUndefined();
    // No desktop user → verification is skipped entirely.
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-2224 /sync/messages soft backstop (integration)", () => {
  let address: string;
  let port: number;
  let authToken: string;
  let encryptionKey: Buffer;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingService.disconnectAll();
    const bound = await localSyncService.startServer(0, SECRET_B64, DESKTOP_USER);
    address = bound.address;
    port = bound.port;
    const derived = deriveTransportKeys(SECRET_B64);
    authToken = derived.authToken;
    encryptionKey = derived.encryptionKey;
  });

  afterEach(async () => {
    await localSyncService.stopServer();
    pairingService.disconnectAll();
  });

  it("rejects (403) an encrypted batch whose supabaseUserId differs from the desktop", async () => {
    const payload: SyncPayload = {
      deviceId: "dev-sync",
      messages: [],
      syncTimestamp: Date.now(),
      supabaseUserId: OTHER_USER,
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/messages", authToken, encrypted);

    expect(res.status).toBe(403);
  });
});
