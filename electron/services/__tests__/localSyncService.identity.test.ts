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
 *   3. POST /sync/* — STRICT account gate (BACKLOG-2284). A logged-in desktop
 *      accepts a batch ONLY when the encrypted payload's supabaseUserId equals
 *      the desktop user; an absent identity (legacy build) OR a mismatch is
 *      rejected (403), fail-closed. This claim-based gate is intentionally NOT
 *      a token verify with a timeout like /register — the companion omits the
 *      access token on the hot /sync path, so there is no online verify to time
 *      out; identity was proven once at strict /register.
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
  registerRejectKind,
  syncRejectKind,
  PAIRING_REJECT_BODY,
} from "../localSyncService";
import { encrypt } from "../localSyncEncryption";
import { pairingService } from "../pairingService";
import type { SyncPayload, ContactSyncPayload } from "../../types/localSync";

const DESKTOP_USER = "desktop-user-11111111";
const OTHER_USER = "phone-user-22222222";

/** BACKLOG-2210: shape of a desktop-minted device id (crypto.randomUUID()). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

describe("SESSION-FIX reason-specific pairing 403 body (unit)", () => {
  describe("registerRejectKind() maps a decideRegisterAccount reason → body kind", () => {
    it("a verified account mismatch → account_mismatch (keeps the 'different account' copy)", () => {
      const reason = `verified phone user ${OTHER_USER} != desktop user`;
      expect(registerRejectKind(reason)).toBe("account_mismatch");
      expect(PAIRING_REJECT_BODY[registerRejectKind(reason)]).toContain(
        "different Keepr account"
      );
    });

    it("a could-not-verify reason (revoked / expired / offline / timeout) → session_expired, NOT account mismatch", () => {
      for (const detail of [
        "Auth session missing!", // the exact revoked-session error (the pairing blocker)
        "jwt expired",
        "offline",
        "timeout",
      ]) {
        const reason = `could not verify phone identity: ${detail}`;
        expect(registerRejectKind(reason)).toBe("session_expired");
        const body = PAIRING_REJECT_BODY[registerRejectKind(reason)];
        expect(body).toContain("session has expired");
        expect(body).not.toContain("different Keepr account");
      }
    });

    it("no access token ('identity verification required') → identity_missing", () => {
      expect(registerRejectKind("identity verification required")).toBe(
        "identity_missing"
      );
    });

    it("an unforeseen reason falls back to identity_missing (never mislabels as a wrong account)", () => {
      expect(registerRejectKind("some brand new reason")).toBe("identity_missing");
      expect(
        PAIRING_REJECT_BODY[registerRejectKind("some brand new reason")]
      ).not.toContain("different Keepr account");
    });
  });

  describe("syncRejectKind() maps a /sync reject → body kind", () => {
    it("a claim present but ≠ desktop user → account_mismatch", () => {
      expect(syncRejectKind(OTHER_USER, DESKTOP_USER)).toBe("account_mismatch");
    });

    it("an absent claim → identity_missing (no session_expired on /sync — it never verifies a session)", () => {
      expect(syncRejectKind(undefined, DESKTOP_USER)).toBe("identity_missing");
    });

    it("tolerates a logged-out desktop user id (null)", () => {
      // Defensive: the 403 path is only reached when the desktop IS logged in,
      // but the helper must still type-check and behave with a null desktop id.
      expect(syncRejectKind(OTHER_USER, null)).toBe("account_mismatch");
      expect(syncRejectKind(undefined, null)).toBe("identity_missing");
    });
  });

  it("the three reject bodies are all distinct (so a client can tell them apart)", () => {
    const bodies = Object.values(PAIRING_REJECT_BODY);
    expect(new Set(bodies).size).toBe(bodies.length);
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
    // BACKLOG-2210: the desktop mints the identity — the name-derived claim
    // "dev-B" is NOT persisted; the device is stored under the minted UUID that
    // the response returns for the phone to adopt.
    const assignedId = JSON.parse(res.body).deviceId as string;
    expect(assignedId).toMatch(UUID_RE);
    expect(assignedId).not.toBe("dev-B");
    const device = pairingService.getStatus().devices.find((d) => d.deviceId === assignedId);
    expect(device).toBeDefined();
    expect(device?.verifiedUserId).toBe(DESKTOP_USER);
    // The un-minted claim must never become an identity.
    expect(pairingService.getStatus().devices.some((d) => d.deviceId === "dev-B")).toBe(false);
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

  // --- SESSION-FIX: the 403 BODY now reflects the actual reject reason. The
  // DECISION (403 + not-persisted) is unchanged — these assert the body only. ---

  it("SESSION-FIX: a verified account mismatch 403 body says 'different account' (decision unchanged)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: OTHER_USER } }, error: null });

    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-mismatch-body",
      deviceName: "Wrong Account Phone",
      supabaseUserId: OTHER_USER,
      supabaseAccessToken: "phone-token",
    });

    expect(res.status).toBe(403); // regression: decision unchanged
    expect(JSON.parse(res.body).error).toContain("different Keepr account");
  });

  it("SESSION-FIX: a REVOKED phone session ('Auth session missing!') 403 body says the session expired — NOT 'different account'", async () => {
    // The exact companion-pairing blocker: the broker's global signOut revoked
    // the phone's session, so Supabase getUser() rejects the phone's token.
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { message: "Auth session missing!" },
    });

    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-revoked",
      deviceName: "Revoked Session Phone",
      // Claim MATCHES the desktop user — this is genuinely the SAME account, so
      // mislabeling it as a "different account" was the bug. Strict still rejects
      // (fail-closed) because the token could not be verified, but the message
      // must now say the session expired.
      supabaseUserId: DESKTOP_USER,
      supabaseAccessToken: "stale-token",
    });

    expect(res.status).toBe(403); // regression: still fail-closed
    const body = JSON.parse(res.body).error as string;
    expect(body).toContain("session has expired");
    expect(body).not.toContain("different Keepr account");
    // Regression: the security decision (do not persist) is unchanged.
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-revoked")
    ).toBe(false);
  });

  it("SESSION-FIX: a legacy phone with no identity gets the identity-missing 403 body (not 'different account')", async () => {
    const res = await post(address, port, "/register", authToken, {
      deviceId: "dev-legacy-body",
      deviceName: "Old Build Phone",
    });

    expect(res.status).toBe(403); // regression: decision unchanged
    const body = JSON.parse(res.body).error as string;
    expect(body).toContain("verifiable Keepr identity");
    expect(body).not.toContain("different Keepr account");
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
    // BACKLOG-2210: stored under the minted UUID, not the name-derived claim.
    const assignedId = JSON.parse(res.body).deviceId as string;
    expect(assignedId).toMatch(UUID_RE);
    const device = pairingService.getStatus().devices.find((d) => d.deviceId === assignedId);
    expect(device).toBeDefined();
    expect(device?.verifiedUserId).toBeUndefined();
    // No desktop user → verification is skipped entirely.
    expect(mockGetUser).not.toHaveBeenCalled();
    // BACKLOG-2208: /register advertises the contactDiff capability so a new
    // companion knows it may send incremental diffs to this desktop.
    expect(JSON.parse(res.body).capabilities).toEqual({ contactDiff: true });
  });
});

describe("BACKLOG-2210 /register — desktop-minted device UUID (collision fix)", () => {
  let address: string;
  let port: number;
  let authToken: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingService.disconnectAll();
    // Logged-out desktop so registration is allowed without an account-match
    // token — this suite isolates the identity-MINTING behavior (BACKLOG-2210),
    // orthogonal to the BACKLOG-2224 account gate exercised above.
    const bound = await localSyncService.startServer(0, SECRET_B64);
    address = bound.address;
    port = bound.port;
    authToken = deriveTransportKeys(SECRET_B64).authToken;
  });

  afterEach(async () => {
    await localSyncService.stopServer();
    pairingService.disconnectAll();
  });

  it("mints a UUID for a name-derived claim and returns it for the phone to adopt", async () => {
    const res = await post(address, port, "/register", authToken, {
      deviceId: "MacBook Pro", // legacy name-derived id (deviceId = deviceName)
      deviceName: "MacBook Pro",
    });

    expect(res.status).toBe(200);
    const assignedId = JSON.parse(res.body).deviceId as string;
    expect(assignedId).toMatch(UUID_RE);
    expect(assignedId).not.toBe("MacBook Pro");
    // Persisted under the minted id, never the human name.
    const devices = pairingService.getStatus().devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe(assignedId);
    expect(devices.some((d) => d.deviceId === "MacBook Pro")).toBe(false);
  });

  it("gives two phones with the SAME name DISTINCT ids (the core collision fix)", async () => {
    const resA = await post(address, port, "/register", authToken, {
      deviceId: "MacBook Pro",
      deviceName: "MacBook Pro",
    });
    const resB = await post(address, port, "/register", authToken, {
      deviceId: "MacBook Pro",
      deviceName: "MacBook Pro",
    });

    const idA = JSON.parse(resA.body).deviceId as string;
    const idB = JSON.parse(resB.body).deviceId as string;
    expect(idA).toMatch(UUID_RE);
    expect(idB).toMatch(UUID_RE);
    // Same NAME, but two independent identities — they can no longer overwrite
    // each other's paired-device entry / sync namespace.
    expect(idA).not.toBe(idB);
    const ids = pairingService.getStatus().devices.map((d) => d.deviceId).sort();
    expect(ids).toEqual([idA, idB].sort());
  });

  it("REUSES an already-minted UUID a phone sends back (idempotent re-register)", async () => {
    // First register mints an id.
    const res1 = await post(address, port, "/register", authToken, {
      deviceId: "MacBook Pro",
      deviceName: "MacBook Pro",
    });
    const minted = JSON.parse(res1.body).deviceId as string;

    // Simulate a desktop restart clearing the in-memory paired-device map — the
    // phone re-registers carrying the UUID it already adopted.
    pairingService.disconnectAll();
    const res2 = await post(address, port, "/register", authToken, {
      deviceId: minted, // phone sends its adopted UUID
      deviceName: "MacBook Pro",
    });

    expect(JSON.parse(res2.body).deviceId).toBe(minted); // reused, not re-minted
    const devices = pairingService.getStatus().devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe(minted);
  });
});

describe("BACKLOG-2284 /sync/* strict account gate (integration, desktop logged in)", () => {
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

  // ---- /sync/messages -----------------------------------------------------

  it("ALLOWS (200) a same-account batch (supabaseUserId === desktop) — normal sync is unbroken", async () => {
    // This is exactly what a legitimately-paired same-account phone presents:
    // its own Supabase user id (a CLAIM), which matches the desktop's. Strict
    // must still let it through.
    const payload: SyncPayload = {
      deviceId: "dev-match",
      messages: [],
      syncTimestamp: Date.now(),
      supabaseUserId: DESKTOP_USER,
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/messages", authToken, encrypted);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    // Decision-path evidence: the batch was ACCEPTED (device registered), and no
    // account/identity rejection was logged.
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-match")
    ).toBe(true);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Sync rejected"),
      expect.anything()
    );
  });

  it("REJECTS (403) a batch that carries NO identity (the BACKLOG-2284 flip — was allow+log)", async () => {
    // Legacy phone build: no supabaseUserId in the payload. The old SOFT path
    // allowed + logged this; strict fails closed.
    const payload: SyncPayload = {
      deviceId: "dev-legacy-sync",
      messages: [],
      syncTimestamp: Date.now(),
      // supabaseUserId intentionally omitted
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/messages", authToken, encrypted);

    expect(res.status).toBe(403);
    // Decision-path assertion: rejected specifically for a missing identity.
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("no phone identity"),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "sync_no_identity_rejected" }),
      })
    );
    // Fail-closed: the batch must NOT have been accepted / device registered.
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-legacy-sync")
    ).toBe(false);
  });

  it("REJECTS (403) a batch whose supabaseUserId differs from the desktop (account mismatch)", async () => {
    const payload: SyncPayload = {
      deviceId: "dev-sync",
      messages: [],
      syncTimestamp: Date.now(),
      supabaseUserId: OTHER_USER,
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/messages", authToken, encrypted);

    expect(res.status).toBe(403);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("account mismatch"),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "sync_account_mismatch" }),
      })
    );
    // SESSION-FIX: a genuine mismatch keeps the 'different account' body.
    expect(JSON.parse(res.body).error).toContain("different Keepr account");
    expect(
      pairingService.getStatus().devices.some((d) => d.deviceId === "dev-sync")
    ).toBe(false);
  });

  it("SESSION-FIX: a /sync batch with NO identity gets the identity-missing 403 body (not 'different account')", async () => {
    const payload: SyncPayload = {
      deviceId: "dev-sync-noid-body",
      messages: [],
      syncTimestamp: Date.now(),
      // supabaseUserId intentionally omitted
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/messages", authToken, encrypted);

    expect(res.status).toBe(403); // regression: decision unchanged
    const body = JSON.parse(res.body).error as string;
    expect(body).toContain("verifiable Keepr identity");
    expect(body).not.toContain("different Keepr account");
  });

  // ---- /sync/contacts (same strict gate) ----------------------------------

  it("ALLOWS (200) a same-account contact batch", async () => {
    const payload: ContactSyncPayload = {
      deviceId: "dev-contacts-match",
      contacts: [],
      syncTimestamp: Date.now(),
      supabaseUserId: DESKTOP_USER,
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/contacts", authToken, encrypted);

    expect(res.status).toBe(200);
  });

  it("REJECTS (403) a contact batch that carries NO identity (strict flip on the contacts endpoint)", async () => {
    const payload: ContactSyncPayload = {
      deviceId: "dev-contacts-legacy",
      contacts: [],
      syncTimestamp: Date.now(),
      // supabaseUserId intentionally omitted
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/contacts", authToken, encrypted);

    expect(res.status).toBe(403);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining("no phone identity"),
      expect.objectContaining({
        tags: expect.objectContaining({
          reason: "sync_no_identity_rejected",
          endpoint: "contacts",
        }),
      })
    );
  });
});

describe("BACKLOG-2284 /sync/messages — desktop logged OUT (no enforcement)", () => {
  let address: string;
  let port: number;
  let authToken: string;
  let encryptionKey: Buffer;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingService.disconnectAll();
    // No userId → nothing is stored to enforce against; the strict gate carves
    // this out (mirrors decideRegisterAccount's logged-out allow).
    const bound = await localSyncService.startServer(0, SECRET_B64);
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

  it("ALLOWS (200) a batch with NO identity when the desktop has no logged-in user", async () => {
    const payload: SyncPayload = {
      deviceId: "dev-loggedout-sync",
      messages: [],
      syncTimestamp: Date.now(),
    };
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);

    const res = await post(address, port, "/sync/messages", authToken, encrypted);

    expect(res.status).toBe(200);
  });
});
