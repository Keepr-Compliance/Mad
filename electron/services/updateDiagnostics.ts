/**
 * Update Diagnostics — pure helpers for auto-updater failure telemetry.
 * BACKLOG-1903 (SPRINT-167 Auto-Updater Resilience, Phase B)
 *
 * PURE MODULE — no Electron, Sentry, fs, or logging imports. Every function is
 * deterministic and side-effect free so it can be fully unit-tested and reused
 * from `electron/main.ts` (the real `electron-updater` path) without pulling in
 * Electron runtime dependencies.
 *
 * Responsibilities:
 * - classifyUpdaterError(): fingerprint an updater error into ONE stable class
 *   so Sentry can group + search failures by type (instead of collapsing every
 *   verification failure into the generic "failed to verify" issue).
 * - extractUpdaterDiagnostics(): parse expected/actual sha512, sizes, feed/
 *   manifest URLs, and download mode (differential vs full) from the error +
 *   update info.
 * - sanitizeUpdaterUrl() / sanitizeUpdaterMessage(): [SECURITY] strip
 *   signed-token query params and never emit raw local filesystem paths.
 *
 * IMPORTANT: This module deliberately does NOT reuse the dead simulation stub
 * `electron/services/updateService.ts` (classifyUpdateError). That stub is not
 * wired into the real updater path and uses a different, coarser taxonomy.
 */

/**
 * Fingerprint classes for an auto-updater failure.
 * Ordering in classifyUpdaterError() matters: more specific classes are checked
 * before broader ones (e.g. checksum before network) so a checksum mismatch that
 * mentions a URL isn't misclassified as a network error.
 */
export type UpdaterErrorType =
  | "checksum_mismatch"
  | "signature_codesign"
  | "network_timeout"
  | "disk_space"
  | "permission"
  | "manifest_parse"
  | "feed_not_found"
  | "unknown";

/** Download mode inferred from the error / progress context. */
export type UpdaterDownloadMode = "differential" | "full" | "unknown";

/**
 * Structured, PII-safe diagnostic fields extracted from an updater failure.
 * Every string here is safe to send to Sentry (URLs are query-stripped, no
 * local filesystem paths). `undefined` fields are simply omitted by the caller.
 */
export interface UpdaterDiagnostics {
  /** Fingerprint class (also used as the Sentry `errorType` tag + fingerprint). */
  errorType: UpdaterErrorType;
  /** Version the client was trying to update TO (from update-available info). */
  targetVersion?: string;
  /** Update feed URL (e.g. latest.yml host), query params stripped. */
  feedUrl?: string;
  /** Specific manifest/asset URL parsed from the error, query params stripped. */
  manifestUrl?: string;
  /** sha512 the manifest declared (expected). */
  expectedSha512?: string;
  /** sha512 that was actually computed from the download (actual). */
  actualSha512?: string;
  /** Byte size the manifest declared for the target asset. */
  expectedSize?: number;
  /** Byte size actually downloaded, when reported. */
  actualSize?: number;
  /** differential (blockmap) vs full download. */
  downloadMode: UpdaterDownloadMode;
  /** Sanitized error message (query params stripped, truncated). */
  sanitizedMessage: string;
}

/**
 * Strip query strings from a URL so signed download tokens
 * (`X-Amz-Signature`, `X-Amz-Credential`, etc. present on
 * objects.githubusercontent.com redirects) never reach Sentry, and refuse to
 * emit anything that looks like a raw local filesystem path.
 *
 * [SECURITY — BACKLOG-1903] Everything this returns may be indexed by Sentry
 * (tags/context/extra/breadcrumbs), so it must be free of secrets and PII.
 *
 * @param value A URL or URL-bearing string. Non-strings return undefined.
 * @returns The URL with any `?...` query removed, or undefined if it is a local
 *          path / not usable.
 */
export function sanitizeUpdaterUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Refuse raw local filesystem paths — never write these to Sentry.
  // POSIX absolute (/Users/...), Windows drive (C:\...) or UNC (\\host\...),
  // and file:// URLs all carry usernames / machine layout.
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return undefined;
  }

  // Only http(s) URLs are considered safe feed/manifest URLs.
  if (!/^https?:\/\//i.test(trimmed)) return undefined;

  // Strip query string (and any fragment) — this is where signed tokens live.
  return trimmed.replace(/[?#].*$/s, "");
}

/**
 * Redact absolute local filesystem paths from a string, replacing each with a
 * `<path>` placeholder. Covers POSIX absolute paths, Windows drive paths, UNC
 * paths, and `file://` URLs. The username embedded in a home/cache path is PII,
 * and updater errors (esp. EACCES/ENOSPC) routinely carry it — so it must never
 * reach Sentry via the message body. [SECURITY — BACKLOG-1903]
 */
function redactLocalPaths(input: string): string {
  return (
    input
      // file:// URLs (with or without host) up to the next whitespace/quote.
      .replace(/file:\/\/\/?[^\s"')]+/gi, "<path>")
      // UNC paths: \\server\share\...
      .replace(/\\\\[^\s"')]+/g, "<path>")
      // Windows drive paths: C:\Users\... or C:/Users/...
      .replace(/\b[A-Za-z]:[\\/][^\s"')]*/g, "<path>")
      // POSIX absolute paths: /Users/..., /home/..., /private/var/...
      // Require at least one more segment so a bare "/" or a URL path isn't hit.
      .replace(/(?<![\w:/])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, "<path>")
  );
}

/**
 * Sanitize a free-form updater error message before it enters Sentry.
 * Strips query params from any embedded URLs (reusing the same query-stripper
 * the live handler already applied to `err.message`), redacts absolute local
 * filesystem paths (username is PII), and truncates.
 *
 * @param message Raw error message.
 * @param maxLength Max length before truncation (default 500).
 */
export function sanitizeUpdaterMessage(
  message: unknown,
  maxLength = 500,
): string {
  if (typeof message !== "string" || !message) return "Unknown error";
  // Strip query strings from any URL in the message (signed tokens live there).
  let sanitized = message.replace(/\?[^\s"')]*/g, "");
  // Redact absolute local filesystem paths (PII: embedded usernames).
  sanitized = redactLocalPaths(sanitized);
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + "...";
  }
  return sanitized;
}

/** Lowercase an error's message for keyword matching. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return (err.message || "").toLowerCase();
  if (typeof err === "string") return err.toLowerCase();
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m.toLowerCase();
  }
  return String(err ?? "").toLowerCase();
}

/**
 * Classify an updater error into exactly one {@link UpdaterErrorType}.
 *
 * Match order (specific → broad):
 *   1. checksum_mismatch   — sha512 / checksum / hash mismatch (expected vs got)
 *   2. signature_codesign  — code signing / signature / publisher validation
 *   3. feed_not_found      — HTTP 404 on latest.yml / release asset
 *   4. manifest_parse      — cannot parse latest.yml / YAML / unexpected token
 *   5. disk_space          — ENOSPC / no space / disk full
 *   6. permission          — EACCES / EPERM / read-only volume
 *   7. network_timeout     — net::, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, 5xx, socket
 *   8. unknown             — fallback
 *
 * feed_not_found is checked before generic network so a 404 on the manifest is
 * distinguished from transient connectivity failures (relevant to BACKLOG-1904).
 */
export function classifyUpdaterError(err: unknown): UpdaterErrorType {
  const msg = messageOf(err);
  if (!msg) return "unknown";

  // 1. Checksum / integrity verification failure.
  if (
    msg.includes("sha512") ||
    msg.includes("checksum") ||
    msg.includes("integrity") ||
    (msg.includes("hash") && (msg.includes("mismatch") || msg.includes("expected"))) ||
    (msg.includes("expected") && msg.includes("got"))
  ) {
    return "checksum_mismatch";
  }

  // 2. Code signature / publisher validation failure.
  if (
    msg.includes("code signature") ||
    msg.includes("codesign") ||
    msg.includes("not signed") ||
    msg.includes("signercertificate") ||
    msg.includes("publishername") ||
    msg.includes("signature verification") ||
    (msg.includes("signature") && !msg.includes("x-amz-signature")) ||
    msg.includes("is not trusted")
  ) {
    return "signature_codesign";
  }

  // 3. Feed / asset missing (HTTP 404 on latest.yml or the release asset).
  if (
    msg.includes("status code 404") ||
    msg.includes("statuscode: 404") ||
    (msg.includes("404") && (msg.includes("latest.yml") || msg.includes("latest-mac.yml") || msg.includes("latest-linux.yml"))) ||
    msg.includes("no published versions") ||
    msg.includes("cannot find")
  ) {
    return "feed_not_found";
  }

  // 4. Manifest parse failure (latest.yml unreadable / malformed).
  if (
    ((msg.includes("latest.yml") || msg.includes("latest-mac.yml") || msg.includes("yaml") || msg.includes("yml")) &&
      (msg.includes("parse") || msg.includes("unexpected") || msg.includes("invalid"))) ||
    msg.includes("cannot parse") ||
    msg.includes("unexpected token") ||
    msg.includes("end of the stream")
  ) {
    return "manifest_parse";
  }

  // 5. Disk space exhaustion.
  if (
    msg.includes("enospc") ||
    msg.includes("no space") ||
    msg.includes("disk full") ||
    (msg.includes("disk") && msg.includes("space"))
  ) {
    return "disk_space";
  }

  // 6. Filesystem permission / read-only volume.
  if (
    msg.includes("eacces") ||
    msg.includes("eperm") ||
    msg.includes("permission denied") ||
    msg.includes("read-only volume") ||
    msg.includes("readonly")
  ) {
    return "permission";
  }

  // 7. Network / connectivity / transient server failure.
  if (
    msg.includes("net::") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway timeout") ||
    /\b5\d\d\b/.test(msg)
  ) {
    return "network_timeout";
  }

  return "unknown";
}

/** Minimal shape of the electron-updater `UpdateInfo` we read (avoids a dep). */
export interface UpdaterUpdateInfoLike {
  version?: string;
  files?: Array<{ url?: string; sha512?: string; size?: number }>;
  path?: string;
  sha512?: string;
}

/**
 * Extract the first sha512 pair (expected vs actual/got) from an error message.
 * electron-updater emits e.g.:
 *   "sha512 checksum mismatch, expected AAAA, got BBBB"
 *   "checksum mismatch. expected: AAAA. actual: BBBB"
 */
function extractSha512Pair(msg: string): { expected?: string; actual?: string } {
  const result: { expected?: string; actual?: string } = {};
  // Token characters used by base64 sha512 output.
  const token = "[A-Za-z0-9+/=]{16,}";
  const expected = msg.match(new RegExp(`expected[:\\s]+["']?(${token})`, "i"));
  if (expected) result.expected = expected[1];
  const actual = msg.match(new RegExp(`(?:got|actual|received)[:\\s]+["']?(${token})`, "i"));
  if (actual) result.actual = actual[1];
  return result;
}

/** Extract a `size` / `actual size` byte count from an error message, if any. */
function extractActualSize(msg: string): number | undefined {
  // e.g. "size mismatch, expected 12345, got 6789" — capture the "got/actual" number.
  const m = msg.match(/(?:got|actual|received)[:\s]+(\d{3,})/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Find the first http(s) URL in a string. */
function firstUrlIn(msg: string): string | undefined {
  const m = msg.match(/https?:\/\/[^\s"')]+/i);
  return m ? m[0] : undefined;
}

/**
 * Infer differential vs full download from the error text / update info.
 * Differential downloads reference `.blockmap` or "differential"; a full
 * download falls back to the packaged installer asset.
 */
function inferDownloadMode(msg: string, hintDifferential?: boolean): UpdaterDownloadMode {
  if (hintDifferential === true) return "differential";
  if (msg.includes(".blockmap") || msg.includes("differential")) return "differential";
  if (
    msg.includes("cannot download differential") ||
    msg.includes("fallback") ||
    msg.includes("full download")
  ) {
    return "full";
  }
  return "unknown";
}

/**
 * Build the structured, PII-safe diagnostic payload for an updater failure.
 *
 * @param err The error emitted by `autoUpdater.on("error")`.
 * @param info The last `UpdateInfo` seen from `update-available` (optional).
 * @param opts.feedUrl Raw feed URL (from `autoUpdater.getFeedURL()`), sanitized here.
 * @param opts.differential Whether a differential download was known to be in flight.
 */
export function extractUpdaterDiagnostics(
  err: unknown,
  info?: UpdaterUpdateInfoLike,
  opts?: { feedUrl?: unknown; differential?: boolean },
): UpdaterDiagnostics {
  const rawMsg = err instanceof Error ? err.message : String(err ?? "");
  const lower = rawMsg.toLowerCase();

  const errorType = classifyUpdaterError(err);
  const sha = extractSha512Pair(rawMsg);

  // Expected size: the target file's declared size from the manifest.
  let expectedSize: number | undefined;
  if (info?.files && info.files.length > 0) {
    const withSize = info.files.find((f) => typeof f.size === "number");
    if (withSize && typeof withSize.size === "number") expectedSize = withSize.size;
  }

  // Expected sha512 can also come from the manifest info if not in the message.
  let expectedSha512 = sha.expected;
  if (!expectedSha512 && info?.files && info.files.length > 0) {
    const withHash = info.files.find((f) => typeof f.sha512 === "string");
    if (withHash?.sha512) expectedSha512 = withHash.sha512;
  } else if (!expectedSha512 && typeof info?.sha512 === "string") {
    expectedSha512 = info.sha512;
  }

  const manifestUrl =
    sanitizeUpdaterUrl(firstUrlIn(rawMsg)) ??
    sanitizeUpdaterUrl(info?.files?.[0]?.url);

  const diagnostics: UpdaterDiagnostics = {
    errorType,
    targetVersion: info?.version,
    feedUrl: sanitizeUpdaterUrl(opts?.feedUrl),
    manifestUrl,
    expectedSha512,
    actualSha512: sha.actual,
    expectedSize,
    actualSize: extractActualSize(rawMsg),
    downloadMode: inferDownloadMode(lower, opts?.differential),
    sanitizedMessage: sanitizeUpdaterMessage(rawMsg),
  };

  return diagnostics;
}
