/**
 * @jest-environment node
 */

/**
 * BACKLOG-3768: the REAL supabase-js client built by supabaseService rides
 * Electron net.fetch for every request, including the auto-refresh ticker.
 *
 * Controls:
 *  F1  createClient receives global.fetch, and requests reach net.fetch with
 *      url/method/headers/body intact (Node fetch never called)
 *  R1  the auto-refresh ticker's /token?grant_type=refresh_token goes through
 *      net.fetch; a failing refresh produces a Sentry event tagged auth_step=refresh
 *  G1  grep guard: exactly one createClient( call site in electron/ (non-test)
 *
 * "Inside Electron" is simulated by defining process.versions.electron.
 * net.fetch is a mock; no socket is opened.
 */

import * as fs from "fs";
import * as path from "path";
import * as Sentry from "@sentry/electron/main";

const mockNetFetch = jest.fn();
jest.mock("electron", () => ({
  app: { isReady: () => true, whenReady: () => Promise.resolve(), getPath: () => "/tmp" },
  net: { fetch: (...a: unknown[]) => mockNetFetch(...a) },
}));
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { updateSession: jest.fn(() => Promise.resolve(true)) },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(() => Promise.resolve()),
    warn: jest.fn(() => Promise.resolve()),
    error: jest.fn(() => Promise.resolve()),
    debug: jest.fn(() => Promise.resolve()),
  },
}));

process.env.SUPABASE_URL = "https://fixture.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";

import supabaseService from "../supabaseService";
import { __resetSupabaseNetFetchThrottle } from "../supabaseNetFetch";

function jwt(expSec: number): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b({ sub: "user-1", exp: expSec })}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { id: "user-1", aud: "authenticated", email: "u@example.com" };

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const calledUrls = () => mockNetFetch.mock.calls.map((c) => String(c[0]));

describe("BACKLOG-3768: supabaseService client on net.fetch", () => {
  const realFetch = globalThis.fetch;
  const nodeFetch = jest.fn();

  beforeAll(() => {
    Object.defineProperty(process.versions, "electron", { value: "38.8.6", configurable: true, enumerable: true });
    globalThis.fetch = nodeFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    delete (process.versions as Record<string, string | undefined>).electron;
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    mockNetFetch.mockReset();
    (Sentry.captureMessage as jest.Mock).mockClear();
    __resetSupabaseNetFetchThrottle();
  });

  afterEach(async () => {
    await supabaseService.getClient().auth.stopAutoRefresh();
  });

  it("F1: auth and PostgREST requests reach net.fetch with headers and body; Node fetch never used", async () => {
    mockNetFetch.mockImplementation(async (url: string) =>
      String(url).includes("/auth/v1/user") ? json(user) : json([{ id: 1 }], 201),
    );
    const client = supabaseService.getClient();
    const { error } = await client.auth.setSession({ access_token: jwt(nowSec() + 3600), refresh_token: "r1" });
    expect(error).toBeNull();
    await client.from("probe").insert({ a: 1 }).select();

    const [authUrl, authInit] = mockNetFetch.mock.calls[0];
    expect(String(authUrl)).toBe("https://fixture.supabase.co/auth/v1/user");
    expect(new Headers(authInit.headers).get("apikey")).toBe("anon-key");
    const restCall = mockNetFetch.mock.calls.find((c) => String(c[0]).includes("/rest/v1/probe"));
    expect(restCall).toBeDefined();
    expect(restCall![1].method).toBe("POST");
    expect(restCall![1].body).toBe(JSON.stringify({ a: 1 }));
    expect(restCall![1].credentials).toBe("omit");
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("R1: the auto-refresh ticker refreshes through net.fetch", async () => {
    mockNetFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/auth/v1/user")) return json(user);
      if (String(url).includes("grant_type=refresh_token")) {
        return json({ access_token: jwt(nowSec() + 3600), refresh_token: "r2", expires_in: 3600, token_type: "bearer", user });
      }
      return json({});
    });
    const client = supabaseService.getClient();
    // Expires inside the ticker's refresh margin.
    await client.auth.setSession({ access_token: jwt(nowSec() + 20), refresh_token: "r1" });
    await client.auth.startAutoRefresh();

    await waitFor(() => calledUrls().some((u) => u.endsWith("/auth/v1/token?grant_type=refresh_token")));
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("R1: a failing refresh produces a Sentry event tagged auth_step=refresh", async () => {
    mockNetFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/auth/v1/user")) return json(user);
      throw new Error("net::ERR_INTERNET_DISCONNECTED");
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const client = supabaseService.getClient();
    try {
      await client.auth.setSession({ access_token: jwt(nowSec() + 20), refresh_token: "r1" });
      await client.auth.startAutoRefresh();

      const refreshEvent = () =>
        (Sentry.captureMessage as jest.Mock).mock.calls.find((c) => c[1]?.tags?.auth_step === "refresh");
      await waitFor(() => !!refreshEvent());
      expect(refreshEvent()![1].tags).toEqual({
        auth_step: "refresh",
        cause_code: "ERR_INTERNET_DISCONNECTED",
        tls_intercept: "false",
      });
      // Let auth-js's retry loop finish (network "back"), so no backoff timer outlives the test.
      const refreshCalls = () => calledUrls().filter((u) => u.includes("grant_type=refresh_token")).length;
      const before = refreshCalls();
      mockNetFetch.mockImplementation(async (url: string) =>
        String(url).includes("grant_type=refresh_token")
          ? json({ access_token: jwt(nowSec() + 3600), refresh_token: "r2", expires_in: 3600, token_type: "bearer", user })
          : json(user),
      );
      await waitFor(() => refreshCalls() > before, 10000);
      await client.auth.stopAutoRefresh();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("G1: exactly one createClient( call site in electron/ (non-test source)", () => {
    const root = path.resolve(__dirname, "../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "__tests__" || e.name === "node_modules") continue;
          walk(p);
        } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          if (/\bcreateClient\s*\(/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(hits).toEqual(["services/supabaseService.ts"]);
  });
});
