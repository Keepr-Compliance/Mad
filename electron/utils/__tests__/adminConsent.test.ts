/**
 * Tests for admin-consent block detection (BACKLOG-2007).
 */

import { isAdminConsentError } from "../adminConsent";

describe("isAdminConsentError (BACKLOG-2007)", () => {
  describe("matches admin-consent AADSTS codes", () => {
    it.each([
      "AADSTS65001: The user or administrator has not consented to use the application with ID 'x'.",
      "AADSTS90094: The grant requires administrator permission.",
      "AADSTS90093: Calling principal does not have required grant permissions.",
    ])("detects %s", (message) => {
      expect(isAdminConsentError(new Error(message))).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isAdminConsentError("aadsts90094 admin permission required")).toBe(
        true,
      );
    });
  });

  describe("matches textual admin-consent patterns without a code", () => {
    it.each([
      "Admin consent is required for this application.",
      "The administrator has not consented to the requested scopes.",
      "This action requires admin approval from your organization.",
      "consent_required",
    ])("detects %s", (message) => {
      expect(isAdminConsentError(message)).toBe(true);
    });
  });

  describe("does NOT match unrelated errors", () => {
    it.each([
      // Token-expiry AADSTS codes must NOT be treated as admin-consent blocks.
      "AADSTS50173: The provided grant has expired due to it being revoked.",
      "AADSTS700082: The refresh token has expired due to inactivity.",
      // Consumer/MSA-account block — not an admin-consent condition.
      "AADSTS50020: User account from identity provider does not exist in tenant.",
      // AADSTS900971 ("No reply address is registered") is a reply-URL / app-
      // registration misconfig, NOT an org admin-consent block — an IT admin
      // cannot fix it, so it must NOT route to the "Request IT approval" flow.
      "AADSTS900971: No reply address is registered for the application.",
      "Network request failed",
      "Mailbox authentication timed out",
      "invalid_grant",
      "",
    ])("ignores %s", (message) => {
      expect(isAdminConsentError(new Error(message))).toBe(false);
    });

    it("ignores null / undefined / non-error shapes", () => {
      expect(isAdminConsentError(null)).toBe(false);
      expect(isAdminConsentError(undefined)).toBe(false);
      expect(isAdminConsentError(42)).toBe(false);
    });
  });

  describe("accepts multiple input shapes", () => {
    it("plain string", () => {
      expect(isAdminConsentError("AADSTS90094 admin permission")).toBe(true);
    });
    it("object with message field", () => {
      expect(isAdminConsentError({ message: "AADSTS65001 not consented" })).toBe(
        true,
      );
    });
  });
});
