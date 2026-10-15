/**
 * State Machine Reducer — persisted Full Disk Access skip (BACKLOG-3212)
 *
 * The defect: a macOS user who clicked "Skip for now" on the Full Disk Access
 * step was routed back into onboarding on EVERY launch. `isOnboardingComplete`
 * returned false on `!hasPermissions` alone, and the skip itself lived only in
 * a React useState Set that died with the process.
 *
 * These tests are a DISCRIMINATING PAIR, and the second half is the point:
 *
 *   1. flag present  -> the app reaches `ready`, no onboarding
 *   2. flag ABSENT   -> the app still routes to onboarding and still asks
 *
 * A fix that simply stopped asking anyone, ever, would pass (1) and fail (2).
 *
 * BACKLOG-3673: routing no longer reads Full Disk Access at all (device state
 * is checked at point of use). Only the per-account record routes. So the pair
 * now lives where the question is still asked -- inside setup:
 *
 *   1. decline on record -> `permissions` seeded as answered, never re-asked
 *   2. decline ABSENT    -> `permissions` still asked
 *
 * and the routing half is pinned on the record: a finished account lands on
 * the dashboard whatever its FDA state; an unfinished one stays in setup
 * whatever its FDA state (a release on the email/FDA values is the M6 bug).
 *
 * Fixture provenance: `fdaSkipped` is derived in LoadingOrchestrator Phase 4
 * from `preferences.onboarding.fdaSkipped` — the exact key
 * preferenceHandlers.onboardingSkip.test.ts proves the real `preferences:update`
 * handler writes when PermissionsStep sends its skip payload.
 */

import { appStateReducer } from "./reducer";
import { fdaFromProbe, isFdaGranted } from "./fdaState";
import { selectSetupIncomplete } from "./selectors";
import type { AppState, LoadingState, PlatformInfo, ReadyState, User, UserData } from "./types";

const mockUser: User = {
  id: "user-123",
  email: "test@example.com",
  displayName: "Test User",
};

const mockMacOSPlatform: PlatformInfo = {
  isMacOS: true,
  isWindows: false,
  hasIPhone: true,
};

/**
 * A returning macOS user who has done everything EXCEPT grant Full Disk
 * Access: phone type chosen, mailbox connected, email onboarding done.
 * This is the founder's reported state — the running app showed
 * status "onboarding", permissionsGranted false, isNewUser false.
 */
const declinedFdaWithMailbox: UserData = {
  phoneType: "iphone",
  hasCompletedEmailOnboarding: true,
  hasEmailConnected: true,
  needsDriverSetup: false,
  // BACKLOG-3275: `hasPermissions: false` + `fdaSkipped: true` is now ONE state.
  // The pair could express combinations the domain does not have; this cannot.
  fda: "declined",
  // BACKLOG-3673: this account has not finished setup (record empty).
  setup: "not-finished",
};

const loadingUserData: LoadingState = { status: "loading", phase: "loading-user-data" };

function loadUserData(data: UserData, platform: PlatformInfo = mockMacOSPlatform): AppState {
  return appStateReducer(loadingUserData, {
    type: "USER_DATA_LOADED" as const,
    data,
    user: mockUser,
    platform,
  });
}

describe("BACKLOG-3212 — a persisted FDA skip survives a relaunch", () => {
  it("BACKLOG-3673: an unfinished account that declined FDA stays in setup, with FDA NOT re-asked", () => {
    const result = loadUserData(declinedFdaWithMailbox);

    expect(result.status).toBe("onboarding");
    if (result.status === "onboarding") {
      expect(result.fda).toBe("declined");
      expect(result.completedSteps).toContain("permissions");
    }
  });

  it("a FINISHED account that declined FDA lands on ready, with the decline carried (never granted)", () => {
    const result = loadUserData({ ...declinedFdaWithMailbox, setup: "finished" });

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      // The capability must stay FALSE in the state that reaches the app.
      // Declining is not granting: anything gating on real Full Disk Access
      // still has to see that it is absent — while the fact that the user was
      // ASKED survives in the same value.
      expect(result.userData.fda).toBe("declined");
      expect(isFdaGranted(result.userData.fda)).toBe(false);
    }
  });

  it("CONTROL: the same user WITHOUT the flag is still routed into onboarding and still asked", () => {
    // Identical in every respect except the persisted choice. This is the
    // half that fails for a fix which just stops asking.
    const neverSkipped: UserData = { ...declinedFdaWithMailbox, fda: "not-asked" };

    const result = loadUserData(neverSkipped);

    expect(result.status).toBe("onboarding");
    if (result.status === "onboarding") {
      expect(result.completedSteps).not.toContain("permissions");
      expect(result.fda).not.toBe("declined");
    }
  });

  it("CONTROL: an absent preference key (pre-3212 bag) is `not-asked`, never `declined`", () => {
    // Every user who existed before BACKLOG-3212 has no `onboarding.fdaSkipped`
    // key at all. Absent must never be read as "already declined".
    //
    // BACKLOG-3275: the reducer can no longer represent "the key was absent" —
    // that distinction now lives at the single derivation point, so it is
    // pinned there, and the reducer is pinned on the state it produces.
    expect(
      fdaFromProbe({ isMacOS: true, probeGranted: false, recordedDecline: false })
    ).toBe("not-asked");

    const withoutTheKey: UserData = { ...declinedFdaWithMailbox, fda: "not-asked" };

    const result = loadUserData(withoutTheKey);

    expect(result.status).toBe("onboarding");
  });

  it("BACKLOG-3277 / BACKLOG-3673: a FINISHED account that declined FDA and has no mailbox is released", () => {
    // INVERTED BY BACKLOG-3277, deliberately. This test previously asserted
    // `onboarding`, on the stated ground that "the BACKLOG-1821 floor would
    // never fire again". That ground was false as written: the floor does not
    // fire for this user either way — on macOS `driverSetupComplete` reads
    // true (the fail-open paragraph on `hasMinimumDataSourceForUser`,
    // userDataSelectors.ts:318-322, documents why), so
    // `getSatisfyingSource` returns "texts-iphone-driver" and the floor is
    // satisfied. The old gate was STRICTER than the floor it claimed to
    // protect, and that gap is what held the user forever.
    // BACKLOG-3673: the release is now the record's, not the floor's.
    const noSourceAtAll: UserData = {
      ...declinedFdaWithMailbox,
      hasEmailConnected: false, // skipped email
      hasCompletedEmailOnboarding: true,
      setup: "finished",
    };

    const result = loadUserData(noSourceAtAll);

    expect(result.status).toBe("ready");
  });

  it("BACKLOG-3673 CONTROL (M6): the same account WITHOUT the record is held, however complete its answers", () => {
    const answeredEverything: UserData = {
      ...declinedFdaWithMailbox,
      hasEmailConnected: true,
      hasCompletedEmailOnboarding: true,
      setup: "not-finished",
    };
    expect(loadUserData(answeredEverything).status).toBe("onboarding");
  });

  it("BACKLOG-3277 HONESTY: the released user is NOT shown the Resume-setup banner", () => {
    // Stated so it cannot be mistaken for a passing bar. `selectSetupIncomplete`
    // is `!hasMinimumDataSource` over the same projection the gate now consults,
    // so every user BACKLOG-3277 releases is definitionally one the banner
    // cannot show. Verification bar #1 is structurally unreachable from this
    // change; it needs the observed-source banner, filed separately.
    const noSourceAtAll: UserData = {
      ...declinedFdaWithMailbox,
      hasEmailConnected: false,
      hasCompletedEmailOnboarding: true,
      setup: "finished",
    };

    const result = loadUserData(noSourceAtAll);
    expect(result.status).toBe("ready");
    expect(selectSetupIncomplete(result)).toBe(false);
  });

  it("BACKLOG-3277 CONTROL: a user who was never ASKED is still held and still asked", () => {
    // The discriminating half. A fix that simply stopped holding anyone would
    // pass the release test above and fail this one.
    const neverAsked: UserData = {
      ...declinedFdaWithMailbox,
      hasEmailConnected: false,
      hasCompletedEmailOnboarding: true,
      fda: "not-asked",
    };

    expect(loadUserData(neverAsked).status).toBe("onboarding");
  });

  it("still seeds `permissions` as answered when such a user does enter onboarding", () => {
    // They are not re-asked for Full Disk Access. The queue reads this via
    // OnboardingState.fdaSkipped; completedSteps carries the same fact for the
    // legacy step-derivation path.
    //
    // BACKLOG-3277 re-anchor: `hasCompletedEmailOnboarding: false` is what now
    // holds this user (reducer.ts:132), since the Full Disk Access gate no
    // longer does. Without it the user reaches `ready` and this whole body
    // stops running while staying green.
    const noSourceAtAll: UserData = {
      ...declinedFdaWithMailbox,
      hasEmailConnected: false,
      hasCompletedEmailOnboarding: false,
    };

    const result = loadUserData(noSourceAtAll);

    expect(result.status).toBe("onboarding");
    if (result.status === "onboarding") {
      expect(result.fda).toBe("declined");
      expect(result.completedSteps).toContain("permissions");
      expect(result.step).not.toBe("permissions");
    }
  });

  it("leaves the FDA-granted path completely unchanged", () => {
    const granted: UserData = {
      phoneType: "iphone",
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: true,
      needsDriverSetup: false,
      fda: "granted",
      setup: "finished",
    };

    const result = loadUserData(granted);

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.userData.fda).toBe("granted");
    }
  });

  it("a granted user is unaffected even if a stale decline is still on record", () => {
    // Skip, then grant later (e.g. via the BACKLOG-3208 Settings path). The
    // stale record must be inert, never a downgrade.
    //
    // BACKLOG-3275: "granted AND declined" is no longer a representable state,
    // which is the point — the precedence now has exactly one home, so it is
    // pinned there rather than re-tested at every consumer.
    expect(
      fdaFromProbe({ isMacOS: true, probeGranted: true, recordedDecline: true })
    ).toBe("granted");

    const grantedAfterSkipping: UserData = {
      phoneType: "iphone",
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: true,
      needsDriverSetup: false,
      fda: "granted",
      setup: "finished",
    };

    const result = loadUserData(grantedAfterSkipping);

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.userData.fda).toBe("granted");
    }
  });

  it("does not let a skip substitute for the other onboarding requirements", () => {
    // No phone type chosen — the skip must not shortcut anything but the FDA
    // question itself.
    const noPhoneType: UserData = { ...declinedFdaWithMailbox, phoneType: null };

    const result = loadUserData(noPhoneType);

    expect(result.status).toBe("onboarding");
  });

  it("carries the skip through START_EMAIL_SETUP so a ready user is not re-asked", () => {
    const ready: ReadyState = {
      status: "ready",
      user: mockUser,
      platform: mockMacOSPlatform,
      userData: declinedFdaWithMailbox,
    };

    const result = appStateReducer(ready, { type: "START_EMAIL_SETUP" });

    expect(result.status).toBe("onboarding");
    if (result.status === "onboarding") {
      expect(result.fda).toBe("declined");
      expect(isFdaGranted(result.fda!)).toBe(false);
    }
  });
});
