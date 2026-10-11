/**
 * BACKLOG-3363 C8: on Windows on ARM an installed Apple driver is NOT a working
 * texts source (the x64 driver cannot load), so it must not satisfy the
 * onboarding data-source floor.
 */
import type { OnboardingContext } from "../../types";
import { getSatisfyingSource, hasMinimumDataSource } from "../dataSourceFloor";

function makeContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    platform: "windows",
    phoneType: "iphone",
    emailConnected: false,
    connectedEmail: null,
    emailSkipped: true,
    driverSkipped: false,
    driverSetupComplete: true,
    permissionsGranted: undefined,
    termsAccepted: true,
    emailProvider: null,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: true,
    userId: null,
    isUserVerifiedInLocalDb: false,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

function setArmFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isWindowsArm64;
  else system.isWindowsArm64 = value;
}

afterEach(() => setArmFlag(undefined));

describe("data-source floor on Windows on ARM (BACKLOG-3363 C8)", () => {
  it("ARM (read from the bridge): iPhone + driverSetupComplete does NOT satisfy the floor", () => {
    setArmFlag(true);
    expect(getSatisfyingSource(makeContext())).toBeNull();
    expect(hasMinimumDataSource(makeContext())).toBe(false);
  });

  it("ARM (explicit): iPhone + driverSetupComplete does NOT satisfy the floor", () => {
    expect(getSatisfyingSource(makeContext(), true)).toBeNull();
  });

  it("ARM: email still satisfies the floor", () => {
    setArmFlag(true);
    expect(getSatisfyingSource(makeContext({ emailConnected: true }))).toBe("email");
  });

  it("normal Windows PC: iPhone + driverSetupComplete satisfies via texts-iphone-driver", () => {
    expect(getSatisfyingSource(makeContext())).toBe("texts-iphone-driver");
    setArmFlag(false);
    expect(getSatisfyingSource(makeContext())).toBe("texts-iphone-driver");
  });
});
