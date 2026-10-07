/**
 * Supabase network-error classification (BACKLOG-3768).
 *
 * Pure helpers shared by the main-process Supabase fetch wrapper
 * (`supabaseNetFetch.ts`) and the deep-link sign-in handler (`main.ts`).
 * No Electron import, so every branch is unit-testable.
 *
 * Inputs these helpers see:
 *  - Electron `net.fetch` rejects with a plain `Error` whose message is the
 *    Chromium error name, e.g. `net::ERR_CERT_AUTHORITY_INVALID`. No `.cause`,
 *    no `.code`.
 *  - Node's fetch (jest fallback) rejects with `TypeError: fetch failed` whose
 *    `.cause.code` is a Node/OpenSSL code, e.g. `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
 *  - auth-js turns a transport failure into `AuthRetryableFetchError` (status 0)
 *    carrying the original message, and a 500-530 into `AuthRetryableFetchError`
 *    with that status.
 *
 * PII rule: a returned `causeCode` is either a fixed Chromium/Node error name or
 * one of the literals OTHER / ABORTED. Never a message, URL or header.
 */

import { isAuthRetryableFetchError } from "@supabase/supabase-js";

export const CERT_FAILURE_COPY =
  "Can't connect securely. Check your antivirus or network, then try again.";
export const NETWORK_FAILURE_COPY =
  "Can't connect to Keepr. Check your network, then try again.";

/** Chromium codes are a fixed enum: any `net::ERR_*` name is accepted. */
const CHROMIUM_CODE_RE = /^net::(ERR_[A-Z0-9_]{1,64})$/;

/** Node / OpenSSL / undici codes (jest fallback and pre-fix history). */
const NODE_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Certificate issued by an issuer nobody on this machine trusts (or known MITM software). */
const TLS_INTERCEPT_CODES = new Set([
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CERT_KNOWN_INTERCEPTION_BLOCKED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

const NODE_CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export interface NetErrorClass {
  /** Allow-listed error name, or OTHER / ABORTED. Safe to tag and log. */
  causeCode: string;
  /** True when the certificate's issuer is not trusted (TLS interception class). */
  tlsIntercept: boolean;
  /** True for any certificate / TLS-handshake failure (selects the "securely" copy). */
  certClass: boolean;
  /** Abort / timeout: not a connectivity signal, never reported. */
  aborted: boolean;
}

function isCertCode(code: string): boolean {
  return (
    code.startsWith("ERR_CERT_") ||
    code.startsWith("ERR_SSL_") ||
    code === "ERR_BAD_SSL_CLIENT_AUTH_CERT" ||
    NODE_CERT_CODES.has(code)
  );
}

function readString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/**
 * Classify a failed request's error into a PII-free cause code.
 */
export function classifyNetError(err: unknown): NetErrorClass {
  const name = readString(err, "name");
  if (name === "AbortError" || name === "TimeoutError") {
    return { causeCode: "ABORTED", tlsIntercept: false, certClass: false, aborted: true };
  }

  let code: string | undefined;
  const message = readString(err, "message");
  const chromium = message ? CHROMIUM_CODE_RE.exec(message) : null;
  if (chromium) {
    code = chromium[1];
  } else {
    const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
    const candidates = [readString(cause, "code"), readString(err, "code")];
    code = candidates.find((c): c is string => !!c && NODE_CODES.has(c));
  }

  if (!code) {
    return { causeCode: "OTHER", tlsIntercept: false, certClass: false, aborted: false };
  }
  return {
    causeCode: code,
    tlsIntercept: TLS_INTERCEPT_CODES.has(code),
    certClass: isCertCode(code),
    aborted: false,
  };
}

/**
 * Which Supabase operation a request URL belongs to. Reads the PATH only;
 * the query string (PostgREST filters can hold emails) is never returned.
 */
export function authStepFromUrl(url: string): string {
  let pathname: string;
  let grantType: string | null = null;
  try {
    const u = new URL(url);
    pathname = u.pathname;
    grantType = u.searchParams.get("grant_type");
  } catch {
    return "unknown";
  }
  if (pathname.endsWith("/auth/v1/user")) return "getUser";
  if (pathname.endsWith("/auth/v1/token")) {
    return grantType === "refresh_token" ? "refresh" : "auth_other";
  }
  if (pathname.includes("/auth/v1/")) return "auth_other";
  if (pathname.includes("/rest/v1/")) return "postgrest";
  if (pathname.includes("/functions/v1/")) return "functions";
  if (pathname.includes("/storage/v1/")) return "storage";
  return "other";
}

export type DeepLinkSessionErrorCode = "CONNECTION_FAILED" | "INVALID_TOKENS";

export interface DeepLinkSessionErrorPayload {
  error: string;
  code: DeepLinkSessionErrorCode;
  causeCode: string;
  tlsIntercept: boolean;
}

/**
 * Map a deep-link `setSession` failure to the renderer payload.
 * Discriminator is `isAuthRetryableFetchError` ONLY (transport failures AND
 * 5xx). A 4xx `AuthApiError` (or a missing user) stays INVALID_TOKENS.
 * The copy is chosen from the parsed cause code, never from a 5xx message.
 */
export function deepLinkSessionErrorToPayload(err: unknown): DeepLinkSessionErrorPayload {
  if (isAuthRetryableFetchError(err)) {
    const cls = classifyNetError(err);
    return {
      error: cls.certClass ? CERT_FAILURE_COPY : NETWORK_FAILURE_COPY,
      code: "CONNECTION_FAILED",
      causeCode: cls.causeCode,
      tlsIntercept: cls.tlsIntercept,
    };
  }
  return {
    error: "Invalid authentication tokens",
    code: "INVALID_TOKENS",
    causeCode: "OTHER",
    tlsIntercept: false,
  };
}
