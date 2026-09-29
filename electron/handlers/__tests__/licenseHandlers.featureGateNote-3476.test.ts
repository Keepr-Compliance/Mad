/**
 * BACKLOG-3476 — `license:get` tells the feature-gate cache what membership it
 * found, so an organization change it sees drops the strict reader's cached
 * membership. The reconciliation itself is proven in
 * featureGateHandlers.orgCache-3476 (K8); this proves the licence reader calls it.
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

jest.mock("../../services/db/userDbService", () => ({
  getUserById: jest.fn().mockResolvedValue(null),
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

const mockNoteMembership = jest.fn();
jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: { noteMembership: (...args: unknown[]) => mockNoteMembership(...args) },
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

const USER_ID = "00000000-0000-4000-8000-000000347602"; // pii-allow-uuid: invented fixture id
const ORG_ID = "00000000-0000-4000-8000-0000003476c0"; // pii-allow-uuid: invented fixture id

async function invoke(channel: string): Promise<void> {
  const handler = registeredHandlers[channel];
  expect(handler).toBeDefined();
  await handler({});
}

describe("BACKLOG-3476 — license:get / license:refresh report the membership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(registeredHandlers)) delete registeredHandlers[key];
    registerLicenseHandlers();
    mockLoadSession.mockResolvedValue({ user: { id: USER_ID } });
  });

  it.each(["license:get", "license:refresh"])("%s reports the org it found", async (channel) => {
    mockGetActiveOrganizationMembership.mockResolvedValue({
      organization_id: ORG_ID,
      organization_name: "Fixture",
      is_personal: false,
    });
    await invoke(channel);
    expect(mockNoteMembership).toHaveBeenCalledWith(USER_ID, ORG_ID);
  });

  it("reports null when there is no membership", async () => {
    mockGetActiveOrganizationMembership.mockResolvedValue(null);
    await invoke("license:get");
    expect(mockNoteMembership).toHaveBeenCalledWith(USER_ID, null);
  });
});
