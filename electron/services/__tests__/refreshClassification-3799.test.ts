/**
 * @jest-environment node
 */
/**
 * BACKLOG-3799 — a mailbox token refresh that cannot REACH the provider is not
 * an expired connection. Only a real OAuth rejection (400 invalid_grant and
 * friends) may say "expired / Reconnect".
 *
 * Producers are real: the requests go through the real axios (installed on
 * net.fetch), the real microsoftAuthService / googleAuthService refresh code,
 * the real outlookFetchService 401 -> refresh path and the real
 * connectionStatusService. Only the network answer is staged, at the
 * net.fetch seam, in the two shapes the founder's PC produced:
 *   - Chromium rejects with `net::ERR_CERT_AUTHORITY_INVALID` (what net.fetch
 *     throws for an untrusted issuer), and
 *   - the token endpoint answers 400 `invalid_grant`.
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
import connectionStatusService from "../connectionStatusService";
import outlookFetchService from "../outlookFetchService";
import { isTokenExpiryError } from "../emailSyncService";
import { isTransientRefreshFailure } from "../oauthRefreshFailure";

const mockDb = databaseService as jest.Mocked<typeof databaseService>;
const USER = "user-3799";
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CERT_FAIL = () => {
  throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
};
const INVALID_GRANT = () =>
  json({ error: "invalid_grant", error_description: "AADSTS70008: refresh token expired" }, 400);
const SERVER_DOWN = () => json({ error: "temporarily_unavailable" }, 503);

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
  connectionStatusService.clearCache();
  mockDb.getOAuthToken.mockResolvedValue({
    id: "tok-1",
    access_token: "old-at",
    refresh_token: "old-rt",
    token_expires_at: PAST,
    connected_email_address: "a@example.test",
    scopes_granted: "[]",
  } as never);
  mockDb.getOAuthTokenSyncTime.mockResolvedValue(null as never);
  mockDb.updateOAuthToken.mockResolvedValue(undefined as never);
  mockDb.saveOAuthToken.mockResolvedValue(undefined as never);
});

describe("Settings / connection status after a failed refresh", () => {
  it("C1 Outlook: certificate failure keeps the connection and says can't reach Microsoft", async () => {
    mockNetFetch.mockImplementation(CERT_FAIL);
    const s = await connectionStatusService.checkMicrosoftConnection(USER);
    expect(s.connected).toBe(true);
    expect(s.error?.type).toBe("PROVIDER_UNREACHABLE");
    expect(s.error?.userMessage).toBe(
      "Can't reach Microsoft. Check your network or antivirus, then try again.",
    );
    expect(mockNetFetch).toHaveBeenCalled();
  });

  it("C2 Outlook: invalid_grant still says expired / Reconnect", async () => {
    mockNetFetch.mockImplementation(INVALID_GRANT);
    const s = await connectionStatusService.checkMicrosoftConnection(USER);
    expect(s.connected).toBe(false);
    expect(s.error?.type).toBe("TOKEN_REFRESH_FAILED");
    expect(s.error?.userMessage).toMatch(/Outlook connection expired/);
    expect(s.error?.action).toBe("Reconnect");
  });

  it("C3 Outlook: a 503 from the token endpoint is unreachable, not expired", async () => {
    mockNetFetch.mockImplementation(SERVER_DOWN);
    const s = await connectionStatusService.checkMicrosoftConnection(USER);
    expect(s.connected).toBe(true);
    expect(s.error?.type).toBe("PROVIDER_UNREACHABLE");
  });

  it("C4 Gmail: certificate failure keeps the connection and says can't reach Google", async () => {
    mockNetFetch.mockImplementation(CERT_FAIL);
    const s = await connectionStatusService.checkGoogleConnection(USER);
    expect(s.connected).toBe(true);
    expect(s.error?.type).toBe("PROVIDER_UNREACHABLE");
    expect(s.error?.userMessage).toBe(
      "Can't reach Google. Check your network or antivirus, then try again.",
    );
  });

  it("C5 Gmail: invalid_grant still says expired / Reconnect", async () => {
    mockNetFetch.mockImplementation(() =>
      json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    );
    const s = await connectionStatusService.checkGoogleConnection(USER);
    expect(s.connected).toBe(false);
    expect(s.error?.type).toBe("TOKEN_REFRESH_FAILED");
    expect(s.error?.userMessage).toMatch(/Gmail connection expired/);
  });
});

describe("Outlook mail fetch: Graph 401 -> refresh fails", () => {
  type Svc = {
    accessToken: string;
    refreshToken: string | null;
    userId: string | null;
    tokenId: string | null;
    _graphRequest: (e: string) => Promise<unknown>;
  };
  const svc = outlookFetchService as unknown as Svc;

  function graph401ThenRefresh(refresh: () => Response) {
    mockNetFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("graph.microsoft.com")) {
        return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
      }
      return refresh();
    });
  }

  beforeEach(() => {
    svc.accessToken = "old-at";
    svc.refreshToken = "old-rt";
    svc.userId = USER;
    svc.tokenId = "tok-1";
  });

  it("O1 certificate failure on the refresh: can't-reach error, NOT a token-expiry error", async () => {
    graph401ThenRefresh(CERT_FAIL);
    const err = await svc._graphRequest("/me/messages").catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "Can't reach Microsoft. Check your network or antivirus, then try again.",
    );
    expect(isTokenExpiryError(err)).toBe(false);
  });

  it("O2 invalid_grant on the refresh: reconnect error, IS a token-expiry error", async () => {
    graph401ThenRefresh(INVALID_GRANT);
    const err = await svc._graphRequest("/me/messages").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Please reconnect Outlook/);
    expect(isTokenExpiryError(err)).toBe(true);
  });
});

describe("isTransientRefreshFailure on unrecognised failures", () => {
  it("U1 an error with no status and no network signature keeps today's Reconnect", () => {
    expect(isTransientRefreshFailure(new Error("database is locked"))).toBe(false);
  });
  it("U2 429 and 408 are transient; 401 is not", () => {
    expect(isTransientRefreshFailure({ response: { status: 429 } })).toBe(true);
    expect(isTransientRefreshFailure({ response: { status: 408 } })).toBe(true);
    expect(isTransientRefreshFailure({ response: { status: 401 } })).toBe(false);
  });
});
