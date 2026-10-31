/**
 * @jest-environment node
 */

/**
 * BACKLOG-3676 — the Agent plan Subscribe path in main (paymentService).
 *
 * C1 (SR plan approval): C-CONFIRM-FRESH, C-TRYAGAIN-FRESH and C-CONFIRM-SINGLE
 * run against the REAL confirmSubscription / refreshGate with the REAL
 * entitlementService (60 s memo included), not a stub loop. The poll's sleep is
 * replaced by a no-op through confirmSubscription's options (the IPC handler
 * never passes options).
 *
 * Harness and fixtures copied from entitlementService.unlimited-3675.test.ts:
 *   - get_org_features (public.get_org_features, read 2026-10-03):
 *       {org_id, plan_name, plan_tier, features:{<key>:{enabled, value,
 *        value_type, name, source}}}
 *   - membership: supabaseService.getActiveOrganizationMembershipOutcome
 *       {status:"member", organization_id, organization_name, is_personal}
 * Route answers (PR-1, broker-portal/app/api/payments/subscription-session/route.ts):
 *   200 { checkout_url } | 4xx/5xx { code }.
 * Synthetic ids only.
 */

import { generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

// ── Mocks ────────────────────────────────────────────────────────────────
const mockIsOnline = jest.fn(() => true);
const mockUserData = { dir: "" };
const mockFetch = jest.fn();
const mockOpenExternal = jest.fn();
jest.mock("electron", () => ({
  net: { isOnline: () => mockIsOnline(), fetch: (...a: unknown[]) => mockFetch(...a) },
  app: { getPath: () => mockUserData.dir },
  shell: { openExternal: (...a: unknown[]) => mockOpenExternal(...a) },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../logService", () => {
  const fns = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: fns, logService: fns };
});

const mockKeyMap: Record<string, string> = {};
jest.mock("../../constants/offlinePassKeys", () => ({
  get OFFLINE_PASS_PUBLIC_KEYS() {
    return mockKeyMap;
  },
}));

const mockMaybeSingle = jest.fn();
const mockFrom = jest.fn(() => {
  const qb: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit"]) qb[m] = jest.fn(() => qb);
  qb.maybeSingle = mockMaybeSingle;
  return qb;
});
const mockRpc = jest.fn();
const mockInvoke = jest.fn();
const mockGetSession = jest.fn();
const mockGetAuthSession = jest.fn();
const mockMembership = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: mockFrom,
      rpc: mockRpc,
      auth: { getSession: mockGetSession },
      functions: { invoke: mockInvoke },
    }),
    getAuthSession: () => mockGetAuthSession(),
    trackEvent: jest.fn(),
    getActiveOrganizationMembershipOutcome: (u: string) => mockMembership(u),
  },
}));

const cacheStore = new Map<string, true>();
const mockUpsert = jest.fn();
jest.mock("../db/unlockCacheDbService", () => ({
  getCachedUnlock: async (tx: string, u: string) => (cacheStore.has(`${tx}::${u}`) ? { tx } : null),
  upsertUnlock: async (p: { localTransactionId: string; userId: string }) => {
    mockUpsert(p);
    cacheStore.set(`${p.localTransactionId}::${p.userId}`, true);
  },
  removeCachedUnlock: async (tx: string, u: string) => {
    cacheStore.delete(`${tx}::${u}`);
  },
}));

// paymentService clears the feature cache alongside the memo (readGateFresh).
const mockFeatureInvalidate = jest.fn();
jest.mock("../featureGateService", () => ({
  __esModule: true,
  default: { invalidateCache: () => mockFeatureInvalidate() },
}));

// ── Test key + token helpers ─────────────────────────────────────────────
const { publicKey: K1_PUB } = generateKeyPairSync("ed25519");
const K1_SPKI = K1_PUB.export({ format: "der", type: "spki" }).toString("base64");

const USER_A = "user-a-3675";
const ORG_A = "org-a-3675";
const TX = "tx-3675-1";

function orgFeatures(enabled: unknown, extra: Record<string, unknown> = {}) {
  return {
    org_id: ORG_A,
    plan_name: "Individual",
    plan_tier: "individual",
    features: {
      transaction_checklists: { enabled: true, value: "true", value_type: "boolean", name: "Transaction checklists", source: "override" },
      unlimited_transactions: { enabled, value: "false", value_type: "boolean", name: "Unlimited transactions", source: enabled === true ? "override" : "plan" },
      ...extra,
    },
  };
}
const MEMBER = { status: "member", organization_id: ORG_A, organization_name: "Personal", is_personal: true };

type Service = typeof import("../entitlementService").default;
type Payment = typeof import("../paymentService").default;
let service: Service;
let payment: Payment;
let paymentModule: typeof import("../paymentService");

const rpcNames = () => mockRpc.mock.calls.map((c) => c[0]);
const orgFeatureCalls = () => rpcNames().filter((n) => n === "get_org_features").length;

function notEntitledLive() {
  mockMembership.mockResolvedValue(MEMBER);
  mockRpc.mockImplementation(async (name: string) =>
    name === "get_org_features" ? { data: orgFeatures(false), error: null } : { data: { ok: true }, error: null },
  );
}
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  cacheStore.clear();
  for (const k of Object.keys(mockKeyMap)) delete mockKeyMap[k];
  mockKeyMap.k1 = K1_SPKI;
  mockUserData.dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3675-svc-"));
  mockIsOnline.mockReturnValue(true);
  mockGetAuthSession.mockResolvedValue({ userId: USER_A });
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: USER_A } } } });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null }); // no unlock row
  mockInvoke.mockResolvedValue({ data: { pass: null, reason: "not_entitled" }, error: null });
  notEntitledLive();

  // Fresh module graph per test (memo state), with a fake OS secret store.
  const provider = require("../../capabilities/secretStoreProvider");
  provider.installSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`ENC1:${Buffer.from(s).toString("base64")}`),
    decryptString: (b: Buffer) => {
      const t = b.toString();
      if (!t.startsWith("ENC1:")) throw new Error("not ciphertext");
      return Buffer.from(t.slice(5), "base64").toString();
    },
  });
  // Same module graph for both, so paymentService reads THIS entitlement memo.
  service = require("../entitlementService").default;
  paymentModule = require("../paymentService");
  payment = paymentModule.default;
  mockGetAuthSession.mockResolvedValue({ userId: USER_A, accessToken: "jwt-3676" });
  process.env.BROKER_PORTAL_URL = "https://portal.example.com";
});

const flush = () => new Promise((r) => setImmediate(r));

afterEach(async () => {
  for (let i = 0; i < 20; i += 1) await flush();
  try {
    rmSync(mockUserData.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Each test has its own mkdtemp dir.
  }
});

const ATTEMPTS = 15; // paymentService CONFIRM_POLL_ATTEMPTS
const noSleep = { sleep: async () => undefined };

/** get_org_features answers not entitled for the first k reads, entitled from read k+1. */
function flipAfter(k: number): void {
  let n = 0;
  mockMembership.mockResolvedValue(MEMBER);
  mockRpc.mockImplementation(async (name: string) => {
    if (name !== "get_org_features") return { data: { ok: true }, error: null };
    n += 1;
    return { data: orgFeatures(n > k), error: null };
  });
}

describe("C-CONFIRM-FRESH — every poll attempt is a fresh server read (R1)", () => {
  it.each([0, 1, 3, 13])("server flips to entitled after %i reads → unlocked on the next read", async (k) => {
    flipAfter(k);
    const r = await payment.confirmSubscription(TX, noSleep);
    expect(r).toEqual({ unlocked: true });
    expect(orgFeatureCalls()).toBe(k + 1);
  });

  it("positive control: never entitled → exactly 15 server reads, then timeout (not unlocked)", async () => {
    flipAfter(999);
    const r = await payment.confirmSubscription(TX, noSleep);
    expect(r).toEqual({ unlocked: false, reason: "timeout" });
    expect(orgFeatureCalls()).toBe(ATTEMPTS);
    expect(mockFeatureInvalidate).toHaveBeenCalledTimes(ATTEMPTS);
  });

  it("a memoized 'not entitled' from the paywall open does not survive into the poll", async () => {
    flipAfter(1);
    expect((await service.getUnlockStatus(TX)).status).toBe("locked"); // memoizes the 'no'
    const r = await payment.confirmSubscription(TX, noSleep);
    expect(r).toEqual({ unlocked: true });
    expect(orgFeatureCalls()).toBe(2);
  });

  it("offline → not unlocked, no read", async () => {
    flipAfter(0);
    mockIsOnline.mockReturnValue(false);
    expect(await payment.confirmSubscription(TX, noSleep)).toEqual({ unlocked: false, reason: "offline" });
    expect(orgFeatureCalls()).toBe(0);
  });
});

describe("C-TRYAGAIN-FRESH — 'Try again' is one fresh read (R6)", () => {
  it("memo holds not entitled (<60 s), server now entitled → refreshGate unlocks", async () => {
    flipAfter(1);
    expect((await service.getUnlockStatus(TX)).status).toBe("locked");
    expect(await payment.refreshGate(TX)).toEqual({ unlocked: true });
    expect(orgFeatureCalls()).toBe(2);
  });

  it("still not entitled → { unlocked: false }", async () => {
    flipAfter(999);
    expect(await payment.refreshGate(TX)).toEqual({ unlocked: false });
  });
});

describe("C-CONFIRM-SINGLE — two concurrent confirms share one poll (S2)", () => {
  it("deep link fired twice: k = 3 → exactly 4 server reads", async () => {
    flipAfter(3);
    const [a, b] = await Promise.all([
      payment.confirmSubscription(TX, noSleep),
      payment.confirmSubscription(TX, noSleep),
    ]);
    expect(a).toEqual({ unlocked: true });
    expect(b).toEqual({ unlocked: true });
    expect(orgFeatureCalls()).toBe(4);
  });

  it("after the first finishes, a later confirm runs a new poll", async () => {
    flipAfter(0);
    await payment.confirmSubscription(TX, noSleep);
    await payment.confirmSubscription(TX, noSleep);
    expect(orgFeatureCalls()).toBe(2);
  });
});

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("beginSubscription — Stripe hosted Checkout through the portal route", () => {
  const ROUTE = "https://portal.example.com/api/payments/subscription-session";

  it("POSTs to the route with the Bearer JWT and no body, then opens the Stripe URL", async () => {
    mockFetch.mockResolvedValue(res(200, { checkout_url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    expect(await payment.beginSubscription()).toEqual({ started: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(ROUTE);
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ Authorization: "Bearer jwt-3676" });
    expect(opts.body).toBeUndefined();
    expect(mockOpenExternal.mock.calls).toEqual([["https://checkout.stripe.com/c/pay/cs_test_1"]]);
  });

  it.each([
    "https://keeprcompliance.com/dashboard/billing",
    "http://checkout.stripe.com/c/pay/x",
    "https://checkout.stripe.com.evil.example/x",
    "keepr://payment-callback",
    42,
  ])("C-URLGUARD: a checkout_url off checkout.stripe.com is never opened: %p", async (checkoutUrl) => {
    mockFetch.mockResolvedValue(res(200, { checkout_url: checkoutUrl }));
    expect(await payment.beginSubscription()).toEqual({ started: false, code: "try_again" });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthorized"],
    [404, "not_available"],
    [403, "brokerage_managed"],
    [403, "no_license"],
    [403, "suspended"],
    [403, "mode_refused"],
    [409, "already_have_plan"],
    [503, "price_unavailable"],
    [503, "try_again"],
    [502, "try_again"],
  ])("HTTP %i { code: %s } → that code, nothing opened", async (status, code) => {
    mockFetch.mockResolvedValue(res(status, { code }));
    expect(await payment.beginSubscription()).toEqual({ started: false, code });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("an unknown code reads as try_again; a bare 401 as unauthorized", async () => {
    mockFetch.mockResolvedValueOnce(res(500, { code: "something_new" }));
    expect(await payment.beginSubscription()).toEqual({ started: false, code: "try_again" });
    mockFetch.mockResolvedValueOnce(res(401, null));
    expect(await payment.beginSubscription()).toEqual({ started: false, code: "unauthorized" });
  });

  it("offline → no request", async () => {
    mockIsOnline.mockReturnValue(false);
    expect(await payment.beginSubscription()).toEqual({ started: false, code: "offline" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("no session → unauthorized, no request", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    expect(await payment.beginSubscription()).toEqual({ started: false, code: "unauthorized" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("S2: a double click while the first is in flight makes ONE request and opens ONE tab", async () => {
    let release: ((v: unknown) => void) | undefined;
    mockFetch.mockReturnValue(new Promise((r) => (release = r)));
    const a = payment.beginSubscription();
    const b = payment.beginSubscription();
    release?.(res(200, { checkout_url: "https://checkout.stripe.com/c/pay/cs_test_2" }));
    expect(await a).toEqual({ started: true });
    expect(await b).toEqual({ started: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
  });

  it("isStripeCheckoutUrl / toRefusalCode", () => {
    expect(paymentModule.isStripeCheckoutUrl("https://checkout.stripe.com/x")).toBe(true);
    expect(paymentModule.isStripeCheckoutUrl("https://evil.example/")).toBe(false);
    expect(paymentModule.toRefusalCode({ code: "suspended" }, 403)).toBe("suspended");
    expect(paymentModule.toRefusalCode("nope", 418)).toBe("try_again");
  });
});
