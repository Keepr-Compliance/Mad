/**
 * BACKLOG-2888 control (c) — the renderer half.
 *
 * The handler fix makes `license:get` answer the `sessionBacked: false`
 * placeholder when it could not find out (signed-out client, failed membership
 * lookup). That only helps if the renderer treats the placeholder as "not yet
 * known" and re-asks, so that a brokerage user's Complete ends up at Submit for
 * Review and never at a local export.
 *
 * This runs the real chain below the IPC boundary: `window.api.license.get` ->
 * `licenseService.get` (the `sessionBacked` mapping) -> `LicenseProvider`
 * (the bounded re-ask) -> `useCompleteTransaction.resolveTarget`.
 *
 * Fixtures are the two answers `readLicenseData` emits, by shape:
 *   - the placeholder: `electron/handlers/licenseHandlers.ts` no-session branch
 *     (`success: true, sessionBacked: false, license: { individual, false, undefined }`);
 *   - a brokerage member: the team branch
 *     (`success: true, sessionBacked: true, license: { team, ai, organization_id, organization_name }`).
 *
 * This test does not depend on the handler change; it is expected to be green
 * both before and after it.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LicenseProvider } from "@/contexts/LicenseContext";
import { useCompleteTransaction } from "../useCompleteTransaction";

jest.mock("../../../../hooks/useFeatureGate", () => ({
  __esModule: true,
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const PLACEHOLDER = {
  success: true,
  sessionBacked: false,
  license: {
    license_type: "individual",
    ai_detection_enabled: false,
    organization_id: undefined,
  },
};

const TEAM_WITH_ORG = {
  success: true,
  sessionBacked: true,
  license: {
    license_type: "team",
    ai_detection_enabled: false,
    organization_id: "org-2888",
    organization_name: "A Brokerage",
  },
};

const VALIDATION = {
  isValid: true,
  licenseType: "team",
  transactionCount: 0,
  transactionLimit: 100,
  canCreateTransaction: true,
  deviceCount: 1,
  deviceLimit: 3,
  aiEnabled: false,
};

const mockGet = jest.fn();
const seenTargets: string[] = [];

function Probe(): React.ReactElement {
  const { resolveTarget } = useCompleteTransaction({
    transactionId: "tx-2888",
    refreshReviewState: jest.fn().mockResolvedValue({ items: [], count: 0 }),
    openExport: jest.fn(),
    openSubmit: jest.fn(),
    openNeedsReview: jest.fn(),
  });
  const target = resolveTarget();
  seenTargets.push(target);
  return <span data-testid="target">{target}</span>;
}

beforeEach(() => {
  jest.clearAllMocks();
  seenTargets.length = 0;
  (window as unknown as { api: unknown }).api = {
    license: {
      get: (...a: unknown[]) => mockGet(...a),
      refresh: jest.fn(),
      validate: jest.fn().mockResolvedValue(VALIDATION),
      create: jest.fn().mockResolvedValue(VALIDATION),
    },
  };
});

describe("BACKLOG-2888 — placeholder first, team second: Complete resolves to submit", () => {
  it("never resolves to export, and lands on submit once the team answer arrives", async () => {
    mockGet.mockResolvedValueOnce(PLACEHOLDER).mockResolvedValue(TEAM_WITH_ORG);

    render(
      <LicenseProvider userId="user-2888">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("target")).toHaveTextContent("submit"), {
      timeout: 3000,
    });

    // It really did see the placeholder first and asked again.
    expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(seenTargets).toContain("unknown");
    expect(seenTargets).not.toContain("export");
  });
});
