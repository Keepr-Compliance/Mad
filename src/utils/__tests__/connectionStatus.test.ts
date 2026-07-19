/**
 * connectionStatus discriminator tests (BACKLOG-2127)
 *
 * These helpers are the single source of the "broken token vs NOT_CONNECTED"
 * decision shared by the sync path and the setup-prompt gate. They must key off
 * the typed ConnectionErrorType — NOT_CONNECTED is never "broken".
 */

import {
  BROKEN_TOKEN_TYPES,
  isBrokenTokenError,
  providerNeedsEmailSync,
  hasBrokenEmailToken,
} from "../connectionStatus";

describe("connectionStatus discriminators", () => {
  describe("isBrokenTokenError", () => {
    it.each(["TOKEN_REFRESH_FAILED", "TOKEN_EXPIRED", "CONNECTION_CHECK_FAILED"] as const)(
      "is true for %s",
      (type) => {
        expect(isBrokenTokenError({ type })).toBe(true);
      },
    );

    it("is false for NOT_CONNECTED (setup prompt's job, not an error)", () => {
      expect(isBrokenTokenError({ type: "NOT_CONNECTED" })).toBe(false);
    });

    it("is false for null / undefined error", () => {
      expect(isBrokenTokenError(null)).toBe(false);
      expect(isBrokenTokenError(undefined)).toBe(false);
    });

    it("excludes NOT_CONNECTED from the broken-token set", () => {
      expect(BROKEN_TOKEN_TYPES.has("NOT_CONNECTED" as never)).toBe(false);
    });
  });

  describe("providerNeedsEmailSync", () => {
    it("is true when connected", () => {
      expect(providerNeedsEmailSync({ connected: true, error: null })).toBe(true);
    });

    it("is true when the token is broken (must be prompted to reconnect)", () => {
      expect(
        providerNeedsEmailSync({ connected: false, error: { type: "TOKEN_REFRESH_FAILED", userMessage: "x" } }),
      ).toBe(true);
    });

    it("is false for a NOT_CONNECTED provider", () => {
      expect(
        providerNeedsEmailSync({ connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } }),
      ).toBe(false);
    });

    it("is false for undefined", () => {
      expect(providerNeedsEmailSync(undefined)).toBe(false);
    });
  });

  describe("hasBrokenEmailToken", () => {
    it("is true when either provider has a broken token", () => {
      expect(
        hasBrokenEmailToken({
          google: { connected: true, error: null },
          microsoft: { connected: false, error: { type: "TOKEN_EXPIRED", userMessage: "x" } },
        }),
      ).toBe(true);
    });

    it("is false when only NOT_CONNECTED / connected providers are present", () => {
      expect(
        hasBrokenEmailToken({
          google: { connected: false, error: { type: "NOT_CONNECTED", userMessage: "x" } },
          microsoft: { connected: true, error: null },
        }),
      ).toBe(false);
    });

    it("is false for undefined connections", () => {
      expect(hasBrokenEmailToken(undefined)).toBe(false);
    });
  });
});
