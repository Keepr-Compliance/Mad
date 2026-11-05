/**
 * BACKLOG-2888 — license:get must not give a FINAL "individual" answer when it
 * could not find out.
 *
 * `readLicenseData` has a placeholder for "not an answer about this user":
 * `sessionBacked: false`, individual, no organization. The renderer re-asks on
 * it (LicenseContext, bounded wait) instead of recording it. Two paths used to
 * skip that placeholder and answer `sessionBacked: true, individual` although
 * the question was never answered:
 *
 *   (a) the membership lookup FAILED — `getActiveOrganizationMembership`
 *       collapses `{ status: "error" }` to null, the same as "no membership",
 *       and the handler fell through to the local row;
 *   (b) a session file exists but the Supabase client is signed out
 *       (`isAuthenticated()` false). The membership query then runs without a
 *       user and reads zero rows, i.e. `{ status: "none" }`, and the handler
 *       fell through the same way.
 *
 * In both, a brokerage user's Complete went to a local export instead of
 * Submit for Review until the next window-focus re-read.
 *
 * Fixtures: the outcome objects are the `MembershipOutcome` union in
 * `electron/services/supabaseService.ts:83-92` (23530c192), verbatim. The mock
 * exposes BOTH membership readers, with `getActiveOrganizationMembership`
 * collapsing the outcome exactly as `supabaseService.ts:453-458` does, so the
 * code before the fix reaches its real fall-through rather than a TypeError.
 */

const registeredHandlers: Record<string, (...args: unknown[]) => unknown> = {};

jest.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers[channel] = handler;
    },
  },
}));

const mockLoadSession = jest.fn();
jest.mock("../../services/sessionService", () => ({
  __esModule: true,
  default: { loadSession: (...args: unknown[]) => mockLoadSession(...args) },
}));

const mockGetUserById = jest.fn();
jest.mock("../../services/db/userDbService", () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

jest.mock("../../services/db/core/dbConnection", () => ({ dbRun: jest.fn() }));

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { isInitialized: jest.fn().mockReturnValue(true) },
}));
jest.mock("../../services/initializationBroadcaster", () => ({
  initializationBroadcaster: { whenDbReady: jest.fn() },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockIsAuthenticated = jest.fn();
const mockMembershipOutcome = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    isAuthenticated: () => mockIsAuthenticated(),
    getActiveOrganizationMembershipOutcome: (...args: unknown[]) =>
      mockMembershipOutcome(...args),
    // supabaseService.ts:453-458: `none` and `error` both become null.
    getActiveOrganizationMembership: async (...args: unknown[]) => {
      const outcome = await mockMembershipOutcome(...args);
      if (outcome.status !== "member") return null;
      return {
        organization_id: outcome.organization_id,
        organization_name: outcome.organization_name,
        is_personal: outcome.is_personal,
      };
    },
  },
}));

jest.mock("../../services/licenseService", () => ({
  validateLicense: jest.fn(),
  createUserLicense: jest.fn(),
  incrementTransactionCount: jest.fn(),
  clearLicenseCache: jest.fn(),
  ensurePersonalOrganization: jest.fn(),
}));

jest.mock("../../services/deviceService", () => ({
  registerDevice: jest.fn(),
  getUserDevices: jest.fn(),
  deactivateDevice: jest.fn(),
  deleteDevice: jest.fn(),
  getDeviceId: jest.fn(),
  isDeviceRegistered: jest.fn(),
  updateDeviceHeartbeat: jest.fn(),
}));

import { registerLicenseHandlers } from "../licenseHandlers";

const USER_ID = "00000000-0000-4000-8000-000000288801"; // pii-allow-uuid: invented fixture id
const BROKERAGE_ORG_ID = "00000000-0000-4000-8000-0000002888c2"; // pii-allow-uuid: invented fixture id

/** The local row a brokerage member typically has: `users_local.license_type` defaults to individual. */
const DB_USER = {
  id: USER_ID,
  license_type: "individual",
  ai_detection_enabled: false,
  organization_id: null,
};

async function licenseGet(): Promise<Record<string, unknown>> {
  const handler = registeredHandlers["license:get"];
  expect(handler).toBeDefined();
  return (await handler({})) as Record<string, unknown>;
}

/** The answer license:get gives with no session file at all — the placeholder of record. */
async function noSessionAnswer(): Promise<Record<string, unknown>> {
  mockLoadSession.mockResolvedValueOnce(null);
  return licenseGet();
}

describe("BACKLOG-2888 — license:get answers 'not yet known' when it could not find out", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    registerLicenseHandlers();
    mockLoadSession.mockResolvedValue({ user: { id: USER_ID } });
    mockGetUserById.mockResolvedValue(DB_USER);
    mockIsAuthenticated.mockReturnValue(true);
    mockMembershipOutcome.mockResolvedValue({ status: "none" });
  });

  it("(a) membership lookup errors -> the no-session placeholder, not a final individual", async () => {
    const placeholder = await noSessionAnswer();
    mockMembershipOutcome.mockResolvedValue({ status: "error" });

    const result = await licenseGet();

    expect(result.sessionBacked).toBe(false);
    expect((result.license as Record<string, unknown>).license_type).toBe("individual");
    expect(result).toEqual(placeholder);
  });

  it("(b) session file present but the Supabase client is signed out -> the placeholder", async () => {
    const placeholder = await noSessionAnswer();
    mockIsAuthenticated.mockReturnValue(false);
    // What a signed-out client's query reads under RLS: zero rows, no error.
    mockMembershipOutcome.mockResolvedValue({ status: "none" });

    const result = await licenseGet();

    expect(result.sessionBacked).toBe(false);
    expect((result.license as Record<string, unknown>).license_type).toBe("individual");
    expect(result).toEqual(placeholder);
  });

  it("genuinely no membership (status none, signed in) is still a FINAL answer from the local row", async () => {
    const result = await licenseGet();

    expect(result.sessionBacked).toBe(true);
    expect(result.license).toEqual({
      license_type: "individual",
      ai_detection_enabled: false,
      organization_id: null,
    });
  });

  it("a brokerage member, signed in, is still a FINAL team answer with the organization", async () => {
    mockMembershipOutcome.mockResolvedValue({
      status: "member",
      organization_id: BROKERAGE_ORG_ID,
      organization_name: "A Brokerage",
      is_personal: false,
    });

    const result = await licenseGet();

    expect(result.sessionBacked).toBe(true);
    expect(result.license).toMatchObject({
      license_type: "team",
      organization_id: BROKERAGE_ORG_ID,
    });
  });
});
