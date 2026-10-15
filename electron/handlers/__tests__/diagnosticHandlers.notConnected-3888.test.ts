/**
 * BACKLOG-3888 — the amber health strip speaks for a NOT_CONNECTED mailbox,
 * but ONLY for a user who has connected one before (cloud
 * preferences.emailProviders is non-empty) and has NO mailbox connected now.
 *
 * Drives the REAL `system:health-check` handler (harness copied from
 * diagnosticHandlers.oneRowPerCause-3237.test.ts).
 *
 * FIXTURE PROVENANCE:
 *   not connected  connectionStatusService.ts checkGoogle/MicrosoftConnection,
 *                  no token row -> { connected: false, error: { type: "NOT_CONNECTED", ... } }
 *   connected      -> { connected: true, email, error: null }
 *   expired        connectionStatusService.ts:215-227 { connected: false, error: { type: "TOKEN_REFRESH_FAILED", ... } }
 *   preferences    supabaseService.getPreferences -> the bag (data?.preferences || {})
 */

import { ipcMain } from "electron";

const mockCheckAllPermissions = jest.fn();
const mockCheckContactsLoading = jest.fn();
const mockCheckAllConnections = jest.fn();
const mockGetPreferences = jest.fn();

jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "win32" };
});

jest.mock("../../services/permissionService", () => ({
  __esModule: true,
  default: {
    checkAllPermissions: (...args: unknown[]) => mockCheckAllPermissions(...args),
    checkContactsLoading: (...args: unknown[]) => mockCheckContactsLoading(...args),
  },
}));

jest.mock("../../services/connectionStatusService", () => ({
  __esModule: true,
  default: {
    checkAllConnections: (...args: unknown[]) => mockCheckAllConnections(...args),
  },
}));

jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: (...args: unknown[]) => mockGetPreferences(...args) },
}));

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { getDatabase: jest.fn(), isInitialized: jest.fn(() => false) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { registerDiagnosticHandlers } from "../diagnosticHandlers";
import {
  NOT_CONNECTED_MESSAGES,
  NOT_CONNECTED_READ_TIMEOUT_MS,
} from "../../services/mailboxNotConnectedIssue";

type Issue = Record<string, unknown>;
type HealthCheckResult = { success: boolean; issues?: Issue[] };

// pii-allow-uuid: invented placeholder, not from any live row
const USER_ID = "11111111-2222-4333-8444-555555555555";

function getHealthCheckHandler(): (
  event: unknown,
  userId: string | null,
  provider: string | null,
) => Promise<HealthCheckResult> {
  registerDiagnosticHandlers();
  const call = (ipcMain.handle as unknown as jest.Mock).mock.calls.find(
    (c: unknown[]) => c[0] === "system:health-check",
  );
  if (!call) throw new Error("system:health-check was never registered");
  return call[1];
}

const NOT_CONNECTED_G = {
  connected: false,
  lastCheck: 1,
  error: { type: "NOT_CONNECTED", userMessage: "Gmail is not connected", action: "Connect Gmail", actionHandler: "connect-google" },
};
const NOT_CONNECTED_M = {
  connected: false,
  lastCheck: 1,
  error: { type: "NOT_CONNECTED", userMessage: "Outlook is not connected", action: "Connect Outlook", actionHandler: "connect-microsoft" },
};
const CONNECTED = { connected: true, lastCheck: 1, email: "broker@example.com", error: null };
const EXPIRED_M = {
  connected: false,
  lastCheck: 1,
  email: "broker@example.com",
  error: {
    type: "TOKEN_REFRESH_FAILED",
    userMessage: "Your Outlook connection expired. Reconnect to keep capturing email.",
    action: "Reconnect",
    actionHandler: "reconnect-microsoft",
    details: "Failed to refresh authentication token",
  },
  lastSyncAt: null,
};

const notConnectedRows = (r: HealthCheckResult) =>
  (r.issues ?? []).filter((i) => i.type === "NOT_CONNECTED");

let handler: ReturnType<typeof getHealthCheckHandler>;

beforeAll(() => {
  handler = getHealthCheckHandler();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAllPermissions.mockResolvedValue({ allGranted: true, permissions: {}, errors: [] });
  mockCheckContactsLoading.mockResolvedValue({ canLoadContacts: true, contactCount: 0 });
  mockCheckAllConnections.mockResolvedValue({ google: NOT_CONNECTED_G, microsoft: NOT_CONNECTED_M });
  mockGetPreferences.mockResolvedValue({});
});

const run = () => handler({}, USER_ID, "microsoft");

describe("BACKLOG-3888 — NOT_CONNECTED row for a user with a recorded provider", () => {
  it('recorded ["outlook"] + nothing connected -> ONE amber Outlook connect row', async () => {
    mockGetPreferences.mockResolvedValue({ emailProviders: ["outlook"] });
    const rows = notConnectedRows(await run());
    expect(rows).toEqual([
      {
        type: "NOT_CONNECTED",
        severity: "warning",
        action: "Connect",
        provider: "microsoft",
        userMessage: NOT_CONNECTED_MESSAGES.outlook,
        actionHandler: "connect-microsoft",
      },
    ]);
  });

  it('recorded ["gmail"] -> the Gmail row', async () => {
    mockGetPreferences.mockResolvedValue({ emailProviders: ["gmail"] });
    const rows = notConnectedRows(await run());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "google",
      userMessage: NOT_CONNECTED_MESSAGES.gmail,
      actionHandler: "connect-google",
    });
  });

  it("both recorded -> ONE row naming email, landing on both buttons", async () => {
    mockGetPreferences.mockResolvedValue({ emailProviders: ["gmail", "outlook"] });
    const rows = notConnectedRows(await run());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userMessage: NOT_CONNECTED_MESSAGES.both,
      actionHandler: "connect-email",
      severity: "warning",
    });
  });

  it("NO record -> no row (texts-only users are unchanged)", async () => {
    mockGetPreferences.mockResolvedValue({ phone_type: "iphone" });
    const r = await run();
    expect(notConnectedRows(r)).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it("empty / unknown-only record -> no row", async () => {
    mockGetPreferences.mockResolvedValue({ emailProviders: [] });
    expect(notConnectedRows(await run())).toEqual([]);
    mockGetPreferences.mockResolvedValue({ emailProviders: ["yahoo"] });
    expect(notConnectedRows(await run())).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["Outlook connected", { google: NOT_CONNECTED_G, microsoft: CONNECTED }],
    ["Gmail connected", { google: CONNECTED, microsoft: NOT_CONNECTED_M }],
  ])("%s (both recorded) -> no row, and the preferences are not even read", async (_n, conns) => {
    mockCheckAllConnections.mockResolvedValue(conns);
    mockGetPreferences.mockResolvedValue({ emailProviders: ["outlook", "gmail"] });
    expect(notConnectedRows(await run())).toEqual([]);
    expect(mockGetPreferences).not.toHaveBeenCalled();
  });

  it("expired Outlook token + recorded -> ONLY the existing reconnect row", async () => {
    mockCheckAllConnections.mockResolvedValue({ google: NOT_CONNECTED_G, microsoft: EXPIRED_M });
    mockGetPreferences.mockResolvedValue({ emailProviders: ["outlook", "gmail"] });
    const r = await run();
    expect(notConnectedRows(r)).toEqual([]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues?.[0]).toMatchObject({ type: "TOKEN_REFRESH_FAILED", actionHandler: "reconnect-microsoft" });
  });

  it("preferences read fails -> no row, health check still answers", async () => {
    mockGetPreferences.mockRejectedValue(new Error("supabase unreachable"));
    const r = await run();
    expect(r.success).toBe(true);
    expect(notConnectedRows(r)).toEqual([]);
  });

  it("preferences read hangs -> bounded: answers at the timeout with no row", async () => {
    jest.useFakeTimers();
    try {
      mockGetPreferences.mockReturnValue(new Promise(() => {}));
      let settled = false;
      const pending = run().then((r) => {
        settled = true;
        return r;
      });
      await jest.advanceTimersByTimeAsync(NOT_CONNECTED_READ_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      expect(notConnectedRows(await pending)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
