/**
 * BACKLOG-4040 S3: scrub every main-process breadcrumb, whatever its category.
 *
 * Breadcrumbs are kept on the Sentry scope, and the minidump integration writes
 * that scope to `userData/sentry/scope_v3.json` in PLAINTEXT (a hard-coded store
 * with no hook, so it cannot be sealed). Every main-process breadcrumb passes
 * `beforeBreadcrumb` before it reaches the scope, so redacting here is what keeps
 * emails and phone numbers out of that file. Before this, only HTTP breadcrumbs
 * were touched (their query string, BACKLOG-3768).
 *
 * BACKLOG-4050: every string also loses the profile folder name (`[user]`),
 * the address in app-generated export names (`[address]`) and user-chosen file
 * names (`[file]`); see `redactCrashReportText`. Ids, error codes and the app's
 * own paths (a child_process `spawnfile` under the install dir) are kept.
 *
 * Pure: no Sentry or Electron import; the host passes `homeDir` / `appRoots`.
 * `scrubBreadcrumb` never throws; `scrubBreadcrumbOrThrow` (used inside an
 * event, where a raw breadcrumb must not be sent) does.
 */
import { redactCrashReportText, type CrashReportScrubOptions } from "../utils/redactSensitive";
import { scrubHttpBreadcrumb } from "./httpBreadcrumbScrub";

interface BreadcrumbLike {
  type?: string;
  category?: string;
  message?: string;
  data?: { [key: string]: unknown };
}

const MAX_DEPTH = 6;

/**
 * Deep copy with every string redacted. Below MAX_DEPTH a non-string value is
 * returned as is.
 */
export function scrubCrashReportValue(value: unknown, options: CrashReportScrubOptions, depth = 0): unknown {
  if (typeof value === "string") return redactCrashReportText(value, options);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubCrashReportValue(v, options, depth + 1));
  const out: { [key: string]: unknown } = {};
  for (const [k, v] of Object.entries(value as { [key: string]: unknown })) {
    out[k] = scrubCrashReportValue(v, options, depth + 1);
  }
  return out;
}

/** Scrub one breadcrumb; THROWS if a rule throws. Returns a copy. */
export function scrubBreadcrumbOrThrow<T extends BreadcrumbLike>(breadcrumb: T, options: CrashReportScrubOptions = {}): T {
  const next: T = { ...breadcrumb };
  if (typeof next.message === "string") next.message = redactCrashReportText(next.message, options);
  if (next.data && typeof next.data === "object") next.data = scrubCrashReportValue(next.data, options) as T["data"];
  return scrubHttpBreadcrumb(next);
}

/** `beforeBreadcrumb`: scrub one breadcrumb; on a throw keep today's behaviour (the original, HTTP-scrubbed). */
export function scrubBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T, options: CrashReportScrubOptions = {}): T {
  try {
    return scrubBreadcrumbOrThrow(breadcrumb, options);
  } catch {
    return scrubHttpBreadcrumb(breadcrumb);
  }
}
