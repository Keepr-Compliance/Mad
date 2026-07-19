/**
 * BACKLOG-1821 — Unit tests for the data-source floor predicates.
 *
 * These assert on the *identity* of the satisfying source (which rule fires),
 * not just a boolean, so a wrong-but-truthy result cannot pass. The floor is
 * deliberately fail-open for Android (pairing is not observable in context) and
 * treats undefined-during-load as "not connected".
 *
 * @module onboarding/queue/__tests__/dataSourceFloor.test
 */

import type { OnboardingContext } from "../../types";
import {
  getSatisfyingSource,
  hasMinimumDataSource,
  type DataSourceKind,
} from "../dataSourceFloor";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Minimal context. Defaults represent the WORST case for the floor: no phone
 * type, nothing connected, everything unknown/false — i.e. floor unmet.
 */
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
    ...overrides,
  };
}

// =============================================================================
// TESTS: getSatisfyingSource — which rule satisfies the floor
// =============================================================================

describe("getSatisfyingSource (BACKLOG-1821)", () => {
  it("returns 'email' when a mailbox is connected (any platform, any phone)", () => {
    expect(
      getSatisfyingSource(makeContext({ emailConnected: true })),
    ).toBe<DataSourceKind>("email");
    // Email wins even for a Windows iPhone user with no driver.
    expect(
      getSatisfyingSource(
        makeContext({ platform: "windows", phoneType: "iphone", emailConnected: true }),
      ),
    ).toBe<DataSourceKind>("email");
  });

  it("returns 'texts-macos-fda' on macOS when Full Disk Access is granted (no email)", () => {
    expect(
      getSatisfyingSource(
        makeContext({ platform: "macos", permissionsGranted: true, emailConnected: false }),
      ),
    ).toBe<DataSourceKind>("texts-macos-fda");
  });

  it("treats linux like macOS for the FDA texts rule", () => {
    expect(
      getSatisfyingSource(makeContext({ platform: "linux", permissionsGranted: true })),
    ).toBe<DataSourceKind>("texts-macos-fda");
  });

  it("does NOT use permissionsGranted as a texts source on Windows (no FDA there)", () => {
    // Windows has no FDA step; permissionsGranted must not satisfy the floor.
    // With phoneType null and no driver/email, this is the zero-source case.
    expect(
      getSatisfyingSource(
        makeContext({ platform: "windows", permissionsGranted: true, phoneType: null }),
      ),
    ).toBeNull();
  });

  it("returns 'texts-iphone-driver' for an iPhone user with the driver installed", () => {
    expect(
      getSatisfyingSource(
        makeContext({
          platform: "windows",
          phoneType: "iphone",
          driverSetupComplete: true,
          emailConnected: false,
        }),
      ),
    ).toBe<DataSourceKind>("texts-iphone-driver");
  });

  it("does NOT satisfy the floor for an iPhone user who SKIPPED the driver", () => {
    expect(
      getSatisfyingSource(
        makeContext({
          platform: "windows",
          phoneType: "iphone",
          driverSetupComplete: false,
          driverSkipped: true,
          emailConnected: false,
        }),
      ),
    ).toBeNull();
  });

  it("returns 'texts-android' for an Android user (fail-open: pairing not observable)", () => {
    // Rule 4: phoneType === 'android' alone satisfies the floor because pairing
    // lives in component-local state, not context. Documented fail-open.
    expect(
      getSatisfyingSource(
        makeContext({ platform: "windows", phoneType: "android", emailConnected: false }),
      ),
    ).toBe<DataSourceKind>("texts-android");
    expect(
      getSatisfyingSource(makeContext({ platform: "macos", phoneType: "android" })),
    ).toBe<DataSourceKind>("texts-android");
  });

  it("prioritizes email over texts when both are present", () => {
    // Priority order is deterministic: email is checked first.
    expect(
      getSatisfyingSource(
        makeContext({ platform: "macos", emailConnected: true, permissionsGranted: true }),
      ),
    ).toBe<DataSourceKind>("email");
  });

  it("returns null (floor unmet) for the zero-source dead-end", () => {
    // macOS iPhone: email skipped + FDA not granted.
    expect(
      getSatisfyingSource(
        makeContext({
          platform: "macos",
          phoneType: "iphone",
          emailConnected: false,
          emailSkipped: true,
          permissionsGranted: false,
        }),
      ),
    ).toBeNull();
    // Windows iPhone: email skipped + driver skipped (the primary reported gap).
    expect(
      getSatisfyingSource(
        makeContext({
          platform: "windows",
          phoneType: "iphone",
          emailConnected: false,
          emailSkipped: true,
          driverSkipped: true,
        }),
      ),
    ).toBeNull();
  });

  it("treats undefined-during-load as NOT connected (no spurious satisfy)", () => {
    // emailConnected/permissionsGranted are `boolean | undefined`. A half-loaded
    // context (both undefined, no phone type) must NOT satisfy the floor.
    expect(
      getSatisfyingSource(
        makeContext({
          emailConnected: undefined,
          permissionsGranted: undefined,
          phoneType: null,
        }),
      ),
    ).toBeNull();
  });
});

// =============================================================================
// TESTS: hasMinimumDataSource — boolean wrapper
// =============================================================================

describe("hasMinimumDataSource (BACKLOG-1821)", () => {
  it("is true whenever a source satisfies the floor", () => {
    expect(hasMinimumDataSource(makeContext({ emailConnected: true }))).toBe(true);
    expect(
      hasMinimumDataSource(makeContext({ platform: "macos", permissionsGranted: true })),
    ).toBe(true);
    expect(
      hasMinimumDataSource(
        makeContext({ phoneType: "iphone", driverSetupComplete: true }),
      ),
    ).toBe(true);
    expect(hasMinimumDataSource(makeContext({ phoneType: "android" }))).toBe(true);
  });

  it("is false for the zero-source dead-end", () => {
    expect(
      hasMinimumDataSource(
        makeContext({
          platform: "windows",
          phoneType: "iphone",
          emailSkipped: true,
          driverSkipped: true,
        }),
      ),
    ).toBe(false);
  });

  it("is false while the context is still loading (all unknown)", () => {
    expect(hasMinimumDataSource(makeContext())).toBe(false);
  });
});
