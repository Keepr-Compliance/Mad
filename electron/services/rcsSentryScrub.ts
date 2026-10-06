/**
 * BACKLOG-3668 L3: scrub Google Messages (RCS) events in Sentry's beforeSend.
 *
 * An RCS error can carry a participant's phone number, an email, or a
 * message's words in its text. Events the RCS code sends are tagged
 * `component: "rcs"` (the RCS IPC handlers, via wrapHandler's sentryTags),
 * and the Sync outcome events carry `source: "google-messages"`; an untagged
 * exception (unhandled rejection / uncaught error) counts when a stack frame
 * is in an RCS file. For those,
 * the message, the exception values, breadcrumb messages and string extras
 * go through {@link scrubRcsText}. Every other event is returned untouched
 * (the auto-updater scrub runs on its own, before this one).
 *
 * @module electron/services/rcsSentryScrub
 */

import { scrubRcsText } from "../utils/redactSensitive";
import type { SentryEventLike } from "./updateDiagnostics";

/** Sentry tags for an event raised by the RCS code. */
export const RCS_SENTRY_TAGS = { component: "rcs" } as const;

/** = RCS_SYNC_OUTCOME_SOURCE (rcsSyncOutcome.ts); pinned equal by a test. */
const RCS_OUTCOME_SOURCE = "google-messages";

/** Long enough for a stack-free error message; a title stays readable. */
const RCS_SCRUB_MAX = 500;

interface RcsSentryEventLike extends SentryEventLike {
  breadcrumbs?: Array<{ message?: string }>;
  extra?: Record<string, unknown>;
}

/**
 * A stack frame in an RCS module (rcsExtensionBridge, rcsImportHandlers,
 * rcsCache*, rcsImport*, db/rcs*…), source or compiled (tsc emits one .js per
 * file into dist-electron, so the name survives the build).
 */
const RCS_FRAME_FILE = /(?:^|[\\/])rcs[A-Z][\w-]*\.[cm]?[jt]s(?:$|[?#:])/;

interface FrameLike {
  filename?: unknown;
  abs_path?: unknown;
  module?: unknown;
}

/**
 * BACKLOG-3668 L3 (SR): an exception captured WITHOUT the rcs tag (an
 * unhandled rejection / uncaught error from RCS code reaches main.ts's
 * process handlers untagged) is still an RCS event when any of its stack
 * frames is in an RCS file.
 */
function hasRcsFrame(event: SentryEventLike): boolean {
  const values = (event.exception?.values ?? []) as Array<{ stacktrace?: { frames?: FrameLike[] } }>;
  for (const v of values) {
    for (const f of v?.stacktrace?.frames ?? []) {
      for (const p of [f?.filename, f?.abs_path, f?.module]) {
        if (typeof p === "string" && RCS_FRAME_FILE.test(p)) return true;
      }
    }
  }
  return false;
}

export function isRcsSentryEvent(event: SentryEventLike | null | undefined): boolean {
  if (!event) return false;
  const tags = event.tags;
  if (tags && (tags.component === RCS_SENTRY_TAGS.component || tags.source === RCS_OUTCOME_SOURCE)) return true;
  // The updater's own events keep the updater scrub only (never re-classified).
  if (tags?.component === "auto-updater") return false;
  return hasRcsFrame(event);
}

export function scrubRcsEventPII<T extends RcsSentryEventLike>(event: T): T {
  if (!event || !isRcsSentryEvent(event)) return event;
  const scrubbed: T = { ...event };
  if (scrubbed.exception?.values?.length) {
    scrubbed.exception = {
      ...scrubbed.exception,
      values: scrubbed.exception.values.map((value) =>
        typeof value?.value === "string" ? { ...value, value: scrubRcsText(value.value, RCS_SCRUB_MAX) } : value,
      ),
    };
  }
  if (typeof scrubbed.message === "string") scrubbed.message = scrubRcsText(scrubbed.message, RCS_SCRUB_MAX);
  if (Array.isArray(scrubbed.breadcrumbs)) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((b) =>
      typeof b?.message === "string" ? { ...b, message: scrubRcsText(b.message, RCS_SCRUB_MAX) } : b,
    );
  }
  if (scrubbed.extra && typeof scrubbed.extra === "object") {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(scrubbed.extra)) extra[k] = typeof v === "string" ? scrubRcsText(v, RCS_SCRUB_MAX) : v;
    scrubbed.extra = extra;
  }
  return scrubbed;
}
