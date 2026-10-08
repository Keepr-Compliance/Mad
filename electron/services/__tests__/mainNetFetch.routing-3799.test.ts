/**
 * @jest-environment node
 */
/**
 * BACKLOG-3799 — every main-process client that talks to Microsoft, Google or
 * Maps goes through Electron `net.fetch`, not Node's TLS.
 *
 * "Inside Electron" is simulated the way the 3768 suites do it: define
 * `process.versions.electron` (what mainNetFetch reads) and give the electron
 * mock a recording `net.fetch`. Every request below is answered by that mock,
 * so nothing leaves the process. If a client still used Node's transport, the
 * call would miss the mock and reach the network guard instead.
 *
 * Covers BOTH halves of each provider (token refresh AND data fetch), so a fix
 * that wires one and forgets the other goes red here.
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

import databaseService from "../databaseService";
import { installMainNetAxios } from "../mainNetFetch";
import microsoftAuthService from "../microsoftAuthService";
import googleAuthService from "../googleAuthService";
import outlookFetchService from "../outlookFetchService";
import addressVerificationService from "../addressVerificationService";
import gmailFetchService from "../gmailFetchService";
import { GoogleContactProvider } from "../providers/googleContactProvider";

const mockDb = databaseService as jest.Mocked<typeof databaseService>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function answer(url: string): Response {
  if (url.includes("/oauth2/v2.0/token") || url.includes("oauth2.googleapis.com/token")) {
    return json({ access_token: "new-at", expires_in: 3600, refresh_token: "new-rt", token_type: "Bearer" });
  }
  if (url.includes("maps.googleapis.com")) return json({ status: "ZERO_RESULTS", predictions: [] });
  if (url.includes("people.googleapis.com")) return json({ connections: [], totalItems: 0 });
  if (url.includes("gmail.googleapis.com")) return json({ emailAddress: "a@example.test" });
  if (url.includes("graph.microsoft.com")) return json({ id: "x", displayName: "X", mail: "a@example.test" });
  return json({}, 404);
}

/** URLs + methods the electron net.fetch saw, in order. */
function seen(): Array<{ url: string; method: string }> {
  return mockNetFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase(),
  }));
}

const tokenRow = {
  id: "tok-1",
  user_id: "u1",
  provider: "google",
  purpose: "mailbox",
  access_token: "old-at",
  refresh_token: "old-rt",
  token_expires_at: "2020-01-01T00:00:00.000Z",
  connected_email_address: "a@example.test",
  mailbox_connected: true,
  scopes_granted: "[]",
  is_active: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

let savedAdapter: unknown;
let savedEnv: unknown;

beforeAll(() => {
  Object.defineProperty(process.versions, "electron", {
    value: "38.8.6",
    configurable: true,
    enumerable: true,
  });
  process.env.MICROSOFT_CLIENT_ID = "test-ms-client";
  process.env.GOOGLE_CLIENT_ID = "test-g-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-g-secret";
  savedAdapter = axios.defaults.adapter;
  savedEnv = axios.defaults.env;
  installMainNetAxios(axios);
});

afterAll(() => {
  delete (process.versions as Record<string, string | undefined>).electron;
  axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
  axios.defaults.env = savedEnv as typeof axios.defaults.env;
});

beforeEach(() => {
  mockNetFetch.mockReset();
  mockNetFetch.mockImplementation(async (url: string) => answer(String(url)));
  mockDb.getOAuthToken.mockResolvedValue(tokenRow as never);
  mockDb.updateOAuthToken.mockResolvedValue(undefined as never);
});

describe("Microsoft: token refresh AND Graph fetch ride net.fetch", () => {
  it("R1 token refresh (login.microsoftonline.com) goes through net.fetch", async () => {
    const tokens = await microsoftAuthService.refreshToken("old-rt");
    expect(tokens.access_token).toBe("new-at");
    expect(seen()).toEqual([
      { url: expect.stringMatching(/^https:\/\/login\.microsoftonline\.com\/.+\/oauth2\/v2\.0\/token$/), method: "POST" },
    ]);
  });

  it("R2 Graph /me (auth service) goes through net.fetch", async () => {
    await microsoftAuthService.getUserInfo("at");
    expect(seen()[0].url).toBe("https://graph.microsoft.com/v1.0/me");
  });

  it("R3 Outlook mail fetch (_graphRequest) goes through net.fetch", async () => {
    const svc = outlookFetchService as unknown as {
      accessToken: string;
      _graphRequest: (endpoint: string) => Promise<unknown>;
    };
    svc.accessToken = "at";
    await svc._graphRequest("/me/mailFolders/inbox");
    expect(seen()).toEqual([
      { url: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox", method: "GET" },
    ]);
    const init = mockNetFetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer at");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
  });
});

describe("Google: token refresh AND Gmail / People fetch ride net.fetch", () => {
  it("R4 googleAuthService token refresh goes through net.fetch", async () => {
    await googleAuthService.refreshToken("old-rt");
    expect(seen()).toEqual([{ url: "https://oauth2.googleapis.com/token", method: "POST" }]);
  });

  it("R5 Gmail API call goes through net.fetch (googleapis transporter)", async () => {
    await gmailFetchService.initialize("u1");
    const gmail = (gmailFetchService as unknown as {
      gmail: { users: { getProfile: (p: { userId: string }) => Promise<{ data: unknown }> } };
    }).gmail;
    const res = await gmail.users.getProfile({ userId: "me" });
    expect(res.data).toEqual({ emailAddress: "a@example.test" });
    expect(seen().map((s) => s.url)).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    ]);
  });

  it("R6 Gmail client's own token refresh goes through net.fetch", async () => {
    await gmailFetchService.initialize("u1");
    const client = (gmailFetchService as unknown as {
      oauth2Client: { refreshAccessToken: () => Promise<unknown> };
    }).oauth2Client;
    await client.refreshAccessToken();
    expect(seen()).toEqual([{ url: "https://oauth2.googleapis.com/token", method: "POST" }]);
  });

  it("R7 Google contacts (People API) go through net.fetch", async () => {
    await new GoogleContactProvider().fetchContacts("u1");
    expect(seen().length).toBeGreaterThan(0);
    expect(seen().every((s) => s.url.startsWith("https://people.googleapis.com/"))).toBe(true);
  });
});

describe("Address verification rides net.fetch", () => {
  it("R8 Places autocomplete goes through net.fetch", async () => {
    addressVerificationService.initialize("test-maps-key");
    await addressVerificationService.getAddressSuggestions("123 Main Street");
    expect(seen()).toHaveLength(1);
    expect(seen()[0].url.startsWith("https://maps.googleapis.com/maps/api/place/autocomplete/json?")).toBe(true);
  });
});

describe("axios error shape over net.fetch", () => {
  it("R9 an HTTP error keeps response.status and response.data", async () => {
    mockNetFetch.mockImplementation(async () =>
      json({ error: "invalid_grant", error_description: "AADSTS70008" }, 400),
    );
    const err = await axios.post("https://login.microsoftonline.com/x/oauth2/v2.0/token", "a=b").catch((e) => e);
    expect(err.isAxiosError).toBe(true);
    expect(err.response.status).toBe(400);
    expect(err.response.data).toEqual({ error: "invalid_grant", error_description: "AADSTS70008" });
  });

  it("R10 a transport failure becomes ERR_NETWORK with the Chromium error as cause", async () => {
    const chromium = new Error("net::ERR_CERT_AUTHORITY_INVALID");
    mockNetFetch.mockImplementation(async () => {
      throw chromium;
    });
    const err = await axios.get("https://graph.microsoft.com/v1.0/me").catch((e) => e);
    expect(err.isAxiosError).toBe(true);
    expect(err.code).toBe("ERR_NETWORK");
    expect(err.response).toBeUndefined();
    // axios unwraps our TypeError("fetch failed") and keeps its cause.
    expect(err.cause).toBe(chromium);
  });
});
