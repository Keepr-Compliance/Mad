/**
 * Unit tests for the renderer-side PAYWALL_LOCKED detection helper (BACKLOG-2075).
 *
 * The export-unlock prompt and the bulk-export counter both depend on
 * isPaywallLockedError() correctly recognizing the machine-readable error
 * prefix that the main-process export handlers surface via wrapHandler as
 * `{ success:false, error:"PAYWALL_LOCKED: ..." }`.
 */

import { isPaywallLockedError, PAYWALL_LOCKED_ERROR } from "../entitlementService";

describe("isPaywallLockedError — detection contract", () => {
  it("PAYWALL_LOCKED_ERROR is the exact 'PAYWALL_LOCKED' code", () => {
    expect(PAYWALL_LOCKED_ERROR).toBe("PAYWALL_LOCKED");
  });

  it("returns true for the exact error the export gate throws", () => {
    // Mirrors PaywallLockedError's default message shape.
    expect(
      isPaywallLockedError("PAYWALL_LOCKED: This transaction is locked. Unlock it to export."),
    ).toBe(true);
  });

  it("returns true for the bare code prefix", () => {
    expect(isPaywallLockedError(PAYWALL_LOCKED_ERROR)).toBe(true);
  });

  it("returns false for unrelated errors, null, and undefined", () => {
    expect(isPaywallLockedError("Export failed")).toBe(false);
    expect(isPaywallLockedError("Transaction not found")).toBe(false);
    expect(isPaywallLockedError(null)).toBe(false);
    expect(isPaywallLockedError(undefined)).toBe(false);
    // A message that merely CONTAINS the code but doesn't start with it is not a match.
    expect(isPaywallLockedError("some error PAYWALL_LOCKED")).toBe(false);
  });
});
