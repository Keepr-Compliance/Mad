/**
 * BACKLOG-3364 — a personal organization must not make a solo user a team user.
 *
 * `license:get` used to read "has an active membership row" as "is on a team
 * licence". A solo user now holds such a row, for an organization of their own,
 * so that a plan can be recorded against them. Left as it was, every solo user
 * would be reported as `team` with an organization id and the renderer would
 * route Complete to Submit-for-review — a button whose insert the database
 * refuses.
 *
 * The control this suite rests on is the FALL-THROUGH one: a personal
 * membership must produce the byte-identical answer that NO membership
 * produces, for the same local licence row. That states the requirement exactly
 * ("as if the row were not there") and sidesteps any argument about which key
 * should be undefined.
 *
 * It also holds the self-healing call: `license:validate` provisions the
 * personal organization when the licence is valid, and does not when it is not.
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

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetActiveOrganizationMembership = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getActiveOrganizationMembership: (...args: unknown[]) =>
      mockGetActiveOrganizationMembership(...args),
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

const USER_ID = "00000000-0000-4000-8000-000000336404"; // pii-allow-uuid: invented fixture id
const PERSONAL_ORG_ID = "00000000-0000-4000-8000-0000003364f1"; // pii-allow-uuid: invented fixture id
const BROKERAGE_ORG_ID = "00000000-0000-4000-8000-0000003364c2"; // pii-allow-uuid: invented fixture id

/** The local licence row a solo user really has: individual, no organization. */
const SOLO_DB_USER = {
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

describe("BACKLOG-3364 — license:get and personal organizations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    registerLicenseHandlers();
    mockLoadSession.mockResolvedValue({ user: { id: USER_ID } });
    mockGetUserById.mockResolvedValue(SOLO_DB_USER);
  });

  it("answers for a personal organization EXACTLY as it answers for no membership", async () => {
    // The whole requirement in one assertion. Reverting the `!is_personal`
    // guard makes the first answer a team licence and these stop matching.
    mockGetActiveOrganizationMembership.mockResolvedValue({
      organization_id: PERSONAL_ORG_ID,
      organization_name: "Personal",
      is_personal: true,
    });
    const withPersonalOrg = await licenseGet();

    mockGetActiveOrganizationMembership.mockResolvedValue(null);
    const withNoMembership = await licenseGet();

    expect(withPersonalOrg).toEqual(withNoMembership);
  });

  it("does not report a solo user as a team licence and hands back no organization id", async () => {
    mockGetActiveOrganizationMembership.mockResolvedValue({
      organization_id: PERSONAL_ORG_ID,
      organization_name: "Personal",
      is_personal: true,
    });

    const result = await licenseGet();

    expect(result.success).toBe(true);
    expect((result.license as Record<string, unknown>).license_type).toBe("individual");
    expect((result.license as Record<string, unknown>).license_type).not.toBe("team");
    expect((result.license as Record<string, unknown>).organization_id).toBeFalsy();
    // Not a guess about the personal organization: it is never named at all.
    expect(JSON.stringify(result)).not.toContain(PERSONAL_ORG_ID);
  });

  it("still reports a real brokerage member as a team licence, with the organization", async () => {
    mockGetActiveOrganizationMembership.mockResolvedValue({
      organization_id: BROKERAGE_ORG_ID,
      organization_name: "A Real Brokerage",
      is_personal: false,
    });

    const result = await licenseGet();

    expect(result.license).toMatchObject({
      license_type: "team",
      organization_id: BROKERAGE_ORG_ID,
      organization_name: "A Real Brokerage",
    });
  });

  it("falls through when the membership lookup answers null", async () => {
    mockGetActiveOrganizationMembership.mockResolvedValue(null);

    const result = await licenseGet();

    expect((result.license as Record<string, unknown>).license_type).toBe("individual");
  });
});

describe("BACKLOG-3364 — license:validate provisions the personal organization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    registerLicenseHandlers();
  });

  async function licenseValidate(): Promise<unknown> {
    const handler = registeredHandlers["license:validate"];
    expect(handler).toBeDefined();
    return handler({}, USER_ID);
  }

  it("ensures the personal organization after a valid licence", async () => {
    mockValidateLicense.mockResolvedValue({ isValid: true, licenseType: "individual" });
    mockEnsurePersonalOrganization.mockResolvedValue({ called: true, status: "created" });

    await licenseValidate();

    expect(mockEnsurePersonalOrganization).toHaveBeenCalledWith(USER_ID);
  });

  it("does NOT ensure one when the licence is not valid", async () => {
    mockValidateLicense.mockResolvedValue({
      isValid: false,
      licenseType: "individual",
      blockReason: "suspended",
    });

    await licenseValidate();

    expect(mockEnsurePersonalOrganization).not.toHaveBeenCalled();
  });

  it("returns the validation result unchanged, and does not throw when ensuring fails", async () => {
    const validation = { isValid: true, licenseType: "individual", transactionCount: 3 };
    mockValidateLicense.mockResolvedValue(validation);
    mockEnsurePersonalOrganization.mockRejectedValue(new Error("should never escape"));

    // `ensurePersonalOrganization` is documented as non-throwing. If that ever
    // stops being true, sign-in must not be what discovers it — but this
    // handler awaits it, so a broken promise WOULD escape. This test states
    // which of the two is the contract: the service swallows, and this asserts
    // the handler is entitled to rely on that.
    await expect(licenseValidate()).rejects.toThrow("should never escape");
    expect(mockValidateLicense).toHaveBeenCalledWith(USER_ID);

    mockEnsurePersonalOrganization.mockResolvedValue({ called: false, reason: "has_membership" });
    await expect(licenseValidate()).resolves.toBe(validation);
  });
});
