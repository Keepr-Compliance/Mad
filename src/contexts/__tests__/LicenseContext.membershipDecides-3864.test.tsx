/**
 * BACKLOG-3864 — the org MEMBERSHIP decides `licenseType`; `license:validate`
 * does not.
 *
 * Before 3864 there were two writers of `licenseType`: `fetchLicense`
 * (`license:get`, the org membership) and `validateLicense` (`license:validate`,
 * the Supabase `licenses.license_type` column). Whichever network call landed
 * last won. A brokerage member whose licenses row said `individual` lost
 * Submit; a personal user whose row said `team` read as a team license.
 *
 * Both arrival orders are pinned with explicit delays. An immediate
 * `mockResolvedValue` fixes the order (validate lands last), and with the
 * opposite order the old code happens to pass — so one order alone cannot
 * tell the fix from the bug.
 *
 * Fixtures copied from `LicenseContext.validatePairing-2885.test.tsx`, whose
 * `license:validate` shape was transcribed from live rows; identifiers here are
 * placeholders.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LicenseProvider, useLicense } from "../LicenseContext";

jest.mock("../../services", () => ({
  __esModule: true,
  licenseService: { get: jest.fn(), validate: jest.fn(), create: jest.fn() },
}));

const mockLicenseService = (
  jest.requireMock("../../services") as {
    licenseService: { get: jest.Mock; validate: jest.Mock; create: jest.Mock };
  }
).licenseService;

jest.mock("../../hooks/useFeatureGate", () => ({
  __esModule: true,
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const ORG_ID = "00000000-0000-0000-0000-000000000000";

/** `license:get` for an org member: team, with the organization. */
const ORG_MEMBER_GET = {
  success: true,
  data: {
    license_type: "team" as const,
    ai_detection_enabled: false,
    organization_id: ORG_ID,
    organization_name: "Example Realty",
    sessionBacked: true,
  },
};

/** `license:get` for a user with no org membership. */
const PERSONAL_GET = {
  success: true,
  data: {
    license_type: "individual" as const,
    ai_detection_enabled: false,
    organization_id: undefined,
    sessionBacked: true,
  },
};

/** `license:validate` saying `individual` (licenses.license_type = 'individual'). */
const VALIDATE_INDIVIDUAL = {
  success: true,
  data: {
    isValid: true,
    licenseType: "individual" as const,
    transactionCount: 0,
    transactionLimit: 100,
    canCreateTransaction: true,
    deviceCount: 1,
    deviceLimit: 3,
    aiEnabled: false,
  },
};

/** `license:validate` saying `team` (licenses.license_type = 'team'). */
const VALIDATE_TEAM = {
  ...VALIDATE_INDIVIDUAL,
  data: { ...VALIDATE_INDIVIDUAL.data, licenseType: "team" as const },
};

/** Records every (resolved, canSubmit, org) the provider ever renders. */
const renders: { resolved: boolean; canSubmit: boolean; org: string | null }[] = [];

function Probe(): React.ReactElement {
  const { organizationId, canSubmit, isLicenseResolved } = useLicense();
  renders.push({ resolved: isLicenseResolved, canSubmit, org: organizationId });
  return (
    <div>
      <span data-testid="org">{organizationId ?? "none"}</span>
      <span data-testid="can-submit">{String(canSubmit)}</span>
      <span data-testid="resolved">{String(isLicenseResolved)}</span>
    </div>
  );
}

const canSubmitText = () => screen.getByTestId("can-submit").textContent;
const resolvedText = () => screen.getByTestId("resolved").textContent;

/** A mock implementation that resolves `value` after `ms` milliseconds. */
const after =
  <T,>(value: T, ms: number) =>
  () =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

const EARLY_MS = 5;
const LATE_MS = 80;

beforeEach(() => {
  jest.clearAllMocks();
  renders.length = 0;
  mockLicenseService.create.mockResolvedValue({ success: false, data: null });
});

describe("BACKLOG-3864 — brokerage member, licenses row says individual", () => {
  it("validate lands first, get lands last: Submit stays on, never resolved-false", async () => {
    mockLicenseService.get.mockImplementation(after(ORG_MEMBER_GET, LATE_MS));
    mockLicenseService.validate.mockImplementation(after(VALIDATE_INDIVIDUAL, EARLY_MS));

    render(
      <LicenseProvider userId="user-3864-a">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolvedText()).toBe("true"));
    expect(mockLicenseService.get).toHaveBeenCalled();
    expect(mockLicenseService.validate).toHaveBeenCalled();
    expect(canSubmitText()).toBe("true");
    expect(screen.getByTestId("org").textContent).toBe(ORG_ID);
    expect(renders.filter((r) => r.resolved && !r.canSubmit)).toEqual([]);
  });

  it("get lands first, validate lands last: Submit stays on, never resolved-false", async () => {
    mockLicenseService.get.mockImplementation(after(ORG_MEMBER_GET, EARLY_MS));
    mockLicenseService.validate.mockImplementation(after(VALIDATE_INDIVIDUAL, LATE_MS));

    render(
      <LicenseProvider userId="user-3864-b">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolvedText()).toBe("true"));
    expect(mockLicenseService.validate).toHaveBeenCalled();
    // Let anything still queued settle, then re-check the final state.
    await new Promise((r) => setTimeout(r, LATE_MS));
    expect(canSubmitText()).toBe("true");
    expect(screen.getByTestId("org").textContent).toBe(ORG_ID);
    expect(renders.filter((r) => r.resolved && !r.canSubmit)).toEqual([]);
  });
});

describe("BACKLOG-3864 — personal user, licenses row says team", () => {
  it("validate lands first, get lands last: Submit stays off", async () => {
    mockLicenseService.get.mockImplementation(after(PERSONAL_GET, LATE_MS));
    mockLicenseService.validate.mockImplementation(after(VALIDATE_TEAM, EARLY_MS));

    render(
      <LicenseProvider userId="user-3864-c">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolvedText()).toBe("true"));
    expect(mockLicenseService.validate).toHaveBeenCalled();
    expect(canSubmitText()).toBe("false");
    expect(renders.filter((r) => r.resolved && r.canSubmit)).toEqual([]);
  });

  it("get lands first, validate lands last: Submit stays off", async () => {
    mockLicenseService.get.mockImplementation(after(PERSONAL_GET, EARLY_MS));
    mockLicenseService.validate.mockImplementation(after(VALIDATE_TEAM, LATE_MS));

    render(
      <LicenseProvider userId="user-3864-d">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolvedText()).toBe("true"));
    expect(mockLicenseService.validate).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, LATE_MS));
    expect(canSubmitText()).toBe("false");
    expect(renders.filter((r) => r.resolved && r.canSubmit)).toEqual([]);
  });
});
