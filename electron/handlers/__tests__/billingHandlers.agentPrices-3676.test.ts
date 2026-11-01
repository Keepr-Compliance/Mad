/**
 * @jest-environment node
 *
 * BACKLOG-3676 — billing:agent-prices and billing:open-book-call (main).
 *
 * Fixture: the PR-1 route's 200 body (broker-portal/app/api/billing/agent-prices/
 * route.ts): { month: { display: formatPrice(month), unitAmount, currency },
 * bookCallUrl: BOOK_A_CALL_URL } with BOOK_A_CALL_URL copied from
 * broker-portal/lib/billing/bookCall.ts.
 *
 * Wrong implementations this suite catches:
 *   CONST    a price hardcoded in the app (two different server prices pass through).
 *   OPEN     "Book a call" opening a URL the renderer sent, or any host but the booking host.
 *   LEAK     the JWT sent without a session / to a refused origin.
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
import { isBookCallUrl, parseAgentPrices } from "../../services/billingService";

registerBillingHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({} as any, ...args);
}

const TOKEN = "test-access-token";
const USER = "00000000-0000-0000-0000-000000000000";
const PROD_PRICES = "https://app.keeprcompliance.com/api/billing/agent-prices";
const BOOK_A_CALL_URL =
  "https://bookings.cloud.microsoft/book/KeeprBetaProgramOnboarding@bluespaces.com/s/4iH7WsrwY0is7XN7Q5oZ-A2?ismsaljsauthenabled";

function body(display: string, unitAmount: number, bookCallUrl: unknown = BOOK_A_CALL_URL) {
  return { month: { display, unitAmount, currency: "usd" }, bookCallUrl };
}
function response(status: number, b: unknown): any {
  return { status, ok: status >= 200 && status < 300, json: async () => b };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.BROKER_PORTAL_URL;
  mockOpenExternal.mockResolvedValue(undefined);
  mockIsOnline.mockReturnValue(true);
  mockGetAuthSession.mockResolvedValue({ userId: USER, accessToken: TOKEN });
  mockFetch.mockResolvedValue(response(200, body("$19.99", 1999)));
});

describe("billing:agent-prices", () => {
  it.each([
    ["$19.99", 1999],
    ["$24.99", 2499],
  ])("passes the server's price through: %s", async (display, unitAmount) => {
    mockFetch.mockResolvedValue(response(200, body(display, unitAmount)));
    expect(await invoke("billing:agent-prices")).toEqual({
      unavailable: false,
      month: { display, unitAmount, currency: "usd" },
      hasBookCall: true,
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(PROD_PRICES);
    expect(opts.method).toBe("GET");
    expect(opts.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("month null (nothing on sale) is answered as month null", async () => {
    mockFetch.mockResolvedValue(response(200, { month: null, bookCallUrl: BOOK_A_CALL_URL }));
    expect(await invoke("billing:agent-prices")).toEqual({ unavailable: false, month: null, hasBookCall: true });
  });

  it.each([404, 401, 502])("HTTP %i → unavailable", async (status) => {
    mockFetch.mockResolvedValue(response(status, { code: "x" }));
    expect(await invoke("billing:agent-prices")).toEqual({ unavailable: true });
  });

  it("no session → unavailable, no request", async () => {
    mockGetAuthSession.mockResolvedValue(null);
    expect(await invoke("billing:agent-prices")).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("malformed body → unavailable", async () => {
    mockFetch.mockResolvedValue(response(200, { month: { display: 19.99 } }));
    expect(await invoke("billing:agent-prices")).toEqual({ unavailable: true });
  });

  it("the booking URL never reaches the renderer", async () => {
    const r = await invoke("billing:agent-prices");
    expect(JSON.stringify(r)).not.toContain("bookings");
  });
});

describe("billing:open-book-call (S4)", () => {
  it("opens exactly the URL the agent-prices route answered", async () => {
    expect(await invoke("billing:open-book-call")).toEqual({ success: true });
    expect(mockOpenExternal.mock.calls).toEqual([[BOOK_A_CALL_URL]]);
  });

  it("ignores a URL the renderer sends", async () => {
    expect(await invoke("billing:open-book-call", "https://evil.example/")).toEqual({ success: true });
    expect(mockOpenExternal.mock.calls).toEqual([[BOOK_A_CALL_URL]]);
  });

  it.each([
    "https://evil.example/book",
    "http://bookings.cloud.microsoft/book/x",
    "https://bookings.cloud.microsoft.evil.example/book",
    "javascript:alert(1)",
  ])("C-URLGUARD: a server URL off the booking host is never opened: %s", async (url) => {
    mockFetch.mockResolvedValue(response(200, body("$19.99", 1999, url)));
    expect(await invoke("billing:open-book-call")).toEqual({ success: false });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("prices unavailable → nothing opens", async () => {
    mockFetch.mockResolvedValue(response(502, { code: "try_again" }));
    expect(await invoke("billing:open-book-call")).toEqual({ success: false });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("isBookCallUrl", () => {
    expect(isBookCallUrl(BOOK_A_CALL_URL)).toBe(true);
    expect(isBookCallUrl(42)).toBe(false);
  });
  it("parseAgentPrices drops a bad booking URL but keeps the price", () => {
    expect(parseAgentPrices(body("$19.99", 1999, "https://evil.example/"))).toEqual({
      month: { display: "$19.99", unitAmount: 1999, currency: "usd" },
      bookCallUrl: null,
    });
  });
});
