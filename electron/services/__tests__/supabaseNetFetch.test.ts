/**
 * @jest-environment node
 */

/**
 * BACKLOG-3768: the main-process Supabase fetch wrapper.
 *
 * Controls (SR ruling f3d7522a): W1 rewrap, W2 init overrides, W3 whenReady,
 * C4 no silent Node fallback inside Electron, W4 error identity, W5 throttle.
 *
 * "Inside Electron" is simulated by defining process.versions.electron, which
 * is exactly what the wrapper reads.
 */

import * as Sentry from "@sentry/electron/main";
import { createClient } from "@supabase/supabase-js";

const mockNetFetch = jest.fn();
const mockIsReady = jest.fn(() => true);
const mockWhenReady = jest.fn(() => Promise.resolve());
const mockNet: { fetch?: (...a: unknown[]) => unknown } = {
  fetch: (...a: unknown[]) => mockNetFetch(...a),
};
jest.mock("electron", () => ({
  app: {
    isReady: () => mockIsReady(),
    whenReady: () => mockWhenReady(),
  },
  get net() {
    return mockNet;
  },
}));

const mockLogWarn = jest.fn(() => Promise.resolve());
jest.mock("../logService", () => ({
  __esModule: true,
  default: { warn: (...a: unknown[]) => mockLogWarn(...(a as [])), info: jest.fn(), error: jest.fn() },
}));

import {
  REPORT_THROTTLE_MS,
  __resetSupabaseNetFetchThrottle,
  supabaseNetFetch,
} from "../supabaseNetFetch";

const URL_USER = "https://fixture.supabase.co/auth/v1/user";
const URL_REFRESH = "https://fixture.supabase.co/auth/v1/token?grant_type=refresh_token";

function setElectron(on: boolean) {
  if (on) {
    Object.defineProperty(process.versions, "electron", { value: "38.8.6", configurable: true, enumerable: true });
  } else {
    delete (process.versions as Record<string, string | undefined>).electron;
  }
}

/**
 * Transcribed from SR probe-sr2 (3768-sr/out2.txt): Electron's net.fetch
 * Response has ONE own enumerable key, `__original_resp`, holding the raw
 * response head. auth-js JSON.stringify()s the Response on a 5xx.
 */
function electronLikeResponse(status: number, body: string): Response {
  const r = new Response(body, { status, headers: { "content-type": "application/json" } });
  Object.defineProperty(r, "__original_resp", {
    value: {
      _responseHead: {
        statusCode: status,
        rawHeaders: ["set-cookie", "__cf_bm=SECRETCOOKIE; Path=/", "content-type", "application/json"],
      },
    },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return r;
}

const captureMessage = Sentry.captureMessage as jest.Mock;

/**
 * CI runs jest on Node 20, which has no global WebSocket; realtime-js throws in
 * createClient without one. Realtime is never connected in these tests.
 */
class NoRealtimeWebSocket {
  constructor() {
    throw new Error("realtime is not used in this test");
  }
}

describe("supabaseNetFetch", () => {
  const realFetch = globalThis.fetch;
  let nodeFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSupabaseNetFetchThrottle();
    mockNet.fetch = (...a: unknown[]) => mockNetFetch(...a);
    mockIsReady.mockReturnValue(true);
    nodeFetch = jest.fn(async () => new Response("{}"));
    globalThis.fetch = nodeFetch as unknown as typeof fetch;
    setElectron(true);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setElectron(false);
  });

  it("inside Electron: forwards url, method, headers, body to net.fetch, never Node fetch", async () => {
    mockNetFetch.mockResolvedValue(new Response("{}"));
    await supabaseNetFetch(URL_USER, { method: "POST", headers: { apikey: "k" }, body: "b" });
    expect(mockNetFetch).toHaveBeenCalledWith(
      URL_USER,
      expect.objectContaining({ method: "POST", headers: { apikey: "k" }, body: "b" }),
    );
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("outside Electron (jest): falls back to Node fetch", async () => {
    setElectron(false);
    await supabaseNetFetch(URL_USER, {});
    expect(nodeFetch).toHaveBeenCalledTimes(1);
    expect(mockNetFetch).not.toHaveBeenCalled();
  });

  it("W2: credentials omit + cache no-store win over the caller's init", async () => {
    mockNetFetch.mockResolvedValue(new Response("{}"));
    await supabaseNetFetch(URL_USER, { credentials: "include", cache: "default" });
    const init = mockNetFetch.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
  });

  it("W3: app not ready -> awaits whenReady, then net.fetch; never Node fetch", async () => {
    mockIsReady.mockReturnValue(false);
    let release!: () => void;
    mockWhenReady.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    mockNetFetch.mockResolvedValue(new Response("{}"));

    const p = supabaseNetFetch(URL_USER, {});
    await new Promise((r) => setImmediate(r));
    expect(mockWhenReady).toHaveBeenCalledTimes(1);
    expect(mockNetFetch).not.toHaveBeenCalled();

    release();
    await p;
    expect(mockNetFetch).toHaveBeenCalledTimes(1);
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("C4: inside Electron with no net.fetch -> throws; never Node fetch", async () => {
    mockNet.fetch = undefined;
    await expect(supabaseNetFetch(URL_USER, {})).rejects.toThrow(/net\.fetch is unavailable/);
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("W4: a rejected request rethrows the SAME error object", async () => {
    const err = new Error("net::ERR_CERT_AUTHORITY_INVALID");
    mockNetFetch.mockRejectedValue(err);
    let caught: unknown;
    try {
      await supabaseNetFetch(URL_USER, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });

  it("W1: returns a plain Response (no own keys); a 503 via real auth-js carries no header text", async () => {
    mockNetFetch.mockImplementation(async () => electronLikeResponse(503, '{"msg":"down"}'));

    const direct = await supabaseNetFetch(URL_USER, {});
    expect(Object.keys(direct)).toEqual([]);
    expect(direct.status).toBe(503);

    const sb = createClient("https://fixture.supabase.co", "anon", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: supabaseNetFetch },
      realtime: { transport: NoRealtimeWebSocket as unknown as typeof WebSocket },
    });
    const { error } = await sb.auth.getUser("t");
    expect(error?.name).toBe("AuthRetryableFetchError");
    expect(error?.status).toBe(503);
    expect(error?.message).not.toContain("SECRETCOOKIE");
    expect(error?.message).not.toContain("set-cookie");
  });

  it("W1: 200 JSON body, 204 empty body and status text survive the rebuild", async () => {
    mockNetFetch.mockResolvedValueOnce(new Response('{"a":1}', { status: 200, statusText: "OK", headers: { "x-h": "1" } }));
    const ok = await supabaseNetFetch(URL_USER, {});
    expect(await ok.json()).toEqual({ a: 1 });
    expect(ok.headers.get("x-h")).toBe("1");
    expect(ok.statusText).toBe("OK");

    mockNetFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const empty = await supabaseNetFetch(URL_USER, {});
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("W5: 10 identical failures -> 1 Sentry event and 1 log line; tags are PII-free", async () => {
    mockNetFetch.mockRejectedValue(new Error("net::ERR_CERT_AUTHORITY_INVALID"));
    for (let i = 0; i < 10; i++) {
      await expect(supabaseNetFetch(URL_USER, {})).rejects.toThrow();
    }
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = captureMessage.mock.calls[0];
    expect(msg).toBe("Supabase request failed");
    expect(ctx.tags).toEqual({ auth_step: "getUser", cause_code: "ERR_CERT_AUTHORITY_INVALID", tls_intercept: "true" });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain("fixture.supabase.co");
    expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain("fixture.supabase.co");
  });

  it("W5: after the window, the next failure reports again with the suppressed count", async () => {
    const now = jest.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      mockNetFetch.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
      for (let i = 0; i < 4; i++) await expect(supabaseNetFetch(URL_USER, {})).rejects.toThrow();
      now.mockReturnValue(1_000_000 + REPORT_THROTTLE_MS);
      await expect(supabaseNetFetch(URL_USER, {})).rejects.toThrow();
      expect(captureMessage).toHaveBeenCalledTimes(2);
      expect(captureMessage.mock.calls[1][1].extra).toEqual({ status: 0, suppressed_since_last: 3 });
    } finally {
      now.mockRestore();
    }
  });

  it("W5: an abort is not reported", async () => {
    mockNetFetch.mockRejectedValue(new DOMException("x", "TimeoutError"));
    await expect(supabaseNetFetch(URL_USER, {})).rejects.toThrow();
    expect(captureMessage).not.toHaveBeenCalled();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("a non-2xx token refresh is reported with its status, no body", async () => {
    mockNetFetch.mockResolvedValue(new Response('{"msg":"Invalid Refresh Token"}', { status: 400 }));
    const r = await supabaseNetFetch(URL_REFRESH, {});
    expect(r.status).toBe(400);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][1].tags).toEqual({ auth_step: "refresh", cause_code: "HTTP_400", tls_intercept: "false" });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain("Invalid Refresh Token");
  });

  it("a non-2xx on a non-refresh path is not reported (callers handle it)", async () => {
    mockNetFetch.mockResolvedValue(new Response("{}", { status: 404 }));
    await supabaseNetFetch("https://fixture.supabase.co/rest/v1/users?email=eq.a@b.c", {});
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
