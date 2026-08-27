/**
 * BACKLOG-2885 — Complete must not CHOOSE while the license class is unknown.
 *
 * THE DEFECT. `resolveTarget` had two outcomes for three states:
 *
 *     (canSubmit && !!organizationId) ? "submit" : "export"
 *
 * Everything that was not positively a broker-org member became "export",
 * including "we do not know yet". A brokerage user who pressed Complete inside
 * that window got a LOCAL EXPORT instead of Submit for Review: they believe the
 * deal went to their broker, and the broker has nothing. The old comment called
 * that "failing closed". It is not. Failing closed means REFUSING under
 * uncertainty; substituting a different action is a distinct outcome, not a
 * safer version of the same one.
 *
 * WHICH WINDOW IS ACTUALLY REACHABLE — this is the part the filed item had
 * wrong, and it decides what the fixtures below may contain.
 *
 *   NOT `isLoading === true`. `LicenseGate.tsx:34` blocks the whole app while
 *   `isLoading && !hasInitialized`, so this screen cannot mount then; and the
 *   only post-init path to `isLoading: true` is `LicenseContext.refresh()`,
 *   which has no callers in src/ and preserves the resolved org anyway.
 *
 *   THE REACHABLE ONE is `isLoading === false` carrying a PRE-SESSION default.
 *   `electron/handlers/licenseHandlers.ts:44` answers `success: true,
 *   license_type: "individual", organization_id: undefined` when no session has
 *   loaded yet — a positive "you are an individual" that the renderer cannot
 *   tell from a real one. `LicenseProvider` mounts above auth, records that as
 *   settled, and never re-reads on login (`fetchLicense` has `[]` deps and one
 *   mount effect); `validateLicense` fills in `licenseType` but never
 *   `organizationId`. So a brokerage user sits at `canSubmit: true,
 *   organizationId: null, isLoading: false` until a window `focus` happens to
 *   fire the silent re-fetch. That is the founder's "the export button appeared
 *   when I clicked Complete".
 *
 * Hence BOTH unknown fixtures below are transcribed from real emitted states,
 * and the discriminator is `isLicenseResolved` — "an answer arrived FOR THIS
 * USER" — not `isLoading`.
 *
 * MUTATIONS RUN (counts in the PR): drop the unknown term from `resolveTarget`;
 * drop the userId-keyed re-fetch effect from LicenseProvider.
 */
import { renderHook, act } from "@testing-library/react";
import { useCompleteTransaction } from "../useCompleteTransaction";
import { useLicense } from "@/contexts/LicenseContext";

jest.mock("@/contexts/LicenseContext", () => ({ useLicense: jest.fn() }));

const mockUseLicense = useLicense as jest.MockedFunction<typeof useLicense>;

interface LicenseShape {
  canSubmit: boolean;
  organizationId: string | null;
  isLoading: boolean;
  isLicenseResolved: boolean;
}

function setup(license: LicenseShape) {
  mockUseLicense.mockReturnValue(license as unknown as ReturnType<typeof useLicense>);
  const openExport = jest.fn();
  const openSubmit = jest.fn();
  const openNeedsReview = jest.fn();
  // An EMPTY queue throughout: the gate must never be the reason nothing
  // happened, or these assertions would pass for the wrong reason.
  const refreshReviewState = jest.fn().mockResolvedValue({ items: [], count: 0 });
  const hook = renderHook(() =>
    useCompleteTransaction({
      transactionId: "tx-2885",
      refreshReviewState,
      openExport,
      openSubmit,
      openNeedsReview,
    }),
  );
  return { hook, openExport, openSubmit, openNeedsReview, refreshReviewState };
}

/**
 * The state the founder was in. `validateLicense` has landed (so the team
 * license shows up as canSubmit), but the org came from the pre-session
 * `fetchLicense` and is still null. `isLoading` is FALSE — which is exactly why
 * an isLoading-keyed fix would not have helped him.
 */
const PRE_SESSION_BROKERAGE: LicenseShape = {
  canSubmit: true,
  organizationId: null,
  isLoading: false,
  isLicenseResolved: false,
};

/** A refresh in flight: values may still change under us. */
const REFRESH_IN_FLIGHT: LicenseShape = {
  canSubmit: false,
  organizationId: null,
  isLoading: true,
  isLicenseResolved: false,
};

const RESOLVED_BROKERAGE: LicenseShape = {
  canSubmit: true,
  organizationId: "org-2885",
  isLoading: false,
  isLicenseResolved: true,
};

const RESOLVED_INDIVIDUAL: LicenseShape = {
  canSubmit: false,
  organizationId: null,
  isLoading: false,
  isLicenseResolved: true,
};

describe("BACKLOG-2885 — three states, three outcomes", () => {
  it("UNKNOWN (pre-session default, isLoading false): Complete performs NEITHER action", async () => {
    const { hook, openExport, openSubmit } = setup(PRE_SESSION_BROKERAGE);

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("unknown");
  });

  it("UNKNOWN (refresh in flight): Complete performs NEITHER action", async () => {
    const { hook, openExport, openSubmit } = setup(REFRESH_IN_FLIGHT);

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("unknown");
  });

  it("UNKNOWN refuses BEFORE the gate — no review read, no P3 dialog, nothing mutated", async () => {
    // A refusal that ran the gate first would flash "N need review" at a user
    // whose click we are declining to act on at all.
    const { hook, refreshReviewState } = setup(PRE_SESSION_BROKERAGE);

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(refreshReviewState).not.toHaveBeenCalled();
    expect(hook.result.current.blockedCount).toBeNull();
  });

  it("RESOLVED brokerage → Submit for Review", async () => {
    const { hook, openExport, openSubmit } = setup(RESOLVED_BROKERAGE);

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openSubmit).toHaveBeenCalledTimes(1);
    expect(openExport).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("submit");
  });

  it("RESOLVED genuine individual → export, which is their only completion path", async () => {
    const { hook, openExport, openSubmit } = setup(RESOLVED_INDIVIDUAL);

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openSubmit).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("export");
  });

  it("RESOLVED canSubmit with NO org still → export (BACKLOG-2792 invariant, unchanged)", async () => {
    // Once the answer is in, "team license, no organization" is a real answer
    // and it means export. Only an UNRESOLVED answer is unknown. Flipping this
    // to submit would take away the export that is this user's only way to
    // complete.
    const { hook, openExport, openSubmit } = setup({
      canSubmit: true,
      organizationId: null,
      isLoading: false,
      isLicenseResolved: true,
    });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openSubmit).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("export");
  });
});
