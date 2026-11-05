/**
 * @jest-environment node
 *
 * BACKLOG-3951 — card payments for a brokerage member with no license.
 *
 * C3a payment:begin-checkout    unassigned ⇒ refused, nothing reaches the portal
 * C3b payment:charge-saved-card unassigned ⇒ refused, nothing reaches the portal
 *     (each guard independent: removing one reds only its own case)
 * R1  a standing read that never answers ⇒ the payment proceeds after the bound
 *     (the portal routes make the same check and fail closed)
 * R2  a standing read that errors ⇒ proceeds; deactivated / solo ⇒ proceeds
 * 403 mapping: the portal's `{ error: "no_license" }` (checkout-session and
 *     charge use `error`, not `code`) ⇒ not_licensed; any other 403 unchanged.
 *
 * Real modules: paymentHandlers, paymentService, membershipStanding. Mocked:
 * electron (ipcMain, net.fetch, shell), supabaseService, entitlementService.
 * Membership rows: the transcribed keepr-test row (helpers/membership3951Fixtures).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { UNASSIGNED_MEMBER_ROW } from "../../services/__tests__/helpers/membership3951Fixtures";
import { personalMembership } from "../../services/__tests__/helpers/postgrestEmulator";

const registeredHandlers = new Map<string, any>();
const mockFetch = jest.fn();
const mockOpenExternal = jest.fn();
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  net: {
    fetch: (...args: unknown[]) => mockFetch(...args),
    isOnline: () => true,
  },
  shell: { openExternal: (...args: unknown[]) => mockOpenExternal(...args) },
}));

const USER = "user-3951";
const mockStandingRows = jest.fn();
const mockAuthUserId = jest.fn();
const mockTrackEvent = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getAuthUserId: () => mockAuthUserId(),
    getAuthSession: async () => ({ userId: USER, accessToken: "jwt-3951" }),
    getMembershipStandingRows: (u: string) => mockStandingRows(u),
    trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
    getClient: () => ({}),
  },
}));
jest.mock("../../services/entitlementService", () => ({
  __esModule: true,
  default: { getUnlockStatus: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { registerPaymentHandlers } from "../paymentHandlers";

registerPaymentHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({} as any, ...args);
}

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const TX = "tx-3951";
const unassigned = { ...UNASSIGNED_MEMBER_ROW, user_id: USER };
const suspended = { ...unassigned, license_status: "suspended" };
const rows = (r: unknown[]) => mockStandingRows.mockResolvedValue({ status: "rows", rows: r });
const portalCalls = () => mockFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BROKER_PORTAL_URL = "https://portal.example.com";
  mockAuthUserId.mockReturnValue(USER);
  rows([]);
  mockFetch.mockImplementation(async (url: string) =>
    url.endsWith("/checkout-session")
      ? res(200, { checkout_url: "https://checkout.stripe.com/c/pay/x" })
      : res(200, { succeeded: true }),
  );
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3951 C3: card payments refused for an unassigned member", () => {
  it("C3a begin-checkout: not_licensed; nothing reaches the portal or the browser", async () => {
    rows([unassigned]);
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: false, error: "not_licensed" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockStandingRows).toHaveBeenCalledWith(USER);
  });

  it("C3b charge-saved-card: not_licensed; nothing reaches the portal", async () => {
    rows([unassigned]);
    expect(await invoke("payment:charge-saved-card", TX)).toEqual({ outcome: "not_licensed" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStandingRows).toHaveBeenCalledWith(USER);
  });

  it.each([
    ["deactivated member (suspended)", () => [suspended]],
    ["deactivated member with own personal row", () => [suspended, personalMembership({ userId: USER })]],
    ["solo user", () => [personalMembership({ userId: USER })]],
    ["active brokerage member", () => [{ ...unassigned, license_status: "active" }]],
  ])("%s ⇒ both card paths reach the portal", async (_n, r) => {
    rows(r());
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: true });
    expect(await invoke("payment:charge-saved-card", TX)).toEqual({ outcome: "succeeded" });
    expect(portalCalls()).toEqual([
      "https://portal.example.com/api/payments/checkout-session",
      "https://portal.example.com/api/payments/charge",
    ]);
  });

  it("R2 standing read errors ⇒ proceeds (the portal decides)", async () => {
    mockStandingRows.mockResolvedValue({ status: "error" });
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: true });
    mockStandingRows.mockRejectedValue(new Error("boom"));
    expect(await invoke("payment:charge-saved-card", TX)).toEqual({ outcome: "succeeded" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("no signed-in user id ⇒ no standing read; paymentService answers as before", async () => {
    mockAuthUserId.mockReturnValue(null);
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: true });
    expect(mockStandingRows).not.toHaveBeenCalled();
  });

  it.each([
    ["payment:begin-checkout", { started: true }],
    ["payment:charge-saved-card", { outcome: "succeeded" }],
  ])("R1 %s: a standing read that never answers ⇒ proceeds after 5 s", async (channel, expected) => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    mockStandingRows.mockReturnValue(new Promise(() => {}));
    let settled: unknown = "pending";
    void invoke(channel, TX).then((r) => {
      settled = r;
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe("pending");
    expect(mockFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toEqual(expected);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("BACKLOG-3951: the portal's no_license refusal (old-UI race) maps to not_licensed", () => {
  it("checkout-session 403 {error:'no_license'} ⇒ not_licensed; browser not opened", async () => {
    mockFetch.mockResolvedValue(res(403, { error: "no_license" }));
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: false, error: "not_licensed" });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("charge 403 {error:'no_license'} ⇒ not_licensed", async () => {
    mockFetch.mockResolvedValue(res(403, { error: "no_license" }));
    expect(await invoke("payment:charge-saved-card", TX)).toEqual({ outcome: "not_licensed" });
  });

  it("any other 403 is unchanged (checkout no_quote, charge error)", async () => {
    mockFetch.mockResolvedValue(res(403, { error: "purchases_blocked" }));
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: false, error: "no_quote" });
    expect(await invoke("payment:charge-saved-card", TX)).toEqual({ outcome: "error" });
  });

  it("the subscription route's key (code) is not read here", async () => {
    mockFetch.mockResolvedValue(res(403, { code: "no_license" }));
    expect(await invoke("payment:begin-checkout", TX)).toEqual({ started: false, error: "no_quote" });
  });
});
