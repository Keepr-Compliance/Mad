/**
 * BACKLOG-4050: the last scrub every main-process `beforeSend` event passes,
 * whatever its tags. Renderer events reach the same `beforeSend` (they are
 * re-captured in main by @sentry/electron's IPC), so this covers both.
 *
 * Text fields lose the profile folder name, export-name addresses, user-chosen
 * file names, emails and phone numbers (`redactCrashReportText`):
 *   exception.values[*].value, message, logentry.message / formatted / params,
 *   string tag values, every string inside `extra`, every breadcrumb.
 *
 * Kept untouched, for support: exception type, stack frames (file and line),
 * mechanism, fingerprint, release, environment, contexts, user, tag keys and
 * every non-string value (record ids are strings but contain nothing a rule
 * matches).
 *
 * Pure (no Sentry or Electron import). Returns a copy and never mutates the
 * input. THROWS when a rule throws: the caller drops the event (fail-closed).
 */
import type { CrashReportScrubOptions } from "../utils/redactSensitive";
import { redactCrashReportText } from "../utils/redactSensitive";
import { scrubBreadcrumbOrThrow, scrubCrashReportValue } from "./sentryBreadcrumbScrub";

interface ExceptionValueLike {
  value?: unknown;
  [key: string]: unknown;
}

interface MainEventLike {
  message?: unknown;
  logentry?: { message?: unknown; formatted?: unknown; params?: unknown; [key: string]: unknown };
  exception?: { values?: ExceptionValueLike[]; [key: string]: unknown };
  tags?: { [key: string]: unknown };
  extra?: { [key: string]: unknown };
  breadcrumbs?: unknown[];
  [key: string]: unknown;
}

export function scrubMainEvent<T>(event: T, options: CrashReportScrubOptions = {}): T {
  if (event === null || typeof event !== "object") return event;
  const src = event as unknown as MainEventLike;
  const text = (s: string): string => redactCrashReportText(s, options);
  const out: MainEventLike = { ...src };

  if (typeof src.message === "string") out.message = text(src.message);

  if (src.logentry && typeof src.logentry === "object") {
    const logentry = { ...src.logentry };
    if (typeof logentry.message === "string") logentry.message = text(logentry.message);
    if (typeof logentry.formatted === "string") logentry.formatted = text(logentry.formatted);
    if (Array.isArray(logentry.params)) logentry.params = scrubCrashReportValue(logentry.params, options);
    out.logentry = logentry;
  }

  if (src.exception && typeof src.exception === "object" && Array.isArray(src.exception.values)) {
    out.exception = {
      ...src.exception,
      values: src.exception.values.map((v) =>
        v && typeof v === "object" && typeof v.value === "string" ? { ...v, value: text(v.value) } : v,
      ),
    };
  }

  if (src.tags && typeof src.tags === "object") {
    const tags: { [key: string]: unknown } = {};
    for (const [k, v] of Object.entries(src.tags)) tags[k] = typeof v === "string" ? text(v) : v;
    out.tags = tags;
  }

  if (src.extra && typeof src.extra === "object") {
    out.extra = scrubCrashReportValue(src.extra, options) as MainEventLike["extra"];
  }

  if (Array.isArray(src.breadcrumbs)) {
    out.breadcrumbs = src.breadcrumbs.map((b) =>
      b && typeof b === "object" ? scrubBreadcrumbOrThrow(b as { message?: string }, options) : b,
    );
  }

  return out as unknown as T;
}
