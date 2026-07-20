/**
 * Tests for LicenseContext — BACKLOG-2148 fail-open regression coverage.
 *
 * Focus: a TRANSIENT license-validation failure (licenseService.validate throwing,
 * or an IPC / network / DB-init race) must NOT gate an authenticated user with the
 * false "Trial Expired / Upgrade" screen (ELECTRON-1Z). The provider's catch fallback
 * must fail OPEN — isValid:true with the soft, non-blocking 'load_error' reason — and
 * must NOT force trial-license creation (which keys on blockReason === 'no_license').
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LicenseProvider, useLicense } from "../LicenseContext";

// Mock the license service (window.api abstraction).
const mockLicenseService = {
  get: jest.fn(),
  validate: jest.fn(),
  create: jest.fn(),
};

jest.mock("../../services", () => ({
  __esModule: true,
  licenseService: mockLicenseService,
}));

// Mock useFeatureGate — plan features are a separate concern here; keep it fail-open.
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

// Silence the logger.
jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function LicenseConsumer(): React.ReactElement {
  const { isValid, blockReason, licenseType } = useLicense();
  return (
    <div>
      <span data-testid="is-valid">{String(isValid)}</span>
      <span data-testid="block-reason">{blockReason ?? "none"}</span>
      <span data-testid="license-type">{licenseType}</span>
    </div>
  );
}

describe("LicenseContext — BACKLOG-2148 fail-open on transient validation failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // get() is called on mount; return an empty/failed result so it uses defaults.
    mockLicenseService.get.mockResolvedValue({ success: false, data: null });
  });

  it("fails OPEN (isValid, load_error) when validate throws for an authenticated user", async () => {
    // Transient failure — the IPC/service call rejects.
    mockLicenseService.validate.mockRejectedValue(new Error("IPC transport error"));

    render(
      <LicenseProvider userId="user-123">
        <LicenseConsumer />
      </LicenseProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-valid").textContent).toBe("true");
    });

    // Not gated: the LicenseGate renders children whenever isValid is true.
    expect(screen.getByTestId("is-valid").textContent).toBe("true");
    expect(screen.getByTestId("block-reason").textContent).toBe("load_error");
    // Neutral, non-trial type — no false "trial" banner.
    expect(screen.getByTestId("license-type").textContent).toBe("individual");
  });

  it("does NOT force trial-license creation on the transient-failure path", async () => {
    mockLicenseService.validate.mockRejectedValue(new Error("IPC transport error"));

    render(
      <LicenseProvider userId="user-123">
        <LicenseConsumer />
      </LicenseProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-valid").textContent).toBe("true");
    });

    // create() is only called on the no_license path — a transient error must not
    // trigger it (blockReason is 'load_error', not 'no_license').
    expect(mockLicenseService.create).not.toHaveBeenCalled();
  });

  it("still honors a server-returned terminal block (suspended stays gated)", async () => {
    // A definitively-blocked account returned by the service is NOT failed-open.
    mockLicenseService.validate.mockResolvedValue({
      success: true,
      data: {
        isValid: false,
        licenseType: "individual",
        transactionCount: 0,
        transactionLimit: 0,
        canCreateTransaction: false,
        deviceCount: 1,
        deviceLimit: 2,
        aiEnabled: false,
        blockReason: "suspended",
      },
    });

    render(
      <LicenseProvider userId="user-123">
        <LicenseConsumer />
      </LicenseProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("block-reason").textContent).toBe("suspended");
    });

    expect(screen.getByTestId("is-valid").textContent).toBe("false");
    expect(mockLicenseService.create).not.toHaveBeenCalled();
  });
});
