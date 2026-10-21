/**
 * @jest-environment node
 *
 * BACKLOG-3863 PR-2 slice 2 — the three billing channels.
 *
 *   billing:open-portal   opens portalUrl("billing") only; takes no argument.
 *   billing:plan-summary  GET {allowed origin}/api/billing/plan-summary with the
 *                         Bearer JWT, 5 s bound; anything but a valid 200 is
 *                         { unavailable: true }.
 *   billing:refresh       drops the 60 s entitlement memo and the feature-gate
 *                         cache, then answers a fresh summary.
 *
 * Wrong implementations this suite is here to catch:
 *   OPEN     the channel opening a URL or path the renderer sent.
 *   LEAK     the JWT sent to a BROKER_PORTAL_URL outside the allow-list.
 *   HANG     no timeout: a portal that never answers leaves Settings waiting.
 *   ERROR    a 404 (billing off) surfaced as an error instead of "unavailable".
 *   STALE    refresh not dropping the memo, so the export path keeps the old
 *            answer for up to 60 s after a subscription changes.
 *
 * DTO fixture: transcribed from slice 1's route test
 * (broker-portal/__tests__/plan-summary-3863/planSummaryRoute.test.ts, "returns
 * the caller's plan"), period end from the p0a Stripe fixture
 * ev-2d-sub.updated-active.json current_period_end 1794336475.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const registeredHandlers = new Map<string, any>();
const mockOpenExternal = jest.fn();
const mockFetch = jest.fn();
const mockIsOnline = jest.fn();
const mockGetAuthSession = jest.fn();
const mockFeatureInvalidate = jest.fn();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  shell: { openExternal: (...args: unknown[]) => mockOpenExternal(...args) },
  net: {
    fetch: (...args: unknown[]) => mockFetch(...args),
    isOnline: () => mockIsOnline(),
  },
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthSession: (...a: unknown[]) => mockGetAuthSession(...a),
    getActiveOrganizationMembershipOutcome: jest.fn(),
    getClient: jest.fn(),
  },
}));

jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: { invalidateCache: () => mockFeatureInvalidate() },
}));

import { registerBillingHandlers } from "../billingHandlers";
import entitlementService from "../../services/entitlementService";
import {
  BILLING_PORTAL_OPEN_FAILED_ERROR,
  BILLING_PORTAL_URL_REFUSED_ERROR,
  PLAN_SUMMARY_TIMEOUT_MS,
} from "../../services/billingService";
import supabaseService from "../../services/supabaseService";

registerBillingHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({} as any, ...args);
}

const TOKEN = "test-access-token";
const USER = "00000000-0000-0000-0000-000000000000";
const PROD_BILLING = "https://app.keeprcompliance.com/dashboard/billing";
const PROD_SUMMARY = "https://app.keeprcompliance.com/api/billing/plan-summary";

const ACTIVE_DTO = {
  state: "active",
  interval: "month",
  current_period_end: "2026-11-10T18:47:55+00:00",
  cancel_at_period_end: false,
  paymentIncomplete: false,
  supportGrantEffective: false,
};

function response(status: number, body: unknown): any {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const ORIGINAL_PORTAL = process.env.BROKER_PORTAL_URL;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.BROKER_PORTAL_URL;
  mockOpenExternal.mockResolvedValue(undefined);
  mockIsOnline.mockReturnValue(true);
  mockGetAuthSession.mockResolvedValue({ userId: USER, accessToken: TOKEN });
  mockFetch.mockResolvedValue(response(200, ACTIVE_DTO));
  entitlementService.invalidateMemo();
});

afterAll(() => {
  if (ORIGINAL_PORTAL === undefined) delete process.env.BROKER_PORTAL_URL;
  else process.env.BROKER_PORTAL_URL = ORIGINAL_PORTAL;
});

describe("BACKLOG-3863 — billing:open-portal", () => {
  it("opens exactly the production Billing page by default", async () => {
    expect(await invoke("billing:open-portal")).toEqual({ success: true });
    expect(mockOpenExternal.mock.calls).toEqual([[PROD_BILLING]]);
  });

  it("ignores any URL or path the renderer sends", async () => {
    expect(await invoke("billing:open-portal", "https://evil.example/")).toEqual({ success: true });
    expect(await invoke("billing:open-portal", "checklists")).toEqual({ success: true });
    expect(await invoke("billing:open-portal", { url: "file:///etc/passwd", path: "/x" })).toEqual({
      success: true,
    });
    expect(mockOpenExternal.mock.calls).toEqual([[PROD_BILLING], [PROD_BILLING], [PROD_BILLING]]);
  });

  it("uses the dev portal from BROKER_PORTAL_URL, origin only", async () => {
    process.env.BROKER_PORTAL_URL = "http://localhost:3001/some/path?x=1#y";
    expect(await invoke("billing:open-portal")).toEqual({ success: true });
    expect(mockOpenExternal.mock.calls).toEqual([["http://localhost:3001/dashboard/billing"]]);
  });

  it.each([
    "https://evil.example",
    "https://keepr-portal.vercel.app",
    "https://app.keeprcompliance.com.evil.example",
    "http://app.keeprcompliance.com",
    "https://user:pw@app.keeprcompliance.com",
    "javascript:alert(1)",
    "not a url",
  ])("refuses a portal address outside the allowed origins: %s", async (configured) => {
    process.env.BROKER_PORTAL_URL = configured;
    expect(await invoke("billing:open-portal")).toEqual({
      success: false,
      error: BILLING_PORTAL_URL_REFUSED_ERROR,
    });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("the browser failing to open answers with the allowed portal address, not success", async () => {
    mockOpenExternal.mockRejectedValueOnce(new Error("no handler"));
    expect(await invoke("billing:open-portal")).toEqual({
      success: false,
      error: BILLING_PORTAL_OPEN_FAILED_ERROR,
      portalAddress: "https://app.keeprcompliance.com",
    });
  });
});

describe("BACKLOG-3863 — billing:plan-summary", () => {
  it("reads the caller's summary with the Bearer token and returns exactly the DTO", async () => {
    mockFetch.mockResolvedValueOnce(
      response(200, { ...ACTIVE_DTO, stripe_customer_id: "cus_x", mode: "live" }),
    );
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: false, summary: ACTIVE_DTO });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(PROD_SUMMARY);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(init.method).toBe("GET");
    // No mode and no user id are sent: nothing but the token.
    expect(init.body).toBeUndefined();
  });

  it.each([
    ["404 (billing off on this portal)", 404],
    ["401 (session not accepted)", 401],
    ["503 (portal could not read)", 503],
    ["500", 500],
  ])("%s → unavailable", async (_label, status) => {
    mockFetch.mockResolvedValueOnce(response(status, { error: "x" }));
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
  });

  it("a network failure → unavailable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
  });

  it("offline → unavailable without a request", async () => {
    mockIsOnline.mockReturnValue(false);
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("no session → unavailable without a request", async () => {
    mockGetAuthSession.mockResolvedValueOnce(null);
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown state", { ...ACTIVE_DTO, state: "trialing" }],
    ["missing boolean", { ...ACTIVE_DTO, paymentIncomplete: undefined }],
    ["date as number", { ...ACTIVE_DTO, current_period_end: 1794336475 }],
    ["array", [ACTIVE_DTO]],
    ["null", null],
  ])("a malformed body (%s) → unavailable", async (_label, body) => {
    mockFetch.mockResolvedValueOnce(response(200, body));
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
  });

  it("the token never goes to a portal address outside the allow-list", async () => {
    process.env.BROKER_PORTAL_URL = "https://evil.example";
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
    process.env.BROKER_PORTAL_URL = "https://keepr-portal.vercel.app";
    expect(await invoke("billing:plan-summary")).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it(`a portal that never answers → unavailable after ${PLAN_SUMMARY_TIMEOUT_MS} ms, and the request is aborted`, async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      mockFetch.mockImplementationOnce((_url: string, init: any) => {
        signal = init.signal;
        return new Promise(() => {}); // never settles
      });
      const SENTINEL = { sentinel: "still pending" };
      const answer = invoke("billing:plan-summary");
      // Let the session lookup and fetch call happen before the clock moves.
      await jest.advanceTimersByTimeAsync(PLAN_SUMMARY_TIMEOUT_MS - 1);
      const early = await Promise.race([answer, Promise.resolve(SENTINEL)]);
      expect(early).toBe(SENTINEL);
      await jest.advanceTimersByTimeAsync(1);
      const settled = await Promise.race([answer, Promise.resolve(SENTINEL)]);
      expect(settled).toEqual({ unavailable: true });
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("BACKLOG-3863 — billing:refresh", () => {
  /** Prime the 60 s memo with an "entitled" answer through the real export path. */
  async function primeMemoEntitled(rpc: jest.Mock): Promise<void> {
    (supabaseService.getActiveOrganizationMembershipOutcome as jest.Mock).mockResolvedValue({
      status: "member",
      organization_id: "00000000-0000-0000-0000-000000000000",
    });
    rpc.mockResolvedValue({
      data: { features: { unlimited_transactions: { enabled: true } } },
      error: null,
    });
    (supabaseService.getClient as jest.Mock).mockReturnValue({ rpc });
  }

  /** The export path's memoized read (useMemo = true). */
  function exportPathRead(): Promise<string> {
    return (entitlementService as any).readLiveUnlimitedEntitlement(USER, true);
  }

  it("drops the entitlement memo: the next export-path read asks get_org_features again", async () => {
    const rpc = jest.fn();
    await primeMemoEntitled(rpc);
    expect(await exportPathRead()).toBe("entitled");
    expect(await exportPathRead()).toBe("entitled");
    expect(rpc).toHaveBeenCalledTimes(1); // second read came from the memo

    await invoke("billing:refresh");
    expect(await exportPathRead()).toBe("entitled");
    expect(rpc).toHaveBeenCalledTimes(2); // memo was dropped
  });

  it("drops the feature-gate cache and answers a fresh summary", async () => {
    expect(await invoke("billing:refresh")).toEqual({ unavailable: false, summary: ACTIVE_DTO });
    expect(mockFeatureInvalidate).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("billing off still drops the caches and answers unavailable", async () => {
    mockFetch.mockResolvedValueOnce(response(404, { error: "not found" }));
    expect(await invoke("billing:refresh")).toEqual({ unavailable: true });
    expect(mockFeatureInvalidate).toHaveBeenCalledTimes(1);
  });
});
