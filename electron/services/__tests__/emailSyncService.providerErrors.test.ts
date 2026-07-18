/**
 * TASK-2070: Tests for provider error classification helpers
 *
 * These helpers determine whether a provider fetch failure was caused by
 * an expired/revoked token (needs reconnect) or a transient/network error.
 */
import { isTokenExpiryError, classifyProviderError } from "../emailSyncService";

describe("isTokenExpiryError", () => {
  it("should detect HTTP 401 status on error object", () => {
    const error = { status: 401, message: "Unauthorized" };
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect HTTP 401 status on error.response", () => {
    const error = { response: { status: 401 }, message: "Request failed" };
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect AADSTS error codes", () => {
    const error = new Error("AADSTS50173: The provided token has expired.");
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect AADSTS700082 error code", () => {
    const error = new Error("AADSTS700082: The refresh token has expired due to inactivity.");
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect 'token expired' message", () => {
    const error = new Error("OAuth token expired. Please re-authenticate.");
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect 'access token expired and refresh failed' message", () => {
    const error = new Error("Microsoft access token expired and refresh failed. Please reconnect Outlook.");
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect 'invalid_grant' (Gmail token revoked)", () => {
    const error = new Error("invalid_grant: Token has been expired or revoked");
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should detect 'please reconnect' message", () => {
    const error = new Error("Microsoft access token expired. Please reconnect Outlook.");
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should NOT detect network errors", () => {
    const error = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND graph.microsoft.com" };
    expect(isTokenExpiryError(error)).toBe(false);
  });

  it("should NOT detect generic server errors", () => {
    const error = { response: { status: 500 }, message: "Internal Server Error" };
    expect(isTokenExpiryError(error)).toBe(false);
  });

  it("should NOT detect rate limit errors", () => {
    const error = { response: { status: 429 }, message: "Too Many Requests" };
    expect(isTokenExpiryError(error)).toBe(false);
  });

  it("should handle null/undefined error", () => {
    expect(isTokenExpiryError(null)).toBe(false);
    expect(isTokenExpiryError(undefined)).toBe(false);
  });

  it("should handle string error", () => {
    expect(isTokenExpiryError("some error")).toBe(false);
  });

  // BACKLOG-2127: microsoftAuthService.refreshToken now embeds the HTTP status
  // and OAuth error code (e.g. invalid_grant on a dead refresh token) into the
  // thrown message so it is classifiable — previously it threw a generic
  // "Failed to refresh access token" that this matcher could not detect.
  it("should classify the enriched Microsoft refresh error (invalid_grant) as token expiry", () => {
    const error = new Error(
      "Failed to refresh access token (status 400 invalid_grant)",
    );
    expect(isTokenExpiryError(error)).toBe(true);
  });

  it("should NOT classify the OLD generic refresh error message as token expiry", () => {
    // Regression guard: the pre-fix message was unclassifiable.
    const error = new Error("Failed to refresh access token");
    expect(isTokenExpiryError(error)).toBe(false);
  });
});

describe("classifyProviderError", () => {
  it("should return reconnect message for token expiry", () => {
    const error = new Error("Microsoft access token expired and refresh failed. Please reconnect Outlook.");
    expect(classifyProviderError(error)).toBe(
      "Your email connection has expired. Please reconnect in Settings."
    );
  });

  it("should return reconnect message for 401", () => {
    const error = { status: 401, message: "Unauthorized" };
    expect(classifyProviderError(error)).toBe(
      "Your email connection has expired. Please reconnect in Settings."
    );
  });

  it("should return generic message for non-token errors", () => {
    const error = new Error("Something went wrong with the API");
    expect(classifyProviderError(error)).toBe(
      "Could not reach your email provider. Showing cached results only."
    );
  });

  it("should return generic message for 500 errors", () => {
    const error = { response: { status: 500 }, message: "Internal Server Error" };
    expect(classifyProviderError(error)).toBe(
      "Could not reach your email provider. Showing cached results only."
    );
  });
});
