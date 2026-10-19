/**
 * @jest-environment node
 */
/**
 * BACKLOG-3954 — after a streak of mailbox token refreshes that could not
 * reach the provider, the dashboard health banner says "Can't reach
 * Microsoft/Google" (amber, no button) instead of staying silent.
 *
 * Producers are real, end to end: the real `system:health-check` handler ->
 * the real connectionStatusService -> the real microsoft/googleAuthService
 * refresh -> the real axios installed on net.fetch. Only the network answer
 * is staged, at the net.fetch seam (harness from refreshClassification-3799).
 *
 * FIXTURE PROVENANCE (from the BACKLOG-3954 plan, pm_comments feafd423):
 *   CERT_FAIL      Electron 38.8.6 net.fetch against an untrusted root,
 *                  run 2026-10-16: plain Error("net::ERR_CERT_AUTHORITY_INVALID").
 *   INVALID_GRANT  login.microsoftonline.com/common token endpoint with a bogus
 *                  refresh token, 2026-10-16: HTTP 400 with these keys. The
 *                  timestamp / trace / correlation values are placeholders.
 *   OFFLINE        net::ERR_INTERNET_DISCONNECTED, the Chromium code for no
 *                  network (SR plan review); only the online gate matters here.
 *
 * Clock: the health banner polls at mount + 3 s, then every 120 s
 * (SystemHealthMonitor.tsx:155-160), so the real schedule is 3 s, 120 s,
 * 240 s, ... `Date.now` is moved to each poll time.
 */

import axios from "axios";

const mockNetFetch = jest.fn();
let mockOnline = true;

jest.mock("electron", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const base = jest.requireActual("../../../tests/__mocks__/electron.js");
  return {
    ...base,
    app: { ...base.app, isReady: () => true, whenReady: () => Promise.resolve() },
    net: {
      ...(base.net ?? {}),
      fetch: (...args: unknown[]) => mockNetFetch(...args),
      isOnline: () => mockOnline,
    },
  };
});
jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "win32" };
});
jest.mock("../databaseService");
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkAllPermissions: jest.fn(), checkContactsLoading: jest.fn() },
}));
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: jest.fn().mockResolvedValue({}) },
}));

import { ipcMain } from "electron";
import * as Sentry from "@sentry/electron/main";
import databaseService from "../databaseService";
import { installMainNetAxios } from "../mainNetFetch";
import connectionStatusService from "../connectionStatusService";
import { isTokenExpiryError } from "../emailSyncService";
import {
  providerUnreachableHelp,
  providerUnreachableMessage,
  UNREACHABLE_STREAK_THRESHOLD,
} from "../oauthRefreshFailure";
import { SUPPORT_CLOSING_LINE } from "../diagnostics/userFacingErrors";
import { registerDiagnosticHandlers } from "../../handlers/diagnosticHandlers";

const mockDb = databaseService as jest.Mocked<typeof databaseService>;
const mockSentry = Sentry as unknown as {
  captureException: jest.Mock;
  captureMessage: jest.Mock;
};
// pii-allow-uuid: invented placeholder, not from any live row
const USER = "11111111-2222-4333-8444-555555555555";
// pii-allow-uuid: invented placeholder, not from any live row
const OTHER_USER = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const T0 = 1_800_000_000_000;
const S = 1000;

const TITLE_MS = "Can't reach Microsoft. Keepr will keep trying.";
const TITLE_G = "Can't reach Google. Keepr will keep trying.";
const HELP =
  "If you use antivirus or a firewall, check that it isn't blocking Keepr, or restart your computer. If this keeps happening, contact support.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CERT_FAIL = () => {
  throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
};
const OFFLINE = () => {
  throw new Error("net::ERR_INTERNET_DISCONNECTED");
};
const INVALID_GRANT = () =>
  json(
    {
      error: "invalid_grant",
      error_description: "AADSTS9002313: Invalid request. Request is malformed or invalid.",
      error_codes: [9002313],
      timestamp: "2026-10-16 08:00:00Z",
      trace_id: "00000000-0000-0000-0000-000000000000", // pii-allow-uuid: zero placeholder
      correlation_id: "00000000-0000-0000-0000-000000000000", // pii-allow-uuid: zero placeholder
      error_uri: "https://login.microsoftonline.com/error?code=9002313",
    },
    400,
  );
const MS_OK = () =>
  json({
    token_type: "Bearer",
    scope: "Mail.Read offline_access",
    expires_in: 3599,
    access_token: "new-at",
    refresh_token: "new-rt",
  });

type Issue = Record<string, unknown>;
type HealthCheckResult = { success: boolean; issues?: Issue[] };
let healthCheck: (e: unknown, u: string | null, p: string | null) => Promise<HealthCheckResult>;

let savedAdapter: unknown;
let savedEnv: unknown;
let nowSpy: jest.SpyInstance;

/** Which mailbox has a (past-expiry) token row; the other is NOT_CONNECTED. */
function connectOnly(provider: "google" | "microsoft"): void {
  mockDb.getOAuthToken.mockImplementation((async (_u: string, p: string) =>
    p === provider
      ? {
          id: "tok-1",
          access_token: "old-at",
          refresh_token: "old-rt",
          token_expires_at: PAST,
          connected_email_address: "a@example.test",
          scopes_granted: "[]",
        }
      : null) as never);
}

/** One health poll at mount + `atMs`, with the token endpoint answering `answer`. */
async function poll(atMs: number, answer: () => Response, user = USER): Promise<Issue[]> {
  nowSpy.mockReturnValue(T0 + atMs);
  mockNetFetch.mockImplementation(answer);
  const r = await healthCheck({}, user, "microsoft");
  expect(r.success).toBe(true);
  return r.issues ?? [];
}

const unreachableRows = (issues: Issue[]) =>
  issues.filter((i) => i.type === "PROVIDER_UNREACHABLE");

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
  registerDiagnosticHandlers();
  const call = (ipcMain.handle as unknown as jest.Mock).mock.calls.find(
    (c: unknown[]) => c[0] === "system:health-check",
  );
  if (!call) throw new Error("system:health-check was never registered");
  healthCheck = call[1];
});

afterAll(() => {
  delete (process.versions as Record<string, string | undefined>).electron;
  axios.defaults.adapter = savedAdapter as typeof axios.defaults.adapter;
  axios.defaults.env = savedEnv as typeof axios.defaults.env;
});

beforeEach(() => {
  mockNetFetch.mockReset();
  mockSentry.captureException.mockClear();
  mockSentry.captureMessage.mockClear();
  mockOnline = true;
  connectionStatusService.clearCache();
  nowSpy = jest.spyOn(Date, "now");
  connectOnly("microsoft");
  mockDb.getOAuthTokenSyncTime.mockResolvedValue(null as never);
  mockDb.updateOAuthToken.mockResolvedValue(undefined as never);
  mockDb.saveOAuthToken.mockResolvedValue(undefined as never);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const permissionService = require("../permissionService").default;
  permissionService.checkAllPermissions.mockResolvedValue({ allGranted: true, permissions: {}, errors: [] });
  permissionService.checkContactsLoading.mockResolvedValue({ canLoadContacts: true, contactCount: 0 });
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe("threshold (C1, C7)", () => {
  it("is the founder default: 3 failures and a 3-minute floor", () => {
    expect(UNREACHABLE_STREAK_THRESHOLD).toEqual({ failures: 3, minMs: 180_000 });
  });

  it("C1 real poll schedule: no row at 3 s or 120 s, one amber row at the 240 s poll", async () => {
    expect(await poll(3 * S, CERT_FAIL)).toEqual([]);
    expect(await poll(120 * S, CERT_FAIL)).toEqual([]);
    const issues = await poll(240 * S, CERT_FAIL);
    // C4: built field by field — no action, no actionHandler.
    expect(issues).toEqual([
      {
        provider: "microsoft",
        type: "PROVIDER_UNREACHABLE",
        severity: "warning",
        userMessage: TITLE_MS,
        message: HELP,
      },
    ]);
    expect(mockNetFetch).toHaveBeenCalledTimes(3);
  });

  it("C1 time floor: three quick failures at launch show no row", async () => {
    expect(await poll(3 * S, CERT_FAIL)).toEqual([]);
    expect(await poll(5 * S, CERT_FAIL)).toEqual([]);
    expect(await poll(8 * S, CERT_FAIL)).toEqual([]);
  });

  it("C1 count: two failures more than 3 minutes apart show no row", async () => {
    expect(await poll(3 * S, CERT_FAIL)).toEqual([]);
    expect(await poll(203 * S, CERT_FAIL)).toEqual([]);
  });
});

describe("clears and restarts (C2, C3)", () => {
  it("C2 the next successful refresh clears the row, and a new failure starts over", async () => {
    await poll(3 * S, CERT_FAIL);
    await poll(120 * S, CERT_FAIL);
    expect(unreachableRows(await poll(240 * S, CERT_FAIL))).toHaveLength(1);
    expect(await poll(360 * S, MS_OK)).toEqual([]);
    expect(await poll(480 * S, CERT_FAIL)).toEqual([]);
  });

  it("C3 a real invalid_grant mid-streak is Reconnect, never can't-reach", async () => {
    await poll(3 * S, CERT_FAIL);
    await poll(120 * S, CERT_FAIL);
    const issues = await poll(240 * S, INVALID_GRANT);
    expect(unreachableRows(issues)).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      provider: "microsoft",
      type: "TOKEN_REFRESH_FAILED",
      action: "Reconnect",
      actionHandler: "reconnect-microsoft",
    });
  });

  it("C3 the streak restarts after a real auth failure", async () => {
    await poll(3 * S, CERT_FAIL);
    await poll(120 * S, CERT_FAIL);
    await poll(180 * S, INVALID_GRANT);
    // Count is 1 again, so the 240 s failure is not a third in a row.
    expect(await poll(240 * S, CERT_FAIL)).toEqual([]);
  });
});

describe("the row and the Settings text (C4, C6)", () => {
  it("C4 the banner row has no button and the status has no reconnect handler", async () => {
    await poll(3 * S, CERT_FAIL);
    await poll(120 * S, CERT_FAIL);
    const [row] = unreachableRows(await poll(240 * S, CERT_FAIL));
    expect(row).not.toHaveProperty("action");
    expect(row).not.toHaveProperty("actionHandler");
    const status = await connectionStatusService.checkMicrosoftConnection(USER);
    expect(status.error?.actionHandler ?? "").not.toMatch(/reconnect/);
  });

  it("C6 Settings shows the title and the help line, ending with the support line", async () => {
    nowSpy.mockReturnValue(T0);
    mockNetFetch.mockImplementation(CERT_FAIL);
    const ms = await connectionStatusService.checkMicrosoftConnection(USER);
    expect(ms.connected).toBe(true);
    expect(ms.error).toMatchObject({
      type: "PROVIDER_UNREACHABLE",
      userMessage: TITLE_MS,
      action: HELP,
      persistent: false,
    });
    expect(providerUnreachableMessage("Google")).toBe(TITLE_G);
    expect(providerUnreachableHelp()).toBe(HELP);
    expect(HELP.endsWith(SUPPORT_CLOSING_LINE)).toBe(true);
    expect(isTokenExpiryError(new Error(TITLE_MS))).toBe(false);
    expect(isTokenExpiryError(new Error(TITLE_G))).toBe(false);
  });
});

describe("Sentry (C5)", () => {
  it("C5 five failed polls past the threshold send exactly one event", async () => {
    for (const t of [3, 120, 240, 360, 480]) await poll(t * S, CERT_FAIL);
    expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      "Mailbox token refresh unreachable",
      {
        level: "warning",
        tags: {
          service: "connection-status",
          provider: "microsoft",
          causeCode: "ERR_CERT_AUTHORITY_INVALID",
          tlsIntercept: true,
        },
        fingerprint: ["mailbox-refresh-unreachable", "microsoft"],
      },
    );
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });

  it("C5 a real auth failure is still captured", async () => {
    await poll(3 * S, INVALID_GRANT);
    expect(mockSentry.captureException).toHaveBeenCalled();
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });
});

describe("Google (C9)", () => {
  it("C9 the same schedule shows the Google row", async () => {
    connectOnly("google");
    expect(await poll(3 * S, CERT_FAIL)).toEqual([]);
    expect(await poll(120 * S, CERT_FAIL)).toEqual([]);
    expect(await poll(240 * S, CERT_FAIL)).toEqual([
      {
        provider: "google",
        type: "PROVIDER_UNREACHABLE",
        severity: "warning",
        userMessage: TITLE_G,
        message: HELP,
      },
    ]);
  });
});

describe("offline (C10)", () => {
  it("C10 the streak does not advance while the computer is offline", async () => {
    mockOnline = false;
    expect(await poll(3 * S, OFFLINE)).toEqual([]);
    expect(await poll(120 * S, OFFLINE)).toEqual([]);
    expect(await poll(240 * S, OFFLINE)).toEqual([]);
    // Back online: this is the FIRST failure of a streak, not the fourth.
    mockOnline = true;
    expect(await poll(360 * S, CERT_FAIL)).toEqual([]);
  });
});

describe("user change (C11)", () => {
  it("C11 a different user starts a new streak", async () => {
    await poll(3 * S, CERT_FAIL);
    await poll(120 * S, CERT_FAIL);
    expect(await poll(240 * S, CERT_FAIL, OTHER_USER)).toEqual([]);
  });

  it("C11 sign-out ends the streak", async () => {
    await poll(3 * S, CERT_FAIL);
    await poll(120 * S, CERT_FAIL);
    connectionStatusService.resetUnreachableStreaks();
    expect(await poll(240 * S, CERT_FAIL)).toEqual([]);
  });
});
