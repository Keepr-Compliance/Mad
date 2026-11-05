/**
 * BACKLOG-4130 — the email pre-cache run in the sync_outcomes corpus.
 *
 * The [PRECACHE-TIMING] line (BACKLOG-2960) answers "how long did this run
 * take" on ONE machine, in that machine's log. This module turns the same
 * record into a `SyncOutcomeRow`, so the run also lands in `sync_outcomes`
 * (source 'email-precache') through the existing fire-and-forget writer
 * (`syncOutcomeSupabase.recordSyncOutcome`) and the admin portal can report
 * first-sync and incremental timings across every install.
 *
 * PURE ON PURPOSE: types and `crypto` only. The caller owns the clock, the
 * transport and the moment of sending.
 *
 * PRIVACY — THIS BUILDER IS THE ONLY LEAK PATH
 * --------------------------------------------
 * `buildSyncOutcomeRow` copies `fields` by named key, so an unknown key in
 * `fields` never reaches the database. `sourceMetrics` is passed VERBATIM into
 * the jsonb column. So every key below is named, every value is checked, and
 * the input record is never spread. No subject, address, name, message id,
 * folder or local user id is read here, and none can be passed in: the input
 * type has no field for any of them.
 */

import { randomUUID } from "crypto";
import type { SyncOutcome, SyncOutcomeRow } from "./syncTimeline";
import type {
  EmailPrecacheMode,
  EmailPrecacheTimingOutcome,
  EmailPrecacheTimingRecord,
} from "./emailPrecacheTiming";

/** sync_outcomes.source for this run. */
export const EMAIL_PRECACHE_OUTCOME_SOURCE = "email-precache";

/** The mailbox providers a run can report. Anything else is dropped. */
const KNOWN_PROVIDERS = ["gmail", "outlook"] as const;

/** The run kinds the report groups by (sync_outcomes.run_kind). */
const KNOWN_MODES: readonly EmailPrecacheMode[] = ["cache", "re-cache", "force"];

/** A build string: "2.46.0", "2.46.0-beta.1", or "unknown". */
const BUILD_PATTERN = /^(unknown|\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]{1,32})?)$/;

const MAX_COUNT = 10_000_000;
const MAX_MS = 7 * 24 * 3600_000;
const MAX_WINDOW_MONTHS = 1200;

/**
 * The timing line says "success"; sync_outcomes' CHECK allows
 * complete | cancelled | error | running only. An unmapped "success" would be
 * refused by the database on every completed run.
 */
const OUTCOME_MAP: Record<EmailPrecacheTimingOutcome, SyncOutcome> = {
  success: "complete",
  error: "error",
  cancelled: "cancelled",
};

export function mapPrecacheOutcome(outcome: EmailPrecacheTimingOutcome): SyncOutcome {
  return OUTCOME_MAP[outcome] ?? "error";
}

/** A finite number >= 0, rounded and clamped; anything else is undefined. */
function count(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return Math.round(Math.min(v, max));
}

/** What the caller knows about the run besides the timing record. */
export interface EmailPrecacheRunContext {
  /** epoch ms at method entry — the same instant `elapsedMs` is measured from. */
  runStartedAt: number;
  /** The configured Email History window, in months. Omitted when the run
   *  ended before the preference was read. */
  windowMonths?: number;
  /** True when this run also fetched the gap between a widened window and the
   *  oldest cached mail (BACKLOG-3056). Without it, `checked` on such a run is
   *  not "new mail only". */
  backfill: boolean;
}

/**
 * The jsonb `source_metrics` for one run. Named keys only; never a spread.
 *
 * Keys: providers, checked, written, inserted (force swap only), dbMs, build,
 * windowMonths (when known), backfill.
 */
export function buildEmailPrecacheSourceMetrics(
  timing: EmailPrecacheTimingRecord,
  ctx: Pick<EmailPrecacheRunContext, "windowMonths" | "backfill">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.providers = KNOWN_PROVIDERS.filter((p) => timing.providers.includes(p));
  const checked = count(timing.checked, MAX_COUNT);
  if (checked !== undefined) out.checked = checked;
  const written = count(timing.written, MAX_COUNT);
  if (written !== undefined) out.written = written;
  const inserted = count(timing.inserted, MAX_COUNT);
  if (inserted !== undefined) out.inserted = inserted;
  const dbMs = count(timing.dbMs, MAX_MS);
  if (dbMs !== undefined) out.dbMs = dbMs;
  out.build =
    typeof timing.build === "string" && timing.build.length <= 48 && BUILD_PATTERN.test(timing.build)
      ? timing.build
      : "unknown";
  const windowMonths = count(ctx.windowMonths, MAX_WINDOW_MONTHS);
  if (windowMonths !== undefined) out.windowMonths = windowMonths;
  out.backfill = ctx.backfill === true;
  return out;
}

/**
 * The run as a `SyncOutcomeRow`, ready for `recordSyncOutcome`.
 *
 * `runKind` and `incremental` go in `fields` — `buildSyncOutcomeRow` reads them
 * from there (`str(f, "runKind")`, `bool(f, "incremental")`). A top-level key
 * would be silently dropped and the column left NULL.
 */
export function buildEmailPrecacheOutcomeRow(
  timing: EmailPrecacheTimingRecord,
  ctx: EmailPrecacheRunContext,
): SyncOutcomeRow {
  const mode = KNOWN_MODES.includes(timing.mode) ? timing.mode : undefined;
  return {
    source: EMAIL_PRECACHE_OUTCOME_SOURCE,
    outcome: mapPrecacheOutcome(timing.outcome),
    elapsedMs: count(timing.elapsedMs, MAX_MS) ?? 0,
    phases: [],
    fields: {
      ...(mode ? { runKind: mode } : {}),
      incremental: mode === "re-cache",
    },
    runId: randomUUID(),
    startedAt: ctx.runStartedAt,
    sourceMetrics: buildEmailPrecacheSourceMetrics(timing, ctx),
  };
}
