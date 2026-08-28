/**
 * BACKLOG-2914 — THE TRANSPORT. Where the sync outcome row actually goes.
 *
 * PR #2422 built a complete outcome row and sent it to `log.info`. The row was
 * correct and the founder verified it live; it simply never left his machine, so
 * the question the item exists to answer — *did syncs get worse after release X* —
 * was still unanswerable. This module is the half that was missing.
 *
 * AN EVENT, NOT A BREADCRUMB. This is the lesson of BACKLOG-2913/2950, and it is
 * not a style preference. `backupService.ts` has called `Sentry.addBreadcrumb` on
 * backup failure for months. Breadcrumbs are attached to an event when one is
 * captured and DISCARDED otherwise, and nothing on that path captures one — a
 * 30-day org-wide search returned exactly ONE backup issue, and none of the
 * founder's five real failures from 2026-08-27 appear anywhere at all. A test that
 * asserts `addBreadcrumb` was called reproduces that bug instead of catching it.
 *
 * WHY `captureMessage` AND NOT SOMETHING ELSE:
 *   - It is what this codebase already uses for a non-exception fact worth an issue
 *     (`backupService.ts`, the watchdog kill), so it needs no new precedent.
 *   - `captureEvent` would let us set `measurements`, but Sentry measurements are a
 *     SPAN/transaction concept: `setMeasurement` without an active span is a no-op
 *     and measurements on a message event are not surfaced. Numbers that went there
 *     would be silently dropped — a green call with no data behind it, which is the
 *     exact failure this item is recovering from. Numbers go in `extra`.
 *   - `startSpan`/transactions would model a sync well, but tracing is not enabled
 *     in this app's `Sentry.init` (no `tracesSampleRate`), so every span would be
 *     dropped at the client. Turning tracing on app-wide is a much larger change
 *     than this one, with its own quota and cost consequences.
 *
 * WHY TAGS ARE THE SHAPE THEY ARE: tags are the only INDEXED, searchable, and
 * groupable dimension on a Sentry event. `extra` is visible when you open one event
 * and invisible to search. So everything the founder needs to FILTER or COMPARE by
 * is a tag; everything he needs to READ once he has the event is extra. Durations
 * are both: bucketed as a tag (so drift per release is visible without a numeric
 * aggregation Sentry will not do for message events) and exact in extra.
 *
 * `release` is NOT set here. `Sentry.init` in `electron/main.ts` already sets
 * `release: app.getVersion()`, so every event carries it. Re-plumbing it would
 * create a second source of truth for the one dimension the whole item turns on.
 *
 * PRIVACY: the repo is public and Sentry is a third party. See `scrubOutcomeFields`.
 */

import * as Sentry from "@sentry/electron/main";
import log from "electron-log";
import type { SyncOutcomeRow } from "./syncTimeline";
import type { TimelineMeta } from "./syncTimeline";

/**
 * Key names that must never reach a sink, matched case-insensitively as substrings.
 *
 * The producers do not currently set any of these — `deviceSyncOrchestrator` picks
 * `productType`/`productVersion` off the device and deliberately leaves `udid`,
 * `serialNumber` and `name` behind. This is the guard for the NEXT producer, and for
 * BACKLOG-2952's other sources, which will add fields to `setContext` without
 * necessarily rereading that comment.
 *
 * `name` is in the list because the founder's device name is a personal nickname.
 * No legitimate field on the row today contains any of these substrings.
 */
const PII_KEY_PATTERN = /udid|uuid|serial|imei|name|path|email|phone|address|token|secret/i;

/**
 * A UDID by SHAPE, so a value smuggled under an innocent key is still dropped.
 *
 * Two forms ship in the wild: the pre-iPhone-X 40-hex-character identifier, and the
 * modern `00008030-001A2C3E1E88802E` (8 hex, dash, 16 hex). A key-name denylist alone
 * would not catch `{ deviceIdentifier: "<udid>" }`; this does. Stated plainly because
 * the limit matters: this pair catches the two shapes we know about, not arbitrary
 * free text hidden under a benign key.
 */
const UDID_VALUE_PATTERN = /^(?:[0-9a-f]{40}|[0-9A-F]{8}-[0-9A-F]{16})$/i;

/**
 * Drop anything that could identify a person or a device before it leaves the process.
 *
 * Applied to BOTH sinks. Returns a new object; never mutates the row.
 */
export function scrubOutcomeFields(fields: TimelineMeta): TimelineMeta {
  const safe: TimelineMeta = {};
  for (const [key, value] of Object.entries(fields)) {
    if (PII_KEY_PATTERN.test(key)) continue;
    if (typeof value === "string" && UDID_VALUE_PATTERN.test(value)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Coarse duration buckets, as a TAG.
 *
 * Sentry will not compute a p50 over `extra`, and message events carry no
 * measurements, so a bucket tag is the only way "syncs got slower in 2.31" is
 * visible as a shift in a tag distribution rather than by opening events one at a
 * time. Boundaries are wide on purpose: they are for spotting a shift, not for the
 * duration model, which is what the Supabase corpus is for.
 */
export function durationBucket(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown";
  const minutes = elapsedMs / 60000;
  if (minutes < 1) return "<1m";
  if (minutes < 5) return "1-5m";
  if (minutes < 15) return "5-15m";
  if (minutes < 30) return "15-30m";
  if (minutes < 60) return "30-60m";
  return ">60m";
}

/** Tag values must be primitives; Sentry stringifies and caps them. */
function tagValue(value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value);
}

/**
 * The filterable dimensions. Everything here is indexed by Sentry and usable in a
 * search or a tag breakdown; nothing here is unbounded in cardinality.
 *
 * `phases` is deliberately NOT a tag: it is a per-run string of a dozen numbers, so
 * every event would have a unique value and Sentry caps tag values at 200 characters
 * anyway. It goes in extra.
 */
export function buildOutcomeTags(row: SyncOutcomeRow): Record<string, string> {
  const safe = scrubOutcomeFields(row.fields);
  const tags: Record<string, string> = {
    source: row.source,
    outcome: row.outcome,
    duration_bucket: durationBucket(row.elapsedMs),
  };
  // Present only when the run established them — an absent dimension must stay
  // absent rather than become the string "undefined", the same rule `setContext`
  // enforces on the row itself.
  for (const key of ["priorBackup", "backupModeSource", "reason_code", "incremental"] as const) {
    const v = tagValue(safe[key] as string | number | boolean | undefined);
    if (v !== undefined) tags[key] = v;
  }
  return tags;
}

/**
 * Send the outcome row to Sentry as an EVENT.
 *
 * Emitted for SUCCESS as well as failure. A sync is a rare, deliberate act — there is
 * no volume problem — and the success events are the DENOMINATOR. Without them a rise
 * in failures and a rise in usage are the same shape in the data.
 */
export function reportOutcomeToSentry(row: SyncOutcomeRow): void {
  const tags = buildOutcomeTags(row);
  const extra: Record<string, unknown> = {
    ...scrubOutcomeFields(row.fields),
    // The array form as well as the flat string, so the per-phase numbers are
    // readable in the Sentry UI without parsing.
    phaseDurations: row.phases.map((p) => ({ phase: p.phase, elapsedMs: p.elapsedMs })),
  };

  Sentry.captureMessage(`Sync outcome: ${row.outcome}`, {
    // One level for all three outcomes. `outcome` is already a tag, so a severity
    // split would add nothing searchable while risking whatever alert rules exist.
    level: "info",
    tags,
    extra,
    // Explicit grouping so the three outcomes stay three stable issues no matter what
    // Sentry's message heuristics do, and so 2952's sources separate automatically
    // instead of being folded into these.
    fingerprint: ["sync-outcome", row.source, row.outcome],
  });
}

/**
 * The default reporter wired into the process-wide `syncTimeline`.
 *
 * Best-effort and NEVER throwing: this runs on the critical path of a sync that may
 * have taken the user an hour, and no telemetry sink is worth failing that. Each sink
 * is isolated so one being down does not cost the other.
 */
export function reportSyncOutcome(row: SyncOutcomeRow): void {
  try {
    reportOutcomeToSentry(row);
  } catch (error) {
    log.warn("[SyncOutcome] Sentry report failed; sync unaffected:", error);
  }
}

export default { reportSyncOutcome, reportOutcomeToSentry, scrubOutcomeFields, durationBucket };
