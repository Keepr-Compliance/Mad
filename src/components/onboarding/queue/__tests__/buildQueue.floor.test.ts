/**
 * BACKLOG-1821 — Integration tests for the data-source floor inside the REAL
 * onboarding queue (real flows + real registered steps, no getFlowSteps mock).
 *
 * These assert end-to-end that:
 *   - the floor step is SKIPPED (non-applicable) when the user has a source, so
 *     the queue is complete and onboarding can finish;
 *   - the floor step becomes the ACTIVE, LAST visible step when the user reached
 *     the end with ZERO sources, so isQueueComplete() is false — onboarding
 *     cannot complete.
 *
 * @module onboarding/queue/__tests__/buildQueue.floor.test
 */

import type { OnboardingContext } from "../../types";
import {
  buildOnboardingQueue,
  isQueueComplete,
  getVisibleEntries,
} from "../buildQueue";

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * Context representing a user who has reached the END of onboarding (all earlier
 * steps satisfied) so that the floor step is the only thing that can gate
 * completion. Overrides tune the connected-source state.
 */
function endOfFlowContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    platform: "windows",
    phoneType: "iphone",
    // Earlier steps satisfied:
    isDatabaseInitialized: true,
    userId: "u1",
    isUserVerifiedInLocalDb: true,
    driverSetupComplete: true,
    // Source state (the part under test) — default: a source exists (driver).
    emailConnected: false,
    emailSkipped: false,
    connectedEmail: null,
    emailProvider: null,
    permissionsGranted: false,
    driverSkipped: false,
    termsAccepted: true,
    authProvider: "google",
    isNewUser: true,
    ...overrides,
  };
}

/** Find the floor entry in a built queue. */
function floorEntry(context: OnboardingContext) {
  const queue = buildOnboardingQueue(context.platform, context);
  return queue.find((e) => e.step.meta.id === "data-source-floor");
}

describe("data-source floor in the real queue (BACKLOG-1821)", () => {
  describe("floor is SKIPPED when a source exists", () => {
    it("Windows iPhone with driver installed → floor non-applicable (skipped)", () => {
      const ctx = endOfFlowContext({
        platform: "windows",
        phoneType: "iphone",
        driverSetupComplete: true,
      });
      const entry = floorEntry(ctx);
      expect(entry).toBeDefined();
      expect(entry!.applicable).toBe(false);
      expect(entry!.status).toBe("skipped");
    });

    it("email connected → floor non-applicable (skipped)", () => {
      const ctx = endOfFlowContext({ emailConnected: true, driverSetupComplete: false });
      const entry = floorEntry(ctx);
      expect(entry!.applicable).toBe(false);
    });

    it("Android user → floor non-applicable (fail-open)", () => {
      const ctx = endOfFlowContext({ phoneType: "android", driverSetupComplete: false });
      const entry = floorEntry(ctx);
      expect(entry!.applicable).toBe(false);
    });

    it("the floor is NOT among the visible entries when a source exists", () => {
      const ctx = endOfFlowContext({ driverSetupComplete: true });
      const visible = getVisibleEntries(buildOnboardingQueue(ctx.platform, ctx));
      expect(visible.map((e) => e.step.meta.id)).not.toContain("data-source-floor");
    });
  });

  // NOTE: at the pure buildQueue layer, steps whose isComplete is always false
  // (contact-source, data-sync) stay "active" — the hook layer
  // (useOnboardingQueue) advances past them via manuallyCompletedIds. So the
  // "floor becomes the ACTIVE step and blocks completion" behavior is asserted
  // through the real hook in useOnboardingQueue.floor.test.tsx. Here we assert
  // the pure, order-independent facts: applicability and last-among-applicable.
  describe("floor is APPLICABLE and last when zero sources", () => {
    // The reported gap: Windows iPhone, email skipped + driver skipped.
    const zeroSourceCtx = endOfFlowContext({
      platform: "windows",
      phoneType: "iphone",
      emailConnected: false,
      emailSkipped: true,
      driverSetupComplete: false,
      driverSkipped: true,
    });

    it("floor is applicable (not skipped) when unmet", () => {
      const entry = floorEntry(zeroSourceCtx);
      expect(entry!.applicable).toBe(true);
    });

    it("floor is the LAST visible (applicable) step", () => {
      const visible = getVisibleEntries(
        buildOnboardingQueue(zeroSourceCtx.platform, zeroSourceCtx),
      );
      expect(visible[visible.length - 1].step.meta.id).toBe("data-source-floor");
    });

    it("the queue is NOT complete while the floor is applicable", () => {
      const queue = buildOnboardingQueue(zeroSourceCtx.platform, zeroSourceCtx);
      expect(isQueueComplete(queue)).toBe(false);
    });

    it("connecting a source (email) makes the floor non-applicable", () => {
      const connected = { ...zeroSourceCtx, emailConnected: true };
      const entry = floorEntry(connected);
      expect(entry!.applicable).toBe(false);
    });
  });

  describe("macOS zero-source dead-end (email skipped + FDA not granted)", () => {
    const macZeroSource = endOfFlowContext({
      platform: "macos",
      phoneType: "iphone",
      emailConnected: false,
      emailSkipped: true,
      permissionsGranted: false,
      driverSetupComplete: false,
    });

    it("floor is applicable on macOS too when unmet", () => {
      const entry = floorEntry(macZeroSource);
      expect(entry!.applicable).toBe(true);
    });

    it("granting FDA (permissionsGranted) makes the floor non-applicable", () => {
      const granted = { ...macZeroSource, permissionsGranted: true };
      const entry = floorEntry(granted);
      expect(entry!.applicable).toBe(false);
    });
  });
});
