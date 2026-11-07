/**
 * BACKLOG-3951 — LicenseContext exposes the membership standing for the
 * CURRENT user only, and an answer that failed or was not session-backed
 * exposes nothing (unknown ≠ known).
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
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

const VALIDATION = {
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

function answer(extra: Record<string, unknown> = {}, sessionBacked = true) {
  return {
    success: true,
    data: {
      license_type: "individual" as const,
      ai_detection_enabled: false,
      organization_id: undefined,
      sessionBacked,
      ...extra,
    },
  };
}

function Probe(): React.ReactElement {
  const { membershipStanding, membershipOrgName, membershipOrgId } = useLicense();
  return (
    <div>
      <span data-testid="standing">{membershipStanding ?? "unknown-to-ui"}</span>
      <span data-testid="org-name">{membershipOrgName ?? "-"}</span>
      <span data-testid="org-id">{membershipOrgId ?? "-"}</span>
    </div>
  );
}

const standing = () => screen.getByTestId("standing").textContent;

beforeEach(() => {
  jest.clearAllMocks();
  mockLicenseService.validate.mockResolvedValue(VALIDATION);
});

it("exposes the standing main reported, with the brokerage name", async () => {
  mockLicenseService.get.mockResolvedValue(
    answer({
      membershipStanding: "left_brokerage",
      membershipOrgName: "Fixture Brokerage",
      membershipOrgId: "fixture-org-a",
    }),
  );
  render(
    <LicenseProvider userId="u1">
      <Probe />
    </LicenseProvider>,
  );
  await waitFor(() => expect(standing()).toBe("left_brokerage"));
  expect(screen.getByTestId("org-name")).toHaveTextContent("Fixture Brokerage");
  expect(screen.getByTestId("org-id")).toHaveTextContent("fixture-org-a");
});

it("a failed license read exposes no standing", async () => {
  mockLicenseService.get.mockRejectedValue(new Error("boom"));
  render(
    <LicenseProvider userId="u1">
      <Probe />
    </LicenseProvider>,
  );
  await waitFor(() => expect(mockLicenseService.get).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(standing()).toBe("unknown-to-ui");
});

it("a no-session answer (sessionBacked false) exposes no standing", async () => {
  mockLicenseService.get.mockResolvedValue(answer({ membershipStanding: "unlicensed" }, false));
  render(
    <LicenseProvider userId="u1">
      <Probe />
    </LicenseProvider>,
  );
  await waitFor(() => expect(mockLicenseService.get).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(standing()).toBe("unknown-to-ui");
});

it("a user switch hides the previous user's standing until the new answer lands", async () => {
  mockLicenseService.get.mockResolvedValueOnce(answer({ membershipStanding: "unlicensed" }));
  let resolveSecond: (v: unknown) => void = () => undefined;
  mockLicenseService.get.mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
  const { rerender } = render(
    <LicenseProvider userId="u1">
      <Probe />
    </LicenseProvider>,
  );
  await waitFor(() => expect(standing()).toBe("unlicensed"));
  rerender(
    <LicenseProvider userId="u2">
      <Probe />
    </LicenseProvider>,
  );
  expect(standing()).toBe("unknown-to-ui");
  await act(async () => {
    resolveSecond(answer({ membershipStanding: "none" }));
  });
  await waitFor(() => expect(standing()).toBe("none"));
});
