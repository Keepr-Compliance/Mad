/**
 * @jest-environment node
 */
/**
 * BACKLOG-3799 (SR C1) — transport errors from Electron net.fetch still
 * classify as network / retryable.
 *
 * Fixture source: SR probe, real Electron 38 + axios 1.18.1 + googleapis'
 * nested gaxios 6.7.1 (scratchpad probe2867/out.json + review notes):
 *   net.fetch refused  -> Error "net::ERR_CONNECTION_REFUSED" (no code)
 *   gaxios (Gmail)     -> GaxiosError "net::ERR_CONNECTION_REFUSED" /
 *                         "net::ERR_NAME_NOT_RESOLVED" ..., code undefined
 *   axios              -> AxiosError "Network Error", code ERR_NETWORK,
 *                         cause net::ERR_...
 *   axios timeout      -> code ETIMEDOUT
 */
import axios from "axios";

const mockNetFetch = jest.fn();
jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  return {
    ...base,
    app: { ...base.app, isReady: () => true, whenReady: () => Promise.resolve() },
    net: { ...(base.net ?? {}), fetch: (...args: unknown[]) => mockNetFetch(...args) },
  };
});
jest.mock("../databaseService");
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { isNetworkError } from "../../utils/networkErrors";
import { isRetryableError, withRetry } from "../../utils/apiRateLimit";
import { installMainNetAxios, gaxiosNetFetch } from "../mainNetFetch";
import outlookFetchService from "../outlookFetchService";

function gaxiosShape(message: string): Error {
  const e = new Error(message);
  e.name = "GaxiosError"; // code intentionally undefined, as measured
  return e;
}

const GAXIOS_RETRYABLE = [
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_CONNECTION_TIMED_OUT",
];

describe("C1 Chromium transport errors classify as network / retryable", () => {
  it.each(GAXIOS_RETRYABLE)("gaxios %s -> network AND retryable", (m) => {
    expect(isNetworkError(gaxiosShape(m))).toBe(true);
    expect(isRetryableError(gaxiosShape(m))).toBe(true);
  });

  it("gaxios net::ERR_CERT_AUTHORITY_INVALID -> network, not retryable", () => {
    const e = gaxiosShape("net::ERR_CERT_AUTHORITY_INVALID");
    expect(isNetworkError(e)).toBe(true);
    expect(isRetryableError(e)).toBe(false);
  });

  it("axios ERR_NETWORK (code, with nested Chromium cause) -> network AND retryable", async () => {
    installMainNetAxios(axios);
    Object.defineProperty(process.versions, "electron", { value: "38.8.6", configurable: true, enumerable: true });
    mockNetFetch.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const err = await axios.get("https://graph.microsoft.com/v1.0/me").catch((e) => e);
    delete (process.versions as Record<string, string | undefined>).electron;
    expect(err.code).toBe("ERR_NETWORK");
    expect(isNetworkError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it("a bare code ERR_NETWORK (message-less wrapper) is retryable", () => {
    expect(isRetryableError(Object.assign(new Error("x"), { code: "ERR_NETWORK" }))).toBe(true);
  });

  it("walks the cause chain", () => {
    const e = Object.assign(new Error("wrapped"), { cause: new Error("net::ERR_NAME_NOT_RESOLVED") });
    expect(isNetworkError(e)).toBe(true);
    expect(isRetryableError(e)).toBe(true);
  });

  it("does NOT misclassify: ERR_ABORTED, HTTP 400, plain errors", () => {
    expect(isNetworkError(gaxiosShape("net::ERR_ABORTED"))).toBe(false);
    expect(isRetryableError(gaxiosShape("net::ERR_ABORTED"))).toBe(false);
    expect(isRetryableError(Object.assign(new Error("bad"), { response: { status: 400 } }))).toBe(false);
    expect(isNetworkError(new Error("something else"))).toBe(false);
  });
});

describe("C1 Outlook path retries a transport failure (withRetry)", () => {
  it("ERR_NETWORK is attempted 1 + maxRetries times, not once", async () => {
    installMainNetAxios(axios);
    Object.defineProperty(process.versions, "electron", { value: "38.8.6", configurable: true, enumerable: true });
    mockNetFetch.mockReset();
    mockNetFetch.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const realSetTimeout = global.setTimeout;
    const spy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout);
    const svc = outlookFetchService as unknown as {
      accessToken: string;
      _graphRequest: (e: string, m: string, d: unknown, r: boolean, h: undefined, s: undefined, o: { maxRetries: number }) => Promise<unknown>;
    };
    svc.accessToken = "at";
    const err = await svc
      ._graphRequest("/me", "GET", null, false, undefined, undefined, { maxRetries: 3 })
      .catch((e) => e);
    spy.mockRestore();
    delete (process.versions as Record<string, string | undefined>).electron;
    expect(err).toBeInstanceOf(Error);
    expect(mockNetFetch).toHaveBeenCalledTimes(4);
  });
});

describe("D1 axios-shaped certificate failure is network but NOT retryable", () => {
  // Shape measured by SR in real Electron (BACKLOG-3799 pm_comments 9ed51b67):
  //   AX https://self-signed.badssl.com/ ERR_NETWORK cause net::ERR_CERT_AUTHORITY_INVALID
  //   AX https://expired.badssl.com/     ERR_NETWORK cause net::ERR_CERT_DATE_INVALID
  const axiosCert = (m: string) =>
    Object.assign(new Error("Network Error"), {
      isAxiosError: true,
      code: "ERR_NETWORK",
      cause: new Error(m),
    });

  it.each(["net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CERT_DATE_INVALID"])(
    "axios ERR_NETWORK with cause %s -> network, not retryable",
    (m) => {
      const e = axiosCert(m);
      expect(isNetworkError(e)).toBe(true);
      expect(isRetryableError(e)).toBe(false);
    },
  );

  it("withRetry makes exactly one attempt on it", async () => {
    const fn = jest.fn().mockRejectedValue(axiosCert("net::ERR_CERT_AUTHORITY_INVALID"));
    await expect(withRetry(fn, { maxRetries: 3, baseDelay: 1 })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("should-fix (b) request timeouts are honoured", () => {
  beforeAll(() => {
    Object.defineProperty(process.versions, "electron", { value: "38.8.6", configurable: true, enumerable: true });
  });
  afterAll(() => {
    delete (process.versions as Record<string, string | undefined>).electron;
  });

  /** A server that never answers; settles only when the request is aborted. */
  function hang() {
    mockNetFetch.mockReset();
    mockNetFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
  }

  it("T1 axios timeout ends a hanging request with ETIMEDOUT", async () => {
    installMainNetAxios(axios);
    hang();
    const t0 = Date.now();
    const err = await axios.get("https://graph.microsoft.com/v1.0/me", { timeout: 150 }).catch((e) => e);
    expect(err.code).toBe("ETIMEDOUT");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(isNetworkError(err)).toBe(true);
  });

  it("T2 gaxios timeout ends a hanging request with ETIMEDOUT", async () => {
    hang();
    const t0 = Date.now();
    const err = await gaxiosNetFetch("https://gmail.googleapis.com/x", { timeout: 150 }).catch((e) => e);
    expect(err.code).toBe("ETIMEDOUT");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(isNetworkError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it("T3 a caller abort stays an abort (not reported as a timeout)", async () => {
    hang();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await gaxiosNetFetch("https://gmail.googleapis.com/x", { timeout: 5000, signal: ac.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err.code).toBeUndefined();
  });
});
