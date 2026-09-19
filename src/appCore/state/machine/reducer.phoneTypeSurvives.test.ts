/**
 * BACKLOG-3276 — the user's phone-type answer survives re-entry into onboarding.
 *
 * Two entries into onboarding state, and whether the recorded answer
 * reaches the queue that decides if "What phone do you use?" is shown:
 * - USER_DATA_LOADED (every relaunch of a returning user) — [B], [D]
 * - START_EMAIL_SETUP (Resume Setup) — [A], [C3]
 * Every control was proven red by reverting its own edit in reducer.ts.
 *
 * FIXTURE PROVENANCE
 * - PlatformInfo.hasIPhone is `false` because every production producer
 *   hardcodes it: LoadingOrchestrator.tsx:73-76 (getPlatformInfo, used at :448
 *   and :554) and useLoginHandlers.ts:44. `true` is unproducible and would make
 *   selectPhoneType's platform fallback mask the defect.
 * - USER_DATA_LOADED `data` has exactly the shape LoadingOrchestrator's
 *   loadUserData returns (:731-737). phoneType there is `user:get-phone-type`
 *   (userSettingsHandlers.ts:80-83, users_local.mobile_phone_type).
 * - Every `ready` state below is emitted by the reducer itself, never
 *   hand-built.
 * - The queue context mirrors OnboardingFlow.tsx:266-284 ->
 *   useOnboardingQueue.ts:131-151, with phoneType read through the real
 *   selectPhoneType exactly as OnboardingFlow.tsx:267 does.
 */
import { appStateReducer } from "./reducer";
import { selectPhoneType } from "./selectors/userDataSelectors";
import { buildOnboardingQueue } from "../../../components/onboarding/queue/buildQueue";
import type { OnboardingContext } from "../../../components/onboarding/types";
import type { AppState, LoadingState, PlatformInfo, User, UserData } from "./types";

type Phone = "iphone" | "android";

const user: User = { id: "user-3276", email: "user@example.com", displayName: "Test User" };
const macOS: PlatformInfo = { isMacOS: true, isWindows: false, hasIPhone: false };
const windows: PlatformInfo = { isMacOS: false, isWindows: true, hasIPhone: false };
const PLATFORMS: Array<[string, PlatformInfo]> = [["macOS", macOS], ["Windows", windows]];
const PHONES: Phone[] = ["iphone", "android"];

const loadingUserData: LoadingState = { status: "loading", phase: "loading-user-data" };

function load(data: UserData, platform: PlatformInfo): AppState {
  return appStateReducer(loadingUserData, { type: "USER_DATA_LOADED", data, user, platform });
}

/** A returning user still owed onboarding (no email onboarding yet). */
function returningMidOnboarding(phoneType: Phone | null, platform: PlatformInfo): UserData {
  return {
    phoneType,
    hasCompletedEmailOnboarding: false,
    hasEmailConnected: false,
    needsDriverSetup: false,
    fda: platform.isMacOS ? "not-asked" : "not-applicable",
  };
}

/** A returning user the reducer releases to `ready` (USER_DATA_LOADED). */
function readyWith(phoneType: Phone, platform: PlatformInfo): AppState {
  const state = load(
    {
      phoneType,
      hasCompletedEmailOnboarding: true,
      hasEmailConnected: false,
      needsDriverSetup: false,
      fda: platform.isMacOS ? "granted" : "not-applicable",
    },
    platform
  );
  if (state.status !== "ready") throw new Error(`fixture: expected ready, got ${state.status}`);
  return state;
}

/**
 * A `ready` user who NEVER answered phone type — emitted by the reducer via
 * the only route that can produce it: a queue completion with no selection.
 * FDA_GRANTED on macOS so the email exit below is not held by `permissions`.
 */
function readyNeverAnswered(platform: PlatformInfo): AppState {
  let s = appStateReducer({ status: "unauthenticated" }, {
    type: "LOGIN_SUCCESS", user, platform, isNewUser: true,
  });
  if (s.status !== "onboarding") throw new Error("fixture: expected onboarding");
  if (platform.isMacOS) s = appStateReducer(s, { type: "FDA_GRANTED" });
  s = appStateReducer(s, { type: "ONBOARDING_QUEUE_DONE" });
  if (s.status !== "ready" || s.userData.phoneType !== null) {
    throw new Error("fixture: expected ready with phoneType null");
  }
  return s;
}

function phoneTypeQueueStatus(state: AppState, platform: PlatformInfo) {
  const context: OnboardingContext = {
    platform: platform.isMacOS ? "macos" : "windows",
    phoneType: selectPhoneType(state),
    emailConnected: false,
    connectedEmail: null,
    emailSkipped: false,
    driverSkipped: false,
    driverSetupComplete: true,
    permissionsGranted: false,
    termsAccepted: true,
    emailProvider: null,
    authProvider: "google",
    isNewUser: false,
    isDatabaseInitialized: true,
    userId: user.id,
    isUserVerifiedInLocalDb: true,
    isResumedFromFdaRelaunch: false,
  };
  const queue = buildOnboardingQueue(context.platform, context);
  const entry = queue.find((e) => e.step.meta.id === "phone-type");
  if (!entry) throw new Error("fixture: phone-type missing from queue");
  return entry.status;
}

describe("BACKLOG-3276 — producer 2: USER_DATA_LOADED carries the loaded answer", () => {
  describe.each(PLATFORMS)("%s", (_name, platform) => {
    it.each(PHONES)("[B] returning user with %s on record is not re-asked", (phone) => {
      const state = load(returningMidOnboarding(phone, platform), platform);
      expect(state.status).toBe("onboarding"); // PRECONDITION: routed to onboarding
      if (state.status !== "onboarding") return;

      expect(state.selectedPhoneType).toBe(phone);
      expect(selectPhoneType(state)).toBe(phone);
      expect(phoneTypeQueueStatus(state, platform)).toBe("complete");
    });

    it("[D] returning user with NO phone type on record is still asked", () => {
      const state = load(returningMidOnboarding(null, platform), platform);
      expect(state.status).toBe("onboarding");
      if (state.status !== "onboarding") return;

      expect(state.selectedPhoneType).toBeUndefined();
      expect(selectPhoneType(state)).toBeNull();
      expect(phoneTypeQueueStatus(state, platform)).toBe("active");
    });
  });
});

describe("BACKLOG-3276 — producer 1: START_EMAIL_SETUP carries the answer", () => {
  describe.each(PLATFORMS)("%s", (_name, platform) => {
    it.each(PHONES)("[A] %s survives entry: not re-asked", (phone) => {
      const ready = readyWith(phone, platform);
      const back = appStateReducer(ready, { type: "START_EMAIL_SETUP" });
      expect(back.status).toBe("onboarding");
      if (back.status !== "onboarding") return;

      expect(selectPhoneType(back)).toBe(phone);
      expect(phoneTypeQueueStatus(back, platform)).toBe("complete");
    });

    it.each(PHONES)("[A] %s survives the queue exit (ONBOARDING_QUEUE_DONE)", (phone) => {
      const back = appStateReducer(readyWith(phone, platform), { type: "START_EMAIL_SETUP" });
      const out = appStateReducer(back, { type: "ONBOARDING_QUEUE_DONE" });
      expect(out).not.toBe(back); // ANTI-VACUITY
      if (out.status !== "ready") throw new Error("expected ready");
      expect(out.userData.phoneType).toBe(phone);
    });

    it.each(PHONES)("[A] %s survives the email exit (ONBOARDING_STEP_COMPLETE email-connect)", (phone) => {
      // useEmailOnboardingApi.ts:140 — both connect and skip dispatch this.
      const back = appStateReducer(readyWith(phone, platform), { type: "START_EMAIL_SETUP" });
      let out = appStateReducer(back, { type: "ONBOARDING_STEP_COMPLETE", step: "email-connect" });
      expect(out).not.toBe(back); // ANTI-VACUITY
      // Windows + iPhone: the legacy step list routes via apple-driver first
      // (reducer.ts:568-571). The queue exit then carries the answer out.
      if (out.status === "onboarding") {
        out = appStateReducer(out, { type: "ONBOARDING_QUEUE_DONE" });
      }
      if (out.status !== "ready") throw new Error("expected ready");
      expect(out.userData.phoneType).toBe(phone);
    });
  });
});

describe("BACKLOG-3276 — case 3: never answered stays unanswered, and is routed to answer", () => {
  describe.each(PLATFORMS)("%s", (_name, platform) => {
    it("[C3] entering email setup does not invent an answer", () => {
      const back = appStateReducer(readyNeverAnswered(platform), { type: "START_EMAIL_SETUP" });
      expect(back.status).toBe("onboarding");
      if (back.status !== "onboarding") return;

      expect(back.selectedPhoneType).toBeUndefined();
      expect(selectPhoneType(back)).toBeNull();
      expect(phoneTypeQueueStatus(back, platform)).toBe("active");
    });

    it("[C3] the email exit routes to phone-type instead of recording an answer", () => {
      const back = appStateReducer(readyNeverAnswered(platform), { type: "START_EMAIL_SETUP" });
      const out = appStateReducer(back, { type: "ONBOARDING_STEP_COMPLETE", step: "email-connect" });
      expect(out).not.toBe(back); // ANTI-VACUITY
      expect(out.status).toBe("onboarding");
      if (out.status !== "onboarding") return;
      expect(out.step).toBe("phone-type");
      expect(out.completedSteps).not.toContain("phone-type");
    });

    it("[C3] the queue exit leaves it null", () => {
      const back = appStateReducer(readyNeverAnswered(platform), { type: "START_EMAIL_SETUP" });
      const out = appStateReducer(back, { type: "ONBOARDING_QUEUE_DONE" });
      if (out.status !== "ready") throw new Error("expected ready");
      expect(out.userData.phoneType).toBeNull();
    });
  });
});

describe("[SR-C] never answered: completing permissions does not invent a phone type", () => {
  // Reducer-emitted, not UI-reachable: the queue shows phone-type before
  // permissions, so no user completes permissions without an answer. It guards
  // reducer.ts ONBOARDING_STEP_COMPLETE, which must record null, never a
  // platform default.
  it("macOS new user -> FDA_GRANTED -> ONBOARDING_STEP_COMPLETE(permissions) -> phoneType null", () => {
    let s: AppState = appStateReducer({ status: "unauthenticated" }, {
      type: "LOGIN_SUCCESS", user, platform: macOS, isNewUser: true,
    });
    s = appStateReducer(s, { type: "FDA_GRANTED" });
    const out = appStateReducer(s, { type: "ONBOARDING_STEP_COMPLETE", step: "permissions" });
    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.userData.phoneType).toBeNull();
  });
});
