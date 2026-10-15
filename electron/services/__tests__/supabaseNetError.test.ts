/**
 * @jest-environment node
 */

/**
 * BACKLOG-3768: Supabase network-error classification.
 *
 * Inputs are the measured shapes (Step 0 a745f5f6 / SR f3d7522a):
 *  - Electron net.fetch rejects with Error("net::ERR_*"), no cause, no code;
 *  - Node fetch rejects with TypeError("fetch failed") + cause.code;
 *  - auth-js errors come from a REAL supabase-js client (helpers/realAuthJsErrors).
 *
 * Controls: M1 (deep-link mapping), W6 (no raw message in the tag).
 */

import {
  CERT_FAILURE_COPY,
  NETWORK_FAILURE_COPY,
  authStepFromUrl,
  classifyNetError,
  deepLinkSessionErrorToPayload,
} from "../supabaseNetError";
import {
  apiError400Refresh,
  apiError401,
  retryable503Error,
  retryableCertError,
  retryableDnsError,
} from "../../__tests__/helpers/realAuthJsErrors";

function nodeFetchFailure(code: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as TypeError & { cause: unknown }).cause = Object.assign(new Error("x"), { code });
  return err;
}

describe("classifyNetError", () => {
  it.each([
    ["net::ERR_CERT_AUTHORITY_INVALID", "ERR_CERT_AUTHORITY_INVALID", true, true],
    ["net::ERR_CERT_KNOWN_INTERCEPTION_BLOCKED", "ERR_CERT_KNOWN_INTERCEPTION_BLOCKED", true, true],
    ["net::ERR_CERT_DATE_INVALID", "ERR_CERT_DATE_INVALID", false, true],
    ["net::ERR_SSL_PROTOCOL_ERROR", "ERR_SSL_PROTOCOL_ERROR", false, true],
    ["net::ERR_BAD_SSL_CLIENT_AUTH_CERT", "ERR_BAD_SSL_CLIENT_AUTH_CERT", false, true],
    ["net::ERR_NAME_NOT_RESOLVED", "ERR_NAME_NOT_RESOLVED", false, false],
    ["net::ERR_INTERNET_DISCONNECTED", "ERR_INTERNET_DISCONNECTED", false, false],
    ["net::ERR_CONNECTION_REFUSED", "ERR_CONNECTION_REFUSED", false, false],
    // Any Chromium name is accepted by pattern, not by a hand list.
    ["net::ERR_SOME_FUTURE_CODE_2", "ERR_SOME_FUTURE_CODE_2", false, false],
  ])("Electron %s -> %s (tls_intercept %s, cert %s)", (message, code, tls, cert) => {
    expect(classifyNetError(new Error(message))).toEqual({
      causeCode: code,
      tlsIntercept: tls,
      certClass: cert,
      aborted: false,
    });
  });

  it.each([
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", true, true],
    ["SELF_SIGNED_CERT_IN_CHAIN", true, true],
    ["CERT_HAS_EXPIRED", false, true],
    ["ENOTFOUND", false, false],
    ["ECONNRESET", false, false],
  ])("Node fetch failed + cause.code %s", (code, tls, cert) => {
    expect(classifyNetError(nodeFetchFailure(code))).toEqual({
      causeCode: code,
      tlsIntercept: tls,
      certClass: cert,
      aborted: false,
    });
  });

  it("abort / timeout -> ABORTED", () => {
    expect(classifyNetError(new DOMException("x", "TimeoutError")).causeCode).toBe("ABORTED");
    expect(classifyNetError(new DOMException("x", "AbortError")).aborted).toBe(true);
  });

  // W6: the tag is never the raw message.
  it.each([
    "user jane.doe@example.com not found",
    "https://x.supabase.co/rest/v1/users?email=eq.jane@example.com",
    "net::ERR_CERT_AUTHORITY_INVALID for jane@example.com",
    "fetch failed",
    "{}",
  ])("W6: message %p -> OTHER", (message) => {
    expect(classifyNetError(new Error(message)).causeCode).toBe("OTHER");
  });

  it("W6: an unknown Node cause code -> OTHER", () => {
    expect(classifyNetError(nodeFetchFailure("jane@example.com")).causeCode).toBe("OTHER");
  });
});

describe("authStepFromUrl", () => {
  it.each([
    ["https://x.supabase.co/auth/v1/user", "getUser"],
    ["https://x.supabase.co/auth/v1/token?grant_type=refresh_token", "refresh"],
    ["https://x.supabase.co/auth/v1/token?grant_type=password", "auth_other"],
    ["https://x.supabase.co/auth/v1/logout?scope=global", "auth_other"],
    ["https://x.supabase.co/rest/v1/users?email=eq.jane@example.com", "postgrest"],
    ["https://x.supabase.co/functions/v1/claim", "functions"],
    ["https://x.supabase.co/storage/v1/object/b/k", "storage"],
    ["not a url", "unknown"],
  ])("%s -> %s", (url, step) => {
    expect(authStepFromUrl(url)).toBe(step);
  });
});

describe("M1: deepLinkSessionErrorToPayload (real auth-js errors)", () => {
  it("cert failure -> CONNECTION_FAILED + secure copy + tls_intercept", async () => {
    expect(deepLinkSessionErrorToPayload(await retryableCertError())).toEqual({
      error: CERT_FAILURE_COPY,
      code: "CONNECTION_FAILED",
      causeCode: "ERR_CERT_AUTHORITY_INVALID",
      tlsIntercept: true,
    });
  });

  it("ERR_NAME_NOT_RESOLVED -> CONNECTION_FAILED + network copy", async () => {
    expect(deepLinkSessionErrorToPayload(await retryableDnsError())).toEqual({
      error: NETWORK_FAILURE_COPY,
      code: "CONNECTION_FAILED",
      causeCode: "ERR_NAME_NOT_RESOLVED",
      tlsIntercept: false,
    });
  });

  it("503 -> CONNECTION_FAILED + network copy", async () => {
    const p = deepLinkSessionErrorToPayload(await retryable503Error());
    expect(p.code).toBe("CONNECTION_FAILED");
    expect(p.error).toBe(NETWORK_FAILURE_COPY);
  });

  it("401 bad_jwt -> INVALID_TOKENS", async () => {
    expect(deepLinkSessionErrorToPayload(await apiError401()).code).toBe("INVALID_TOKENS");
  });

  it("400 refresh_token_not_found -> INVALID_TOKENS", async () => {
    expect(deepLinkSessionErrorToPayload(await apiError400Refresh()).code).toBe("INVALID_TOKENS");
  });

  it("no error object (session data missing user) -> INVALID_TOKENS", () => {
    expect(deepLinkSessionErrorToPayload(null).code).toBe("INVALID_TOKENS");
  });

  it("copy is the founder-approved text", () => {
    expect(CERT_FAILURE_COPY).toBe("Can't connect securely. Check your antivirus or network, then try again.");
    expect(NETWORK_FAILURE_COPY).toBe("Can't connect to Keepr. Check your network, then try again.");
  });
});
