/**
 * BACKLOG-3668 L3: scrub Google Messages (RCS) events in Sentry's beforeSend.
 *
 * An RCS error can carry a participant's phone number, an email, or a
 * message's words in its text. Events the RCS code sends are tagged
 * `component: "rcs"` (the RCS IPC handlers, via wrapHandler's sentryTags),
 * and the Sync outcome events carry `source: "google-messages"`. For those,
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

export function isRcsSentryEvent(event: SentryEventLike | null | undefined): boolean {
  const tags = event?.tags;
  return !!tags && (tags.component === RCS_SENTRY_TAGS.component || tags.source === RCS_OUTCOME_SOURCE);
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
