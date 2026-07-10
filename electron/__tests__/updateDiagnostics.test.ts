/**
 * @jest-environment node
 */

/**
 * Unit tests for updateDiagnostics.ts (BACKLOG-1903).
 *
 * Covers:
 * - classifyUpdaterError() fingerprinting against realistic electron-updater
 *   error strings for every fingerprint class.
 * - sanitizeUpdaterUrl() / sanitizeUpdaterMessage() [SECURITY]: signed download
 *   tokens (X-Amz-Signature etc.) and raw local filesystem paths must never
 *   survive into anything Sentry could index.
 * - extractUpdaterDiagnostics() field extraction (sha512, sizes, URLs, mode).
 */

import {
  classifyUpdaterError,
  sanitizeUpdaterUrl,
  sanitizeUpdaterMessage,
  extractUpdaterDiagnostics,
  type UpdaterErrorType,
} from "../services/updateDiagnostics";

describe("classifyUpdaterError", () => {
  const cases: Array<[string, UpdaterErrorType]> = [
    // checksum
    [
      "sha512 checksum mismatch, expected Zm9vYmFyYmF6cXV4, got YmFyYmF6cXV4Zm9v",
      "checksum_mismatch",
    ],
    ["Checksum mismatch. Expected: AAAA. Actual: BBBB", "checksum_mismatch"],
    ["File integrity check failed (hash mismatch)", "checksum_mismatch"],
    // signature / codesign
    [
      "New version 2.21.0 is not signed by the application owner: SignerCertificate mismatch",
      "signature_codesign",
    ],
    ['Could not get code signature for running application', "signature_codesign"],
    ["publisherName check failed: expected Keepr", "signature_codesign"],
    // feed not found (404)
    [
      "HttpError: 404 Not Found while fetching https://github.com/Keepr-Compliance/keepr-releases/releases/latest/download/latest.yml",
      "feed_not_found",
    ],
    ["Cannot find latest-mac.yml in the latest release artifacts", "feed_not_found"],
    // manifest parse
    [
      "Cannot parse latest.yml: unexpected token at line 3",
      "manifest_parse",
    ],
    ["YAML parse error: end of the stream", "manifest_parse"],
    // disk space
    ["ENOSPC: no space left on device, write", "disk_space"],
    ["Update failed: disk full", "disk_space"],
    // permission
    ["EACCES: permission denied, open '/Applications/Keepr.app'", "permission"],
    ["Cannot update while running on a read-only volume", "permission"],
    // network / timeout
    ["net::ERR_CONNECTION_RESET", "network_timeout"],
    ["ETIMEDOUT: connection timed out", "network_timeout"],
    ["ENOTFOUND github.com", "network_timeout"],
    ["HttpError: 503 Service Unavailable", "network_timeout"],
    ["socket hang up", "network_timeout"],
    // unknown
    ["Something completely unexpected happened", "unknown"],
    ["", "unknown"],
  ];

  it.each(cases)("classifies %j as %s", (message, expected) => {
    expect(classifyUpdaterError(new Error(message))).toBe(expected);
  });

  it("accepts a plain string as well as an Error", () => {
    expect(classifyUpdaterError("sha512 checksum mismatch")).toBe("checksum_mismatch");
  });

  it("returns unknown for null/undefined/non-error inputs", () => {
    expect(classifyUpdaterError(null)).toBe("unknown");
    expect(classifyUpdaterError(undefined)).toBe("unknown");
    expect(classifyUpdaterError(42)).toBe("unknown");
  });

  it("does NOT misclassify a signed URL's X-Amz-Signature as a codesign error", () => {
    // A network/checksum error whose message embeds a signed GitHub URL must
    // not be pulled into signature_codesign by the word "signature".
    const msg =
      "net::ERR_CONNECTION_RESET while fetching https://objects.githubusercontent.com/x?X-Amz-Signature=deadbeef";
    expect(classifyUpdaterError(new Error(msg))).toBe("network_timeout");
  });
});

describe("sanitizeUpdaterUrl [SECURITY]", () => {
  it("strips signed-token query params from a GitHub objects redirect", () => {
    const raw =
      "https://objects.githubusercontent.com/github-production-release-asset/1/keepr.exe?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE&X-Amz-Signature=abcdef1234567890";
    const out = sanitizeUpdaterUrl(raw);
    expect(out).toBe(
      "https://objects.githubusercontent.com/github-production-release-asset/1/keepr.exe",
    );
    expect(out).not.toContain("X-Amz-Signature");
    expect(out).not.toContain("X-Amz-Credential");
    expect(out).not.toContain("?");
  });

  it("strips fragments as well as query strings", () => {
    expect(sanitizeUpdaterUrl("https://example.com/latest.yml#frag?x=1")).toBe(
      "https://example.com/latest.yml",
    );
  });

  it("refuses raw POSIX local filesystem paths", () => {
    expect(sanitizeUpdaterUrl("/Users/daniel/Library/Caches/keepr/pending/x.exe")).toBeUndefined();
  });

  it("refuses Windows drive + UNC paths and file:// URLs", () => {
    expect(sanitizeUpdaterUrl("C:\\Users\\daniel\\AppData\\keepr\\x.exe")).toBeUndefined();
    expect(sanitizeUpdaterUrl("\\\\server\\share\\keepr\\x.exe")).toBeUndefined();
    expect(sanitizeUpdaterUrl("file:///Users/daniel/x.exe")).toBeUndefined();
  });

  it("returns undefined for non-strings / empty / non-http", () => {
    expect(sanitizeUpdaterUrl(undefined)).toBeUndefined();
    expect(sanitizeUpdaterUrl(null)).toBeUndefined();
    expect(sanitizeUpdaterUrl(123)).toBeUndefined();
    expect(sanitizeUpdaterUrl("")).toBeUndefined();
    expect(sanitizeUpdaterUrl("ftp://example.com/x")).toBeUndefined();
  });
});

describe("sanitizeUpdaterMessage [SECURITY]", () => {
  it("strips query params from URLs embedded in the message", () => {
    const raw =
      "Cannot download https://objects.githubusercontent.com/x?X-Amz-Signature=secret checksum failed";
    const out = sanitizeUpdaterMessage(raw);
    expect(out).not.toContain("X-Amz-Signature");
    expect(out).not.toContain("secret");
    expect(out).toContain("https://objects.githubusercontent.com/x");
  });

  it("truncates very long messages", () => {
    const out = sanitizeUpdaterMessage("x".repeat(2000), 500);
    expect(out.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(out.endsWith("...")).toBe(true);
  });

  it("returns a safe default for empty / non-string input", () => {
    expect(sanitizeUpdaterMessage("")).toBe("Unknown error");
    expect(sanitizeUpdaterMessage(undefined)).toBe("Unknown error");
    expect(sanitizeUpdaterMessage(null)).toBe("Unknown error");
  });
});

describe("extractUpdaterDiagnostics", () => {
  it("extracts expected/actual sha512 from a checksum error message", () => {
    const err = new Error(
      "sha512 checksum mismatch, expected Zm9vYmFyYmF6cXV4c3R1dg==, got YmFyYmF6cXV4c3R1dmZvbw==",
    );
    const d = extractUpdaterDiagnostics(err, { version: "2.21.0" });
    expect(d.errorType).toBe("checksum_mismatch");
    expect(d.targetVersion).toBe("2.21.0");
    expect(d.expectedSha512).toBe("Zm9vYmFyYmF6cXV4c3R1dg==");
    expect(d.actualSha512).toBe("YmFyYmF6cXV4c3R1dmZvbw==");
  });

  it("pulls expected size + sha512 from update info when absent from the message", () => {
    const err = new Error("Update download failed");
    const d = extractUpdaterDiagnostics(err, {
      version: "2.21.0",
      files: [{ url: "keepr-2.21.0.exe", sha512: "TUFOSUZFU1RTSEE1MTI=", size: 123456789 }],
    });
    expect(d.expectedSize).toBe(123456789);
    expect(d.expectedSha512).toBe("TUFOSUZFU1RTSEE1MTI=");
  });

  it("sanitizes a signed manifest URL parsed from the message [SECURITY]", () => {
    const err = new Error(
      "Cannot download https://objects.githubusercontent.com/asset/keepr.exe?X-Amz-Signature=abc123 : checksum failed",
    );
    const d = extractUpdaterDiagnostics(err);
    expect(d.manifestUrl).toBe("https://objects.githubusercontent.com/asset/keepr.exe");
    expect(d.manifestUrl).not.toContain("X-Amz-Signature");
  });

  it("sanitizes the raw feed URL passed via opts [SECURITY]", () => {
    const d = extractUpdaterDiagnostics(new Error("boom"), undefined, {
      feedUrl: "https://github.com/Keepr-Compliance/keepr-releases?token=secret",
    });
    expect(d.feedUrl).toBe("https://github.com/Keepr-Compliance/keepr-releases");
    expect(d.feedUrl).not.toContain("secret");
  });

  it("infers differential download mode from a blockmap error", () => {
    const err = new Error("Cannot download keepr-2.21.0.exe.blockmap differential");
    const d = extractUpdaterDiagnostics(err);
    expect(d.downloadMode).toBe("differential");
  });

  it("honors an explicit differential hint from opts", () => {
    const d = extractUpdaterDiagnostics(new Error("boom"), undefined, { differential: true });
    expect(d.downloadMode).toBe("differential");
  });

  it("never emits a local path as manifestUrl [SECURITY]", () => {
    const err = new Error(
      "Error: EACCES writing /Users/daniel/Library/Caches/keepr-updater/pending/keepr.exe",
    );
    const d = extractUpdaterDiagnostics(err);
    expect(d.manifestUrl).toBeUndefined();
    expect(d.sanitizedMessage).toContain("EACCES");
  });
});
