/**
 * @jest-environment node
 *
 * Unit tests for paymentService (BACKLOG-2015, main process).
 *
 * Mocks electron (net/shell), supabaseService, and entitlementService — NO live
 * Stripe/portal round-trip (Stage-2 live test deferred to BACKLOG-2017). Proves:
 *   - authed portal calls (exact URL + Bearer JWT + body),
 *   - the SCA / decline / 409 outcome mapping,
 *   - the FAIL-CLOSED confirm (unlocked ONLY when the gate re-read says unlocked;
 *     a portal 200 + still-locked gate → NOT unlocked),
 *   - deep-link session sanitization,
 *   - offline short-circuit.
 */

import { jest } from "@jest/globals";

const mockFetch = jest.fn();
const mockOpenExternal = jest.fn();
const mockIsOnline = jest.fn();

jest.mock("electron", () => ({
  net: {
    fetch: (...args: unknown[]) => mockFetch(...args),
    isOnline: () => mockIsOnline(),
  },
  shell: {
    openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  },
}));

const mockGetAuthSession = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetClient = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthSession: (...a: unknown[]) => mockGetAuthSession(...a),
    trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
    getClient: (...a: unknown[]) => mockGetClient(...a),
  },
}));

const mockGetUnlockStatus = jest.fn();
jest.mock("../entitlementService", () => ({
  __esModule: true,
  default: {
    getUnlockStatus: (...a: unknown[]) => mockGetUnlockStatus(...a),
  },
}));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks are registered.
import paymentService, { sanitizeSessionId } from "../paymentService";

const TX = "tx-main";
const JWT = "jwt-abc";

function okJson(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function statusJson(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOnline.mockReturnValue(true);
  mockGetAuthSession.mockResolvedValue({ userId: "u1", accessToken: JWT });
  process.env.BROKER_PORTAL_URL = "https://portal.example.com";
});

describe("beginCheckout (Flow A)", () => {
  it("posts to the EXACT checkout-session URL with Bearer JWT + tx body, opens the URL", async () => {
    mockFetch.mockResolvedValue(okJson({ checkout_url: "https://checkout.stripe.com/x" }));
    const result = await paymentService.beginCheckout(TX);

    expect(result).toEqual({ started: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://portal.example.com/api/payments/checkout-session");
    expect(opts.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(JSON.parse(opts.body)).toEqual({ local_transaction_id: TX });
    expect(mockOpenExternal).toHaveBeenCalledWith("https://checkout.stripe.com/x");
    // Funnel event fired.
    expect(mockTrackEvent).toHaveBeenCalledWith("u1", "unlock-clicked", { transaction_id: TX });
  });

  it("offline → no fetch, returns offline", async () => {
    mockIsOnline.mockReturnValue(false);
    const result = await paymentService.beginCheckout(TX);
    expect(result).toEqual({ started: false, error: "offline" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("401 → unauthenticated", async () => {
    mockFetch.mockResolvedValue(statusJson(401, { error: "unauthorized" }));
    const result = await paymentService.beginCheckout(TX);
    expect(result).toEqual({ started: false, error: "unauthenticated" });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});

describe("chargeSavedCard (Flow B) — outcome mapping", () => {
  it("succeeded", async () => {
    mockFetch.mockResolvedValue(okJson({ succeeded: true, payment_intent_id: "pi_1" }));
    expect(await paymentService.chargeSavedCard(TX)).toEqual({ outcome: "succeeded" });
  });

  it("requires_action WITH url → opens it externally", async () => {
    mockFetch.mockResolvedValue(
      okJson({ requires_action: true, redirect_url: "https://hooks.stripe.com/3ds" }),
    );
    const r = await paymentService.chargeSavedCard(TX);
    expect(r.outcome).toBe("requires_action");
    expect(r.redirectUrl).toBe("https://hooks.stripe.com/3ds");
    expect(mockOpenExternal).toHaveBeenCalledWith("https://hooks.stripe.com/3ds");
  });

  it("requires_action with NULL url → no openExternal, redirectUrl null (caller falls back)", async () => {
    mockFetch.mockResolvedValue(okJson({ requires_action: true, redirect_url: null }));
    const r = await paymentService.chargeSavedCard(TX);
    expect(r).toEqual({ outcome: "requires_action", redirectUrl: null });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("402 → declined with code", async () => {
    mockFetch.mockResolvedValue(statusJson(402, { declined: true, code: "card_declined", message: "no" }));
    expect(await paymentService.chargeSavedCard(TX)).toMatchObject({ outcome: "declined", code: "card_declined" });
  });

  it("409 → no_saved_card", async () => {
    mockFetch.mockResolvedValue(statusJson(409, { error: "no_saved_payment_method" }));
    expect(await paymentService.chargeSavedCard(TX)).toEqual({ outcome: "no_saved_card" });
  });
});

describe("confirm — FAIL-CLOSED (gate re-read is the only authority)", () => {
  it("unlocked ONLY when the gate re-read says unlocked", async () => {
    mockFetch.mockResolvedValue(okJson({ status: "fulfilled", unlocked: true }));
    mockGetUnlockStatus.mockResolvedValue({ status: "unlocked", fromCache: false });
    const r = await paymentService.confirm(TX, "cs_test_1");
    expect(r).toEqual({ unlocked: true });
    // /status was poked with the sanitized session id + Bearer JWT.
    const statusCall = (mockFetch.mock.calls as [string, { headers: Record<string, string> }][]).find(
      ([u]) => u.includes("/api/payments/status"),
    );
    expect(statusCall?.[0]).toContain("session=cs_test_1");
    expect(statusCall?.[1].headers.Authorization).toBe(`Bearer ${JWT}`);
  });

  it("portal says unlocked but the gate re-read is STILL LOCKED → NOT unlocked (fail-closed)", async () => {
    mockFetch.mockResolvedValue(okJson({ status: "fulfilled", unlocked: true }));
    mockGetUnlockStatus.mockResolvedValue({ status: "locked", fromCache: false, lockReason: "no_unlock" });
    // Speed up the bounded poll: it will exhaust attempts and time out.
    jest.useFakeTimers();
    const p = paymentService.confirm(TX, "cs_test_1");
    await jest.runAllTimersAsync();
    const r = await p;
    jest.useRealTimers();
    expect(r).toEqual({ unlocked: false, reason: "timeout" });
  });

  it("offline → not unlocked, no fetch", async () => {
    mockIsOnline.mockReturnValue(false);
    const r = await paymentService.confirm(TX, "cs_test_1");
    expect(r).toEqual({ unlocked: false, reason: "offline" });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("sanitizeSessionId — untrusted deep-link input", () => {
  it("accepts a Stripe-shaped id", () => {
    expect(sanitizeSessionId("cs_test_a1B2c3")).toBe("cs_test_a1B2c3");
  });
  it("rejects empty, over-long, and non-charset input", () => {
    expect(sanitizeSessionId("")).toBeNull();
    expect(sanitizeSessionId("a".repeat(200))).toBeNull();
    expect(sanitizeSessionId("cs_../../etc")).toBeNull();
    expect(sanitizeSessionId("cs test")).toBeNull();
    expect(sanitizeSessionId(null)).toBeNull();
    expect(sanitizeSessionId(undefined)).toBeNull();
  });
});

describe("hasSavedCard — RLS-scoped own-row read", () => {
  it("true when default_payment_method_id is present", async () => {
    const maybeSingle = jest.fn<() => Promise<{ data: { default_payment_method_id: string } | null; error: null }>>()
      .mockResolvedValue({ data: { default_payment_method_id: "pm_1" }, error: null });
    mockGetClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });
    expect(await paymentService.hasSavedCard()).toEqual({ hasSavedCard: true });
  });

  it("false when no row", async () => {
    const maybeSingle = jest.fn<() => Promise<{ data: null; error: null }>>()
      .mockResolvedValue({ data: null, error: null });
    mockGetClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });
    expect(await paymentService.hasSavedCard()).toEqual({ hasSavedCard: false });
  });
});
