/**
 * BACKLOG-2885 residual 2 — `validateLicense` must not move the license class
 * out from under a user who has been told it is settled.
 *
 * TWO WRITERS, ONE FIELD, DIFFERENT SOURCES — traced, and live in the data:
 *
 *   `fetchLicense`  → `license:get`      → `getActiveOrganizationMembership`
 *                                          (Supabase org membership).
 *                                          Sets licenseType AND organizationId.
 *                                          When an org membership exists it
 *                                          HARDCODES `license_type: "team"`.
 *   `validateLicense` → `license:validate` → `calculateLicenseStatus`, which
 *                                          reads `licenses.license_type`
 *                                          (`electron/services/licenseService.ts:182`).
 *                                          Sets licenseType, NEVER organizationId.
 *
 * `canSubmit` is `licenseType === "team" || "enterprise"`, so the second writer
 * can silently revoke what the first granted — with `organizationId` left set,
 * producing a pair that contradicts itself.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * Which writer SHOULD win decides who can submit for review, and that is a
 * product decision, not an implementation detail — so it is not encoded here.
 * (The live `licenses`/`organization_members` data shows the two disagree for
 * real org members today; that is on the backlog item for the founder.)
 *
 * What IS assertable without deciding it: a user must never be shown a settled
 * license that is still moving. `isLicenseResolved` therefore requires BOTH
 * writers to have landed for the current user. Complete is disabled until then,
 * so no one can act on a value about to change — which is the entire defect
 * this item exists to remove, whichever value turns out to be right.
 *
 * MUTATION RUN (count in the PR): drop the `validatedForUserId` term from
 * `isLicenseResolved`.
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

/** `license:get` for an org member: team, with the organization. */
const ORG_MEMBER_GET = {
  success: true,
  data: {
    license_type: "team" as const,
    ai_detection_enabled: false,
    organization_id: "org-2885",
    organization_name: "Bellweather Realty",
    sessionBacked: true,
  },
};

/**
 * `license:validate` disagreeing. Transcribed from a real row shape, not
 * invented: of the active `organization_members` in the live database, one has
 * `licenses.license_type = 'individual'` and one has no `licenses` row at all
 * (which `validateLicense` turns into a created trial). Both produce a
 * non-"team" answer for a genuine org member.
 */
const VALIDATE_DISAGREES = {
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

/** Records every (resolved, canSubmit) the provider ever renders. */
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

const org = () => screen.getByTestId("org").textContent;
const resolved = () => screen.getByTestId("resolved").textContent;

beforeEach(() => {
  jest.clearAllMocks();
  renders.length = 0;
  mockLicenseService.create.mockResolvedValue({ success: false, data: null });
});

describe("BACKLOG-2885 — the license is not 'settled' until both writers have landed", () => {
  it("stays UNRESOLVED while validateLicense is still in flight, even though the fetch has landed", async () => {
    mockLicenseService.get.mockResolvedValue(ORG_MEMBER_GET);

    let releaseValidate: (v: unknown) => void = () => undefined;
    const heldValidate = new Promise((res) => {
      releaseValidate = res;
    });
    mockLicenseService.validate.mockReturnValue(heldValidate);

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    // The fetch has landed — organization and team license are both in state.
    await waitFor(() => expect(org()).toBe("org-2885"));

    // But the OTHER writer has not spoken, and it can still change canSubmit.
    // Declaring "known" here is what let a user act on a value about to move.
    expect(resolved()).toBe("false");

    await act(async () => {
      releaseValidate(VALIDATE_DISAGREES);
      await heldValidate;
    });

    await waitFor(() => expect(resolved()).toBe("true"));
  });

  it("canSubmit never changes value once the license has been reported as settled", async () => {
    // The property that matters regardless of which writer is CORRECT: after
    // the UI says "known", the answer holds still. Whichever value it settles
    // on, nobody is routed on a value that then flips.
    // The validate is HELD, so the boundary between "in flight" and "landed" is
    // deterministic. With a fast validate the two writes collapse into one
    // render batch and this case cannot separate pass from fail — it passed
    // under the mutation it exists to catch until the hold was added.
    mockLicenseService.get.mockResolvedValue(ORG_MEMBER_GET);
    let releaseValidate: (v: unknown) => void = () => undefined;
    const heldValidate = new Promise((res) => {
      releaseValidate = res;
    });
    mockLicenseService.validate.mockReturnValue(heldValidate);

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    // Fetch has landed and says team+org; canSubmit is true right now.
    await waitFor(() => expect(org()).toBe("org-2885"));

    await act(async () => {
      releaseValidate(VALIDATE_DISAGREES);
      await heldValidate;
    });

    await waitFor(() => expect(resolved()).toBe("true"));

    const settled = renders.filter((r) => r.resolved);
    expect(settled.length).toBeGreaterThan(0);
    const distinct = new Set(settled.map((r) => r.canSubmit));
    expect(distinct.size).toBe(1);
  });

  it("organizationId survives whatever validateLicense writes", async () => {
    // validateLicense sets licenseType and never touches organizationId. If a
    // future edit ever spread a validation result over the organization, the
    // brokerage user would lose their submit route silently — the org is the
    // half of the pair that only ONE writer owns.
    mockLicenseService.get.mockResolvedValue(ORG_MEMBER_GET);
    mockLicenseService.validate.mockResolvedValue(VALIDATE_DISAGREES);

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolved()).toBe("true"));
    expect(org()).toBe("org-2885");
    // And it was never transiently dropped on the way there.
    expect(renders.some((r) => r.org === "org-2885")).toBe(true);
    const afterOrgArrived = renders.slice(
      renders.findIndex((r) => r.org === "org-2885"),
    );
    expect(afterOrgArrived.every((r) => r.org === "org-2885")).toBe(true);
  });

  it("a validation FAILURE still settles the license rather than holding it unknown", async () => {
    // Same hazard as a failed fetch: Complete is disabled while unresolved, so
    // a validation that throws must not leave the button dead.
    mockLicenseService.get.mockResolvedValue(ORG_MEMBER_GET);
    mockLicenseService.validate.mockRejectedValue(new Error("IPC down"));

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolved()).toBe("true"));
    expect(org()).toBe("org-2885");
  });
});
