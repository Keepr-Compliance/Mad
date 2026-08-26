/**
 * BACKLOG-2885 residual 1 — the deferred-DB deep-link path.
 *
 * THE PATH, traced rather than assumed:
 *
 *   A cold launch driven by a `keepr://` deep link, with the database not yet
 *   initialized. `electron/main.ts` reaches the `else` branch of its session
 *   block — "Database not initialized, storing pending user" — which calls
 *   `setPendingDeepLinkUser` and DOES NOT save a session. It then sends
 *   `auth:deep-link-callback` to the renderer, which calls `login()` and sets
 *   `userId`. The session is written later, by `persistSessionForUser`
 *   (`electron/handlers/systemHandlers.ts:192-235`, added by BACKLOG-2173b),
 *   after DB init — and that function LOGS AND EMITS NOTHING.
 *
 *   So there is a window where `userId` is set and the main process has no
 *   session. `license:get` answers it with the no-session default: `success:
 *   true, individual, no organization`. Keying resolution on `userId` alone
 *   stamps that as the user's license, and a brokerage user reads as an
 *   individual — the original defect, on this path only.
 *
 * THE SIGNAL. No event announces the persist, so nothing can be subscribed to.
 * What CAN be known is whether a given answer came from a loaded session, and
 * only `getLicenseData()` knows that, because only it called `loadSession()`.
 * It now reports it as `sessionBacked`. That is the fact itself, not a
 * correlate: `userId` correlates with a session and is wrong on exactly this
 * path.
 *
 * NO FOCUS EVENT IS DISPATCHED IN THIS FILE.
 *
 * MUTATION RUN (count in the PR): drop the `sessionBacked` term from
 * `fetchLicense`'s usability check.
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

/** What `getLicenseData()` returns while `loadSession()` still finds nothing. */
const NO_SESSION_YET = {
  success: true,
  data: {
    license_type: "individual" as const,
    ai_detection_enabled: false,
    organization_id: undefined,
    sessionBacked: false,
  },
};

/** The same call once `persistSessionForUser` has run and the session loads. */
const SESSION_BACKED_BROKERAGE = {
  success: true,
  data: {
    license_type: "team" as const,
    ai_detection_enabled: false,
    organization_id: "org-2885",
    organization_name: "Bellweather Realty",
    sessionBacked: true,
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

/**
 * Mirrors the provider's wait budget. Kept as literals rather than imported so
 * the test states what it expects of the contract; if the provider's numbers
 * change, the bounded-wait case fails loudly instead of silently passing on a
 * different schedule.
 */
const SESSION_WAIT_MS = 300;
const SESSION_WAIT_ATTEMPTS = 20;

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

describe("BACKLOG-2885 — a signed-in user with no main-process session yet", () => {
  it("does NOT record the no-session default as the user's license, and picks up the real one", async () => {
    // The deep-link callback has already set userId; the session lands on the
    // second ask, as it does when persistSessionForUser runs after DB init.
    mockLicenseService.get
      .mockResolvedValueOnce(NO_SESSION_YET)
      .mockResolvedValue(SESSION_BACKED_BROKERAGE);

    render(
      <LicenseProvider userId="user-2885">
        <Probe />
      </LicenseProvider>,
    );

    // The placeholder landed. It must NOT count as an answer about this user —
    // this is the assertion that fails against the pushed code, which stamped it
    // resolved and left Complete routing a brokerage user to a local export.
    await waitFor(() => expect(screen.getByTestId("is-loading")).toHaveTextContent("false"));
    expect(resolved()).toBe("false");
    expect(org()).toBe("none");

    // The session is persisted; the next ask carries it.
    await waitFor(() => expect(org()).toBe("org-2885"), { timeout: 3000 });
    expect(resolved()).toBe("true");
    expect(screen.getByTestId("can-submit")).toHaveTextContent("true");
  });

  it("gives up after a bounded wait, so Complete is never dead forever", async () => {
    // If the session never arrives, holding the UI unresolved would leave
    // Complete permanently disabled — worse than the bug being fixed. The
    // answer is accepted as-is once the wait is exhausted.
    jest.useFakeTimers();
    try {
      mockLicenseService.get.mockResolvedValue(NO_SESSION_YET);

      render(
        <LicenseProvider userId="user-2885">
          <Probe />
        </LicenseProvider>,
      );

      // One act per attempt. A single long advance does NOT work: React defers
      // effect flushing until act exits, so the effect that arms the NEXT timer
      // never runs and exactly one attempt fires — which is also how the ref-vs-
      // state bug in the retry loop was found.
      for (let i = 0; i < SESSION_WAIT_ATTEMPTS + 5; i += 1) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(SESSION_WAIT_MS);
        });
      }

      expect(resolved()).toBe("true");
      expect(org()).toBe("none");
      // It really did keep asking, rather than resolving because it gave up on
      // the first attempt.
      expect(mockLicenseService.get.mock.calls.length).toBeGreaterThan(SESSION_WAIT_ATTEMPTS);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a SIGNED-OUT user's no-session answer is a real answer, not a placeholder", async () => {
    // With no user there is nothing to be wrong about: "individual, no
    // organization" is correct, and must resolve immediately rather than
    // spinning the retry.
    mockLicenseService.get.mockResolvedValue(NO_SESSION_YET);

    render(
      <LicenseProvider userId={null}>
        <Probe />
      </LicenseProvider>,
    );

    await waitFor(() => expect(resolved()).toBe("true"));
    expect(org()).toBe("none");
    expect(mockLicenseService.get).toHaveBeenCalledTimes(1);
  });
});
