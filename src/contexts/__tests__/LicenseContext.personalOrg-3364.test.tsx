/**
 * BACKLOG-3364 — the renderer's end of the personal-organization contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE CAN AND CANNOT SEE — read before counting it as a control.
 * ---------------------------------------------------------------------------
 * It mocks the `licenseService` bridge, so NO main-process change can red it.
 * Reverting the `!is_personal` guard in `electron/handlers/licenseHandlers.ts`
 * leaves every test here green, because this file supplies the handler's answer
 * rather than computing it. That is measured, not assumed, and it is stated
 * here so nobody reads this suite as the guard on D1. The guard on D1 is
 * `electron/handlers/__tests__/licenseHandlers.personalOrg-3364.test.ts`.
 *
 * What this suite IS for is the other half of the same contract, which no
 * main-process suite reaches: that the answer a personal-organization user now
 * gets — `individual`, no organization id — survives BOTH writers of
 * `licenseType` and still routes Complete to Export.
 *
 * That matters because there are two of them, and they disagree by
 * construction. `validateLicense` writes `licenseType` from the licence row;
 * `fetchLicense` writes it from `license:get`, and the focus listener calls
 * ONLY `fetchLicense` (LicenseContext.tsx — "Skip validateLicense on focus").
 * So a solo user who leaves the app and comes back has their licence class
 * re-decided by `license:get` alone. If that call ever answers `team` for a
 * personal organization, Complete flips to Submit on a window focus, minutes
 * after a correct start — the shape of BACKLOG-2885, and the reason this
 * assertion is made AFTER a focus event rather than only on mount.
 *
 * MUTATION RUN (counted in the PR): change the mocked `license:get` answer to
 * `team` + an organization id — i.e. what the handler would send if its guard
 * were dropped — and `resolveTarget()` becomes "submit".
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LicenseProvider, useLicense } from "../LicenseContext";
import { useCompleteTransaction } from "../../components/transactionDetailsModule/hooks/useCompleteTransaction";

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

jest.mock("@/services/exportReviewGate", () => ({
  __esModule: true,
  evaluateExportGate: jest.fn().mockResolvedValue({ allowed: true, blocked: [] }),
}));

const USER_ID = "00000000-0000-4000-8000-000000336405"; // pii-allow-uuid: invented fixture id
const BROKERAGE_ORG_ID = "00000000-0000-4000-8000-0000003364c3"; // pii-allow-uuid: invented fixture id

/**
 * What `license:get` sends for a user whose ONLY membership is their own
 * personal organization: the fall-through answer, byte-for-byte what a user
 * with no membership row at all receives.
 */
const PERSONAL_ORG_ANSWER = {
  success: true,
  data: {
    license_type: "individual" as const,
    ai_detection_enabled: false,
    organization_id: undefined,
    sessionBacked: true,
  },
};

/** What it sends for a real brokerage member — the contrast. */
const BROKERAGE_ANSWER = {
  success: true,
  data: {
    license_type: "team" as const,
    ai_detection_enabled: false,
    organization_id: BROKERAGE_ORG_ID,
    organization_name: "A Real Brokerage",
    sessionBacked: true,
  },
};

const INDIVIDUAL_VALIDATION = {
  success: true,
  data: {
    isValid: true,
    licenseType: "individual",
    transactionCount: 0,
    transactionLimit: 10,
    canCreateTransaction: true,
    deviceCount: 1,
    deviceLimit: 3,
    aiEnabled: false,
  },
};

function Probe(): React.ReactElement {
  const { canSubmit, canExport, organizationId, licenseType, isLicenseResolved } = useLicense();
  const { resolveTarget } = useCompleteTransaction({
    transactionId: "txn-3364",
    refreshReviewState: jest.fn().mockResolvedValue(undefined),
    openExport: jest.fn(),
    openSubmit: jest.fn(),
    openNeedsReview: jest.fn(),
  });
  return (
    <div>
      <span data-testid="target">{resolveTarget()}</span>
      <span data-testid="can-submit">{String(canSubmit)}</span>
      <span data-testid="can-export">{String(canExport)}</span>
      <span data-testid="license-type">{licenseType}</span>
      <span data-testid="org">{organizationId ?? "none"}</span>
      <span data-testid="resolved">{String(isLicenseResolved)}</span>
    </div>
  );
}

const target = () => screen.getByTestId("target").textContent;

beforeEach(() => {
  jest.clearAllMocks();
  mockLicenseService.validate.mockResolvedValue(INDIVIDUAL_VALIDATION);
  mockLicenseService.create.mockResolvedValue({ success: false, data: null });
});

describe("BACKLOG-3364 — a solo user with a personal organization still exports", () => {
  it("routes Complete to Export on mount", async () => {
    mockLicenseService.get.mockResolvedValue(PERSONAL_ORG_ANSWER);

    render(
      <LicenseProvider userId={USER_ID}>
        <Probe />
      </LicenseProvider>
    );

    await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("true"));
    expect(target()).toBe("export");
    expect(screen.getByTestId("can-submit")).toHaveTextContent("false");
    expect(screen.getByTestId("can-export")).toHaveTextContent("true");
    expect(screen.getByTestId("org")).toHaveTextContent("none");
  });

  it("still routes Complete to Export after a window focus re-reads the licence", async () => {
    // The two-writer hazard. The focus listener calls fetchLicense ONLY, so
    // `license:get` alone decides the licence class from here on.
    mockLicenseService.get.mockResolvedValue(PERSONAL_ORG_ANSWER);

    render(
      <LicenseProvider userId={USER_ID}>
        <Probe />
      </LicenseProvider>
    );

    await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("true"));
    const callsBeforeFocus = mockLicenseService.get.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    // The focus really did re-ask — otherwise this test would assert nothing.
    await waitFor(() =>
      expect(mockLicenseService.get.mock.calls.length).toBeGreaterThan(callsBeforeFocus)
    );
    expect(target()).toBe("export");
    expect(screen.getByTestId("license-type")).toHaveTextContent("individual");
    expect(screen.getByTestId("can-submit")).toHaveTextContent("false");
  });

  it("a real brokerage member is still routed to Submit", async () => {
    // The contrast, so "export" above is shown to be about this answer and not
    // about the harness never producing "submit" at all.
    mockLicenseService.get.mockResolvedValue(BROKERAGE_ANSWER);
    mockLicenseService.validate.mockResolvedValue({
      ...INDIVIDUAL_VALIDATION,
      data: { ...INDIVIDUAL_VALIDATION.data, licenseType: "team" },
    });

    render(
      <LicenseProvider userId={USER_ID}>
        <Probe />
      </LicenseProvider>
    );

    await waitFor(() => expect(screen.getByTestId("resolved")).toHaveTextContent("true"));
    await waitFor(() => expect(target()).toBe("submit"));
    expect(screen.getByTestId("org")).toHaveTextContent(BROKERAGE_ORG_ID);
  });
});
