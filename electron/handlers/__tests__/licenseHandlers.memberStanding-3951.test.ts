/**
 * BACKLOG-3951 — license:get carries the membership standing.
 *
 * C5   unassigned member ⇒ license_type individual (unchanged) + standing unlicensed
 * C5b  older unassigned at A + active at B ⇒ team + licensed (R2)
 * R2   a standing read that errors or throws ⇒ license identical to the
 *      no-standing answer, `membership` absent
 * R1   a standing read that never answers ⇒ license:get still answers within
 *      the bound, license unchanged, `membership` absent
 * Rows: the transcribed keepr-test row (helpers/membership3951Fixtures).
 */

import { UNASSIGNED_MEMBER_ROW, NIL } from "../../services/__tests__/helpers/membership3951Fixtures";
import { personalMembership } from "../../services/__tests__/helpers/postgrestEmulator";

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

const mockGetActiveOrganizationMembership = jest.fn();
const mockStandingRows = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getActiveOrganizationMembership: (...args: unknown[]) =>
      mockGetActiveOrganizationMembership(...args),
    // BACKLOG-2888: license:get now asks isAuthenticated() and reads the
    // membership OUTCOME. Shimmed onto the existing membership mock so every
    // assertion below is unchanged: an object is a member, null is none.
    isAuthenticated: () => true,
    getActiveOrganizationMembershipOutcome: async (...a: unknown[]) => {
      const m = await mockGetActiveOrganizationMembership(...a);
      return m ? { status: "member", ...m } : { status: "none" };
    },
    getMembershipStandingRows: (...args: unknown[]) => mockStandingRows(...args),
  },
}));

const mockValidateLicense = jest.fn();
const mockEnsurePersonalOrganization = jest.fn();
jest.mock("../../services/licenseService", () => ({
  validateLicense: (...args: unknown[]) => mockValidateLicense(...args),
  createUserLicense: jest.fn(),
  incrementTransactionCount: jest.fn(),
  clearLicenseCache: jest.fn(),
  ensurePersonalOrganization: (...args: unknown[]) =>
    mockEnsurePersonalOrganization(...args),
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

const USER_ID = "00000000-0000-4000-8000-000000395101"; // pii-allow-uuid: invented fixture id
const BROKERAGE_B = "00000000-0000-4000-8000-0000003951b1"; // pii-allow-uuid: invented fixture id

const SOLO_DB_USER = {
  id: USER_ID,
  license_type: "individual",
  ai_detection_enabled: false,
  organization_id: null,
};

const unassigned = { ...UNASSIGNED_MEMBER_ROW, user_id: USER_ID };
const rows = (r: unknown[]) => mockStandingRows.mockResolvedValue({ status: "rows", rows: r });

async function licenseGet(): Promise<Record<string, unknown>> {
  const handler = registeredHandlers["license:get"];
  expect(handler).toBeDefined();
  return (await handler({})) as Record<string, unknown>;
}

describe("BACKLOG-3951 — license:get and the membership standing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    registerLicenseHandlers();
    mockLoadSession.mockResolvedValue({ user: { id: USER_ID } });
    mockGetUserById.mockResolvedValue(SOLO_DB_USER);
    mockGetActiveOrganizationMembership.mockResolvedValue(null); // active-only read: blind to unassigned
    rows([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("C5 unassigned ⇒ individual as before, plus standing unlicensed", async () => {
    rows([unassigned]);
    const r = await licenseGet();
    expect(r).toEqual({
      success: true,
      sessionBacked: true,
      license: { license_type: "individual", ai_detection_enabled: false, organization_id: null },
      membership: { standing: "unlicensed" },
    });
    expect(mockStandingRows).toHaveBeenCalledWith(USER_ID);
  });

  it("C5b older unassigned at A + active at B ⇒ team at B, standing licensed", async () => {
    rows([unassigned, { ...unassigned, organization_id: BROKERAGE_B, license_status: "active" }]);
    mockGetActiveOrganizationMembership.mockResolvedValue({
      organization_id: BROKERAGE_B,
      organization_name: "B",
      is_personal: false,
    });
    const r = await licenseGet();
    expect((r.license as Record<string, unknown>).license_type).toBe("team");
    expect(r.membership).toEqual({ standing: "licensed" });
  });

  it("removed member ⇒ individual, standing left_brokerage with the brokerage name and id (4171)", async () => {
    rows([{ ...unassigned, license_status: "suspended" }, personalMembership({ userId: USER_ID })]);
    const r = await licenseGet();
    expect((r.license as Record<string, unknown>).license_type).toBe("individual");
    expect(r.membership).toEqual({
      standing: "left_brokerage",
      organization_name: "Fixture Brokerage",
      organization_id: NIL,
    });
  });

  it("no local licence row ⇒ default individual, standing still carried", async () => {
    mockGetUserById.mockResolvedValue(null);
    rows([unassigned]);
    const r = await licenseGet();
    expect(r.license).toEqual({ license_type: "individual", ai_detection_enabled: false, organization_id: undefined });
    expect(r.membership).toEqual({ standing: "unlicensed" });
  });

  it("no session ⇒ the no-session default, no standing read", async () => {
    mockLoadSession.mockResolvedValue(null);
    const r = await licenseGet();
    expect(r.sessionBacked).toBe(false);
    expect(r).not.toHaveProperty("membership");
    expect(mockStandingRows).not.toHaveBeenCalled();
  });

  it.each([
    ["errors", () => mockStandingRows.mockResolvedValue({ status: "error" })],
    ["throws", () => mockStandingRows.mockRejectedValue(new Error("boom"))],
    ["is not a list", () => mockStandingRows.mockResolvedValue({ status: "rows", rows: { x: 1 } })],
  ])("R2 standing read %s ⇒ licence unchanged, membership absent", async (_n, arrange) => {
    const baseline = await licenseGet();
    arrange();
    const r = await licenseGet();
    expect(r).not.toHaveProperty("membership");
    expect(r.license).toEqual(baseline.license);
    expect(r.sessionBacked).toBe(baseline.sessionBacked);
  });

  it("R2 team member whose standing read errors ⇒ still team, membership absent", async () => {
    mockGetActiveOrganizationMembership.mockResolvedValue({
      organization_id: BROKERAGE_B,
      organization_name: "B",
      is_personal: false,
    });
    mockStandingRows.mockResolvedValue({ status: "error" });
    const r = await licenseGet();
    expect((r.license as Record<string, unknown>).license_type).toBe("team");
    expect(r).not.toHaveProperty("membership");
  });

  it("R1 a standing read that never answers ⇒ license:get answers at the bound, licence unchanged", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    mockStandingRows.mockReturnValue(new Promise(() => {}));
    let settled: Record<string, unknown> | "pending" = "pending";
    void licenseGet().then((r) => {
      settled = r;
    });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe("pending");
    await jest.advanceTimersByTimeAsync(2);
    expect(settled).toEqual({
      success: true,
      sessionBacked: true,
      license: { license_type: "individual", ai_detection_enabled: false, organization_id: null },
    });
  });
});
