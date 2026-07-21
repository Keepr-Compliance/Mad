/**
 * Unit tests for the queue builder pure functions.
 *
 * @module onboarding/queue/__tests__/buildQueue.test
 */

import type { OnboardingContext, OnboardingStep } from "../../types";
import type { StepQueueEntry } from "../types";
import {
  buildOnboardingQueue,
  isQueueComplete,
  getActiveEntry,
  getVisibleEntries,
} from "../buildQueue";
import { getFlowSteps } from "../../flows";

// =============================================================================
// MOCKS
// =============================================================================

jest.mock("../../flows", () => ({
  getFlowSteps: jest.fn(),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetFlowSteps = getFlowSteps as jest.MockedFunction<typeof getFlowSteps>;

// =============================================================================
// HELPERS
// =============================================================================

/** Create a minimal OnboardingContext for testing. */
function makeContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    platform: "macos",
    phoneType: null,
    emailConnected: undefined,
    connectedEmail: null,
    emailSkipped: false,
    driverSkipped: false,
    driverSetupComplete: false,
    permissionsGranted: undefined,
    termsAccepted: false,
    emailProvider: null,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: false,
    userId: null,
    isUserVerifiedInLocalDb: false,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

/** Create a minimal OnboardingStep for testing. */
function makeStep(
  id: string,
  opts: {
    isApplicable?: (ctx: OnboardingContext) => boolean;
    isComplete?: (ctx: OnboardingContext) => boolean;
  } = {}
): OnboardingStep {
  return {
    meta: {
      id: id as any,
      progressLabel: id,
      ...(opts.isApplicable && { isApplicable: opts.isApplicable }),
      ...(opts.isComplete && { isComplete: opts.isComplete }),
    },
    Content: (() => null) as any,
  } as OnboardingStep;
}

// =============================================================================
// TESTS: buildOnboardingQueue
// =============================================================================

describe("buildOnboardingQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("marks the first pending step as active", () => {
    const steps = [
      makeStep("step-a"),
      makeStep("step-b"),
      makeStep("step-c"),
    ];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", makeContext());

    expect(queue).toHaveLength(3);
    expect(queue[0].status).toBe("active");
    expect(queue[1].status).toBe("pending");
    expect(queue[2].status).toBe("pending");
  });

  it("marks completed steps before the active step", () => {
    const ctx = makeContext({ phoneType: "iphone" });
    const steps = [
      makeStep("phone-type", {
        isComplete: (c) => c.phoneType !== null,
      }),
      makeStep("step-b"),
      makeStep("step-c"),
    ];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", ctx);

    expect(queue[0].status).toBe("complete");
    expect(queue[0].applicable).toBe(true);
    expect(queue[1].status).toBe("active");
    expect(queue[2].status).toBe("pending");
  });

  it("marks non-applicable steps as skipped", () => {
    const steps = [
      makeStep("step-a"),
      makeStep("step-b", { isApplicable: () => false }),
      makeStep("step-c"),
    ];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", makeContext());

    expect(queue[0].status).toBe("active");
    expect(queue[1].status).toBe("skipped");
    expect(queue[1].applicable).toBe(false);
    expect(queue[2].status).toBe("pending");
  });

  it("defaults to applicable when isApplicable is not defined", () => {
    const steps = [makeStep("step-a")];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", makeContext());

    expect(queue[0].applicable).toBe(true);
  });

  it("defaults to not complete when isComplete is not defined", () => {
    const steps = [makeStep("step-a")];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", makeContext());

    expect(queue[0].status).toBe("active"); // not complete → active
  });

  it("handles all steps complete (no active entry)", () => {
    const ctx = makeContext({ phoneType: "iphone", termsAccepted: true });
    const steps = [
      makeStep("step-a", { isComplete: () => true }),
      makeStep("step-b", { isComplete: () => true }),
    ];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", ctx);

    expect(queue.every((e) => e.status === "complete")).toBe(true);
  });

  it("handles mixed complete, skipped, and pending steps", () => {
    const ctx = makeContext({ phoneType: "android" });
    const steps = [
      makeStep("phone-type", { isComplete: (c) => c.phoneType !== null }),
      makeStep("apple-driver", { isApplicable: (c) => c.phoneType === "iphone" }),
      makeStep("email-connect"),
      makeStep("permissions"),
    ];
    mockGetFlowSteps.mockReturnValue(steps);

    const queue = buildOnboardingQueue("macos", ctx);

    expect(queue[0].status).toBe("complete");   // phone selected
    expect(queue[1].status).toBe("skipped");     // not iPhone → skipped
    expect(queue[1].applicable).toBe(false);
    expect(queue[2].status).toBe("active");      // first pending → active
    expect(queue[3].status).toBe("pending");
  });

  it("returns empty array when getFlowSteps throws", () => {
    mockGetFlowSteps.mockImplementation(() => {
      throw new Error("Unknown platform");
    });

    const queue = buildOnboardingQueue("macos", makeContext());

    expect(queue).toEqual([]);
  });

  it("passes platform to getFlowSteps", () => {
    mockGetFlowSteps.mockReturnValue([]);

    buildOnboardingQueue("windows", makeContext());

    expect(mockGetFlowSteps).toHaveBeenCalledWith("windows");
  });
});

// =============================================================================
// TESTS: isQueueComplete
// =============================================================================

describe("isQueueComplete", () => {
  it("returns true when all applicable entries are complete", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "complete", applicable: true },
      { step: makeStep("b"), status: "complete", applicable: true },
      { step: makeStep("c"), status: "skipped", applicable: false },
    ];

    expect(isQueueComplete(queue)).toBe(true);
  });

  it("returns false when there is an active entry", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "complete", applicable: true },
      { step: makeStep("b"), status: "active", applicable: true },
    ];

    expect(isQueueComplete(queue)).toBe(false);
  });

  it("returns false when there is a pending entry", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "active", applicable: true },
      { step: makeStep("b"), status: "pending", applicable: true },
    ];

    expect(isQueueComplete(queue)).toBe(false);
  });

  it("returns true for empty queue", () => {
    expect(isQueueComplete([])).toBe(true);
  });

  it("returns true when all entries are skipped (non-applicable)", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "skipped", applicable: false },
      { step: makeStep("b"), status: "skipped", applicable: false },
    ];

    expect(isQueueComplete(queue)).toBe(true);
  });
});

// =============================================================================
// TESTS: getActiveEntry
// =============================================================================

describe("getActiveEntry", () => {
  it("returns the active entry", () => {
    const activeStep = makeStep("b");
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "complete", applicable: true },
      { step: activeStep, status: "active", applicable: true },
      { step: makeStep("c"), status: "pending", applicable: true },
    ];

    const result = getActiveEntry(queue);

    expect(result).toBeDefined();
    expect(result!.step.meta.id).toBe("b");
    expect(result!.status).toBe("active");
  });

  it("returns undefined when no active entry (all complete)", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "complete", applicable: true },
      { step: makeStep("b"), status: "complete", applicable: true },
    ];

    expect(getActiveEntry(queue)).toBeUndefined();
  });

  it("returns undefined for empty queue", () => {
    expect(getActiveEntry([])).toBeUndefined();
  });
});

// =============================================================================
// TESTS: getVisibleEntries
// =============================================================================

describe("getVisibleEntries", () => {
  it("filters out non-applicable (skipped) entries", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "complete", applicable: true },
      { step: makeStep("b"), status: "skipped", applicable: false },
      { step: makeStep("c"), status: "active", applicable: true },
      { step: makeStep("d"), status: "skipped", applicable: false },
      { step: makeStep("e"), status: "pending", applicable: true },
    ];

    const visible = getVisibleEntries(queue);

    expect(visible).toHaveLength(3);
    expect(visible.map((e) => e.step.meta.id)).toEqual(["a", "c", "e"]);
  });

  it("returns all entries when all are applicable", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "complete", applicable: true },
      { step: makeStep("b"), status: "active", applicable: true },
    ];

    expect(getVisibleEntries(queue)).toHaveLength(2);
  });

  it("returns empty array when all are non-applicable", () => {
    const queue: StepQueueEntry[] = [
      { step: makeStep("a"), status: "skipped", applicable: false },
    ];

    expect(getVisibleEntries(queue)).toHaveLength(0);
  });

  it("returns empty array for empty queue", () => {
    expect(getVisibleEntries([])).toHaveLength(0);
  });
});
