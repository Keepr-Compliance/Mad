/**
 * BACKLOG-3275 — the three Full Disk Access states, and the defect that
 * collapsed them.
 *
 * PROVENANCE OF THIS FILE. Every assertion below was first written in its
 * inverted form and run against unmodified `develop` @ `a6fe128aa`, where all
 * six PASSED — describing the wrong behaviour. They were then run against the
 * fix, where five went RED and only the precondition (which runs before the
 * transition) stayed green. That before/after pair is the evidence; a fix whose
 * before-state was never made to fail is unverified.
 *
 * THE DEFECT. `ONBOARDING_STEP_COMPLETE` computed the Full Disk Access
 * capability from `completedSteps`. A user who DECLINED has `"permissions"` in
 * that list — correctly, it means "asked and answered" — so completing any
 * other step reported the capability as GRANTED, and destroyed the record of
 * the decline in the same transition. Three composing defects, and the first
 * two masked each other: fixing either alone re-opened BACKLOG-3212.
 *
 * THE THIRD STATE is the one that keeps being lost. "Never asked" must stay
 * distinguishable from "declined" — a change that collapses them re-creates the
 * bug this file exists to prevent. The final describe block is that assertion.
 *
 * Fixture provenance: identical in shape to `reducer.fdaSkip.test.ts`'s
 * `declinedFdaWithMailbox`, which documents its own provenance back to
 * `LoadingOrchestrator` Phase 4 and `preferenceHandlers.onboardingSkip.test.ts`.
 * Here `hasEmailConnected` is false because that is what keeps the user in
 * onboarding long enough to dispatch a step completion.
 */
import { appStateReducer } from "./reducer";
import { isFdaGranted } from "./fdaState";
import { selectSetupIncomplete } from "./selectors";
import type {
  AppState,
  LoadingState,
  OnboardingState,
  PlatformInfo,
  User,
  UserData,
} from "./types";

const mockUser: User = { id: "user-123", email: "test@example.com", displayName: "Test User" };
const macOS: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: true };
const windows: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };

/**
 * A macOS user who DECLINED Full Disk Access, has no mailbox, and has NOT yet
 * been through email onboarding.
 *
 * FIXTURE PROVENANCE (BACKLOG-3277). `hasCompletedEmailOnboarding: false` is
 * load-bearing and is the ONLY difference from the BACKLOG-3275 original.
 * Before 3277 the user was held in onboarding by the Full Disk Access routing
 * gate; 3277 releases that user, and a fixture that no longer routes to
 * onboarding cannot dispatch a step completion — every assertion below would
 * have gone silently vacuous. This user is held one check EARLIER
 * (`reducer.ts:132`, email onboarding not done), which is independent of the
 * gate, so these guards no longer depend on routing at all.
 *
 * Transcribed, not invented: `USER_DATA_LOADED` with this fixture emits
 * `completedSteps: ["phone-type", "permissions", "secure-storage"]`,
 * `fda: "declined"`, `step: "email-connect"` — pinned by the PROVENANCE test
 * below so the transcription cannot drift away from its producer.
 */
const declinedFdaMidOnboarding: UserData = {
  phoneType: "iphone",
  hasCompletedEmailOnboarding: false,
  hasEmailConnected: false,
  needsDriverSetup: false,
  fda: "declined",
};

const loading: LoadingState = { status: "loading", phase: "loading-user-data" };

function load(data: UserData, platform: PlatformInfo = macOS): AppState {
  return appStateReducer(loading, { type: "USER_DATA_LOADED", data, user: mockUser, platform });
}

describe("BACKLOG-3275 — a declined permission is never reported as granted", () => {
  it("FIXTURE PROVENANCE (BACKLOG-3277): the producer still emits the state these guards assume", () => {
    // A transcribed fixture is only as good as its producer. If USER_DATA_LOADED
    // ever stops emitting this shape, every guard below degenerates silently —
    // so the transcription is asserted, not trusted.
    const onboarding = load(declinedFdaMidOnboarding);
    expect(onboarding.status).toBe("onboarding");
    if (onboarding.status !== "onboarding") return;
    expect([...onboarding.completedSteps].sort()).toEqual(
      ["permissions", "phone-type", "secure-storage"]
    );
    expect(onboarding.fda).toBe("declined");
    expect(onboarding.step).toBe("email-connect");
  });

  it("PRECONDITION: the declined user is routed to onboarding with `permissions` already answered", () => {
    const onboarding = load(declinedFdaMidOnboarding);
    expect(onboarding.status).toBe("onboarding");
    if (onboarding.status !== "onboarding") return;
    expect(onboarding.completedSteps).toContain("permissions");
    expect(onboarding.fda).toBe("declined");
    expect(isFdaGranted(onboarding.fda!)).toBe(false);
  });

  it("FIX 1: completing another step leaves the capability FALSE", () => {
    // Was: `hasPermissions` became true because `completedSteps` contained
    // "permissions". Navigation no longer decides capability.
    const onboarding = load(declinedFdaMidOnboarding);
    const after = appStateReducer(onboarding, { type: "ONBOARDING_STEP_COMPLETE", step: "email-connect" });

    expect(after).not.toBe(onboarding); // ANTI-VACUITY (BACKLOG-3277)
    expect(after.status).toBe("ready");
    if (after.status !== "ready") return;
    expect(isFdaGranted(after.userData.fda)).toBe(false);
  });

  it("FIX 2: the recorded decline SURVIVES that transition", () => {
    // Was: `fdaSkipped: true` went in and `undefined` came out. Independent of
    // FIX 1 — deleting only the inversion left this broken, which is why the
    // two were fixed together.
    const onboarding = load(declinedFdaMidOnboarding);
    const after = appStateReducer(onboarding, { type: "ONBOARDING_STEP_COMPLETE", step: "email-connect" });
    expect(after).not.toBe(onboarding); // ANTI-VACUITY (BACKLOG-3277)
    if (after.status !== "ready") throw new Error("expected ready");
    expect(after.userData.fda).toBe("declined");
  });

  it("FIX 3 (BACKLOG-3212 must survive): re-entering email setup carries the decline, so the user is NOT re-asked", () => {
    // The behaviour this protects: `OnboardingFlow` seeds `permissions` as
    // already-answered off a recorded decline. Before the fix the decline was
    // gone by this point and the ONLY thing hiding the step was the inverted
    // capability — so fixing the inversion alone would have re-asked every
    // user who declined, which is exactly the bug BACKLOG-3212 removed.
    const onboarding = load(declinedFdaMidOnboarding);
    const ready = appStateReducer(onboarding, { type: "ONBOARDING_STEP_COMPLETE", step: "email-connect" });
    expect(ready).not.toBe(onboarding); // ANTI-VACUITY (BACKLOG-3277)
    if (ready.status !== "ready") throw new Error("expected ready");

    const back = appStateReducer(ready, { type: "START_EMAIL_SETUP" });
    expect(back).not.toBe(ready); // ANTI-VACUITY (BACKLOG-3277)
    expect(back.status).toBe("onboarding");
    if (back.status !== "onboarding") return;
    expect(back.fda).toBe("declined");
    expect(isFdaGranted(back.fda!)).toBe(false);
  });

  it("FIX 4: a declined permission is not a data source, so a user with no other source reports setup incomplete", () => {
    // What BACKLOG-3275 guarantees here: the floor does not count a DECLINED
    // Full Disk Access as a texts source (userDataSelectors.ts,
    // `permissionsGranted: isFdaGranted(userData.fda)`).
    //
    // FIXTURE: reducer-emitted, not UI-reachable. USER_DATA_LOADED with no
    // phone type, then ONBOARDING_QUEUE_DONE with nothing answered. The UI
    // cannot complete the queue while phone-type is unanswered (PhoneTypeStep:
    // no skip, Continue hidden), so no user reaches this state. It isolates the
    // floor's treatment of a declined permission from every other source.
    //
    // Not a user-visible banner case. A ready user always has a phone type
    // (BACKLOG-3276), any phone type satisfies the floor
    // (hasMinimumDataSourceForUser sets driverSetupComplete from
    // needsDriverSetup === false; dataSourceFloor.ts iPhone and Android
    // branches), so selectSetupIncomplete has no reachable true case. Traced by
    // reading and swept over USER_DATA_LOADED inputs in BACKLOG-3276's review.
    const producible: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };
    const onboarding = load(
      {
        phoneType: null,
        hasCompletedEmailOnboarding: false,
        hasEmailConnected: false,
        needsDriverSetup: false,
        fda: "declined",
      },
      producible
    );
    expect(onboarding.status).toBe("onboarding"); // PRECONDITION
    const ready = appStateReducer(onboarding, { type: "ONBOARDING_QUEUE_DONE" });
    expect(ready).not.toBe(onboarding); // ANTI-VACUITY (BACKLOG-3277)
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;

    expect(ready.userData.hasEmailConnected).toBe(false);
    expect(ready.userData.phoneType).toBeNull();
    expect(ready.userData.fda).toBe("declined");
    expect(selectSetupIncomplete(ready)).toBe(true);

    // DISCRIMINATING CONTROL: the identical state with a genuine grant does NOT
    // report setup incomplete; a texts-only user has satisfied the floor.
    const granted = { ...ready, userData: { ...ready.userData, fda: "granted" as const } };
    expect(selectSetupIncomplete(granted)).toBe(false);
  });
});

describe("BACKLOG-3275 — only an observed capability may report `granted`", () => {
  const onboardingMacOS: OnboardingState = {
    status: "onboarding",
    step: "permissions",
    user: mockUser,
    platform: macOS,
    completedSteps: ["phone-type", "secure-storage", "email-connect"],
    fda: "not-asked",
  };

  it("completing the permissions step does NOT by itself report granted", () => {
    // The single production dispatcher sends FDA_GRANTED alongside this action
    // (usePermissionsFlow.ts). `ONBOARDING_SKIP` also re-dispatches as a step
    // completion, so a step completion can arrive from a path that granted
    // nothing — which is why capability is not derived from it.
    const after = appStateReducer(onboardingMacOS, {
      type: "ONBOARDING_STEP_COMPLETE",
      step: "permissions",
    });
    if (after.status !== "ready") throw new Error("expected ready");
    expect(isFdaGranted(after.userData.fda)).toBe(false);
    expect(after.userData.fda).toBe("not-asked");
  });

  it("FDA_GRANTED reports granted, and it survives the step completion that follows", () => {
    const observed = appStateReducer(onboardingMacOS, { type: "FDA_GRANTED" });
    expect(observed.status).toBe("onboarding");
    if (observed.status !== "onboarding") return;
    expect(observed.fda).toBe("granted");

    const after = appStateReducer(observed, { type: "ONBOARDING_STEP_COMPLETE", step: "permissions" });
    if (after.status !== "ready") throw new Error("expected ready");
    expect(isFdaGranted(after.userData.fda)).toBe(true);
  });

  it("FDA_GRANTED upgrades a ready user who granted later (the Settings path)", () => {
    const onboarding = load(declinedFdaMidOnboarding);
    const ready = appStateReducer(onboarding, {
      type: "ONBOARDING_STEP_COMPLETE",
      step: "email-connect",
    });
    expect(ready).not.toBe(onboarding); // ANTI-VACUITY (BACKLOG-3277)
    if (ready.status !== "ready") throw new Error("expected ready");
    expect(ready.userData.fda).toBe("declined");

    const upgraded = appStateReducer(ready, { type: "FDA_GRANTED" });
    if (upgraded.status !== "ready") throw new Error("expected ready");
    expect(upgraded.userData.fda).toBe("granted");
  });
});

describe("BACKLOG-3275 — the third state: never-asked stays distinguishable from declined", () => {
  const neverAsked: UserData = { ...declinedFdaMidOnboarding, fda: "not-asked" };

  it("the two states differ in `completedSteps` — declined is answered, never-asked is not", () => {
    const declined = load(declinedFdaMidOnboarding);
    const never = load(neverAsked);

    expect(declined.status).toBe("onboarding");
    expect(never.status).toBe("onboarding");
    if (declined.status !== "onboarding" || never.status !== "onboarding") return;

    expect(declined.completedSteps).toContain("permissions");
    expect(never.completedSteps).not.toContain("permissions");
  });

  it("the two states remain different after the SAME transition", () => {
    // This is the assertion that closes the item. Before the fix both ended up
    // reporting granted with no recorded answer — byte-identical, the two
    // states the union exists to separate collapsed into one.
    const declinedBefore = load(declinedFdaMidOnboarding);
    const neverBefore = load(neverAsked);
    const fromDeclined = appStateReducer(declinedBefore, {
      type: "ONBOARDING_STEP_COMPLETE",
      step: "email-connect",
    });
    const fromNeverAsked = appStateReducer(neverBefore, {
      type: "ONBOARDING_STEP_COMPLETE",
      step: "email-connect",
    });
    // ANTI-VACUITY (BACKLOG-3277): BOTH legs of the pair must run the
    // transition. Half a discriminating pair discriminates nothing.
    expect(fromDeclined).not.toBe(declinedBefore);
    expect(fromNeverAsked).not.toBe(neverBefore);

    if (fromDeclined.status !== "ready") throw new Error("expected ready");
    expect(fromDeclined.userData.fda).toBe("declined");

    // The never-asked user is still in onboarding — they have not answered, so
    // the permissions step is still queued. That difference IS the distinction.
    expect(fromNeverAsked.status).toBe("onboarding");
    if (fromNeverAsked.status !== "onboarding") return;
    expect(fromNeverAsked.fda).toBe("not-asked");
    expect(fromNeverAsked.fda).not.toBe(fromDeclined.userData.fda);
  });

  it("neither state reports the capability as present", () => {
    expect(isFdaGranted("declined")).toBe(false);
    expect(isFdaGranted("not-asked")).toBe(false);
  });
});

describe("BACKLOG-3275 — Windows acquires no onboarding steps it did not have", () => {
  // SR plan review: the `platform.isMacOS &&` guard on the completedSteps seed
  // is KEPT rather than folded into `wasFdaAnswered`, because that helper
  // returns true for "not-applicable". A note is not a control, so this is the
  // control: `completedSteps` for a Windows user must be identical whatever the
  // Full Disk Access state says. `completedSteps` is read outside this reducer
  // at `derivation/stepDerivation.ts:189`.
  const windowsUser: UserData = {
    phoneType: "iphone",
    hasCompletedEmailOnboarding: true,
    hasEmailConnected: true,
    needsDriverSetup: true,
    fda: "not-applicable",
  };

  it("does not seed `permissions` or `secure-storage` for a Windows user", () => {
    const result = load(windowsUser, windows);
    expect(result.status).toBe("onboarding");
    if (result.status !== "onboarding") return;
    expect(result.completedSteps).not.toContain("permissions");
    expect(result.completedSteps).not.toContain("secure-storage");
  });

  it("CONTROL: the Windows seed is identical whatever the Full Disk Access state says", () => {
    const asNotApplicable = load(windowsUser, windows);
    // A value the app cannot actually produce on Windows — asserted here
    // precisely to prove the guard, not the union, is what holds the line.
    const asDeclined = load({ ...windowsUser, fda: "declined" }, windows);
    const asGranted = load({ ...windowsUser, fda: "granted" }, windows);

    if (
      asNotApplicable.status !== "onboarding" ||
      asDeclined.status !== "onboarding" ||
      asGranted.status !== "onboarding"
    ) {
      throw new Error("expected onboarding");
    }
    expect(asDeclined.completedSteps).toEqual(asNotApplicable.completedSteps);
    expect(asGranted.completedSteps).toEqual(asNotApplicable.completedSteps);
  });
});
