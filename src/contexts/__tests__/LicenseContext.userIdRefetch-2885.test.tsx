/**
 * BACKLOG-2885 — the license is re-read when the user signs in, and the screen
 * can tell "not read yet" from "read, and you are an individual".
 *
 * WHAT WAS BROKEN, traced rather than assumed:
 *
 *   `electron/handlers/licenseHandlers.ts:44` answers a license request made
 *   before any session has loaded with `success: true, license_type:
 *   "individual", organization_id: undefined`. That is a POSITIVE answer, not an
 *   error, and from the renderer it is byte-identical to a real individual.
 *
 *   `LicenseProvider` mounts above `AuthProvider`'s session check, so its mount
 *   fetch routinely got that answer and recorded it with `isLoading: false`.
 *   `fetchLicense` had `[]` deps and a single mount effect, so nothing re-read
 *   the license when the user then signed in — and `validateLicense`, which DOES
 *   run on sign-in, sets `licenseType` but never `organizationId`.
 *
 *   The organization therefore arrived only when a window `focus` event happened
 *   to fire the silent background fetch. Until then a brokerage user read as
 *   `canSubmit: true, organizationId: null` — the shape that routed Complete to
 *   a local export.
 *
 * NO FOCUS EVENT IS DISPATCHED ANYWHERE IN THIS FILE. That is the point: if
 * these pass only because something fired `focus`, they are asserting the old
 * behaviour.
 *
 * MUTATION RUN (count in the PR): drop `currentUserId` from the fetch effect
 * (back to mount-only) → the sign-in cases redden.
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LicenseProvider, useLicense } from "../LicenseContext";

jest.mock("../../services", () => ({
  __esModule: true,
  licenseService: {
    get: jest.fn(),
    validate: jest.fn(),
    create: jest.fn(),
  },
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

/**
 * The main process's no-session answer, transcribed from `getLicenseData()`.
 * `organization_id: undefined` is what it actually sends — not null, not a
 * missing key.
 */
const PRE_SESSION_ANSWER = {
  success: true,
  data: {
    license_type: "individual" as const,
    ai_detection_enabled: false,
    organization_id: undefined,
  },
};

/** The same call once a session exists and Supabase reports org membership. */
const BROKERAGE_ANSWER = {
  success: true,
  data: {
    license_type: "team" as const,
    ai_detection_enabled: false,
    organization_id: "org-2885",
    organization_name: "Bellweather Realty",
  },
};

function Probe(): React.ReactElement {
  const { organizationId, canSubmit, isLoading, isLicenseResolved } = useLicense();
  return (
    <div>
      <span data-testid="org">{organizationId ?? "none"}</span>
      <span data-testid="can-submit">{String(canSubmit)}</span>
      <span data-testid="is-loading">{String(isLoading)}</span>
      <span data-testid="resolved">{String(isLicenseResolved)}</span>
    </div>
  );
}

const org = () => screen.getByTestId("org").textContent;
const resolved = () => screen.getByTestId("resolved").textContent;

beforeEach(() => {
  jest.clearAllMocks();
  mockLicenseService.validate.mockResolvedValue({
    success: true,
    data: {
      isValid: true,
      licenseType: "team",
      transactionCount: 0,
      transactionLimit: 100,
      canCreateTransaction: true,
      deviceCount: 1,
      deviceLimit: 3,
      aiEnabled: false,
    },
  });
  mockLicenseService.create.mockResolvedValue({ success: false, data: null });
});

describe("BACKLOG-2885 — the license is re-read on sign-in", () => {
  it("picks up the organization when userId arrives, with NO focus event", async () => {
    mockLicenseService.get
      .mockResolvedValueOnce(PRE_SESSION_ANSWER)
      .mockResolvedValueOnce(BROKERAGE_ANSWER);

    const { rerender } = render(
      <LicenseProvider userId={null}>
        <Probe />
      </LicenseProvider>,
    );

    // Signed out: the pre-session answer lands and looks exactly like an
    // individual, because that is what the main process said.
    await waitFor(() => expect(screen.getByTestId("is-loading")).toHaveTextContent("false"));
    expect(org()).toBe("none");

    // Sign in. Nothing else — no focus, no manual refresh.
    rerender(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(org()).toBe("org-2885"));
    expect(screen.getByTestId("can-submit")).toHaveTextContent("true");
    expect(mockLicenseService.get).toHaveBeenCalledTimes(2);
  });

  it("reports UNRESOLVED between sign-in and the answer landing", async () => {
    // The window the founder was in. Note `isLoading` stays FALSE across it —
    // which is precisely why a fix keyed on isLoading would have been green and
    // useless.
    let releaseSecondGet: (v: unknown) => void = () => undefined;
    const heldAnswer = new Promise((res) => {
      releaseSecondGet = res;
    });

    mockLicenseService.get
      .mockResolvedValueOnce(PRE_SESSION_ANSWER)
      .mockReturnValueOnce(heldAnswer);

    const { rerender } = render(
      <LicenseProvider userId={null}>
        <Probe />
      </LicenseProvider>,
    );
    await waitFor(() => expect(resolved()).toBe("true"));

    rerender(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    // Answer for THIS user has not arrived: unknown, and still not "loading".
    await waitFor(() => expect(resolved()).toBe("false"));
    expect(screen.getByTestId("is-loading")).toHaveTextContent("false");
    expect(org()).toBe("none");

    await act(async () => {
      releaseSecondGet(BROKERAGE_ANSWER);
      await heldAnswer;
    });

    await waitFor(() => expect(resolved()).toBe("true"));
    expect(org()).toBe("org-2885");
  });

  it("a license that FAILS to load still resolves — 'could not read' is not 'wait forever'", async () => {
    // The indefinite-disable hazard. Complete is disabled while unresolved, so a
    // failure path that never resolves would leave the button dead. Every
    // failure path must settle to the individual/export default.
    mockLicenseService.get.mockRejectedValue(new Error("IPC down"));

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolved()).toBe("true"));
    expect(org()).toBe("none");
  });

  it("a no-license answer also resolves, rather than reading as unknown", async () => {
    mockLicenseService.get.mockResolvedValue({ success: false, data: null });

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolved()).toBe("true"));
    expect(org()).toBe("none");
  });

  it("a stale in-flight answer for the PREVIOUS user cannot overwrite the current one", async () => {
    // Sign-in races the mount fetch. If the signed-out answer lands last and is
    // applied, a brokerage user is stamped an individual and — worse — stamped
    // as ANSWERED, so nothing would ever correct it.
    let releaseFirstGet: (v: unknown) => void = () => undefined;
    const heldFirst = new Promise((res) => {
      releaseFirstGet = res;
    });

    mockLicenseService.get
      .mockReturnValueOnce(heldFirst)
      .mockResolvedValueOnce(BROKERAGE_ANSWER);

    const { rerender } = render(
      <LicenseProvider userId={null}>
        <Probe />
      </LicenseProvider>,
    );

    rerender(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    // The signed-in answer lands first.
    await waitFor(() => expect(org()).toBe("org-2885"));

    // Now the signed-out one arrives late.
    await act(async () => {
      releaseFirstGet(PRE_SESSION_ANSWER);
      await heldFirst;
    });

    expect(org()).toBe("org-2885");
    expect(resolved()).toBe("true");
  });
});
