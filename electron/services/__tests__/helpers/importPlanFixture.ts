/**
 * Test fixture helper for BACKLOG-2772 import plans.
 *
 * Builds plans by running the REAL `resolveImportPlan`, never by hand. A
 * hand-written `ImportPlan` literal could describe a combination the resolver
 * cannot produce — `fetchStartISO: null` next to a non-null `cutoffNano`, or an
 * `overrides` entry sitting on an unbounded "All time" window — and any test
 * driven by such a fixture would be asserting against a state that can never
 * reach production. `exportPlanFixture.ts` (BACKLOG-2771) exists for exactly
 * this reason on the export side; this is its mirror.
 *
 * Callers state what the SYSTEM knows at the moment of an import — the stored
 * preference object, the audit periods of the user's non-rejected deals, and
 * (for the transaction trigger) the start date this particular run must reach
 * back to — and get back exactly what that entry point would fetch from.
 */

import { MAC_EPOCH } from "../../../constants";
import {
  resolveImportPlan,
  type AuditSpan,
  type ImportMode,
  type ImportPlan,
  type StoredImportFilters,
} from "../../importPlan";

const NANOS_PER_MS = 1_000_000;

/**
 * The pinned clock for every import-plan assertion.
 *
 * The lookback boundary is `now - N months`, so an unpinned clock makes every
 * window assertion drift daily. This is the date the founder settled D2' and
 * Cap'.
 *
 * The day-of-month is 20 DELIBERATELY. `Date.prototype.setMonth` — which is
 * what `computeImportCutoffNano` uses — rolls a day-31 date forward into the
 * following month (Jan 31 minus one month is Mar 3), so a month-end `now` would
 * make `monthsBack` below disagree with the boundary the resolver computes for
 * some month counts and not others. Do not move `FIXED_NOW` past the 28th.
 */
export const FIXED_NOW = new Date("2026-08-20T12:00:00.000Z");

/** What a caller asks the fixture for. Mirrors `ImportPlanRequest` plus `now`. */
export interface TestImportPlanOptions {
  /** Defaults to "delta" — the plain Import button. */
  mode?: ImportMode;
  /**
   * The stored `messageImport.filters` object. Absent (the default) means the
   * user has never touched Settings; `null` is what a caller passes when the
   * preference read came back empty. Both are "no preference", and the resolver
   * must treat them alike.
   */
  storedFilters?: StoredImportFilters | null;
  /** Audit periods of NON-REJECTED deals. */
  auditSpans?: AuditSpan[];
  /** The transaction trigger's `proposedStartISO`. */
  requestedStartISO?: string | null;
  /** Override the pinned clock (only the boundary sweep needs this). */
  now?: Date;
}

/**
 * Resolve one import plan through the REAL resolver.
 *
 * Defaults describe the most common run: the plain Import button, no stored
 * preferences, no deals, no explicit lower bound.
 */
export function testImportPlan(options: TestImportPlanOptions = {}): ImportPlan {
  return resolveImportPlan(
    {
      mode: options.mode ?? "delta",
      storedFilters: options.storedFilters,
      auditSpans: options.auditSpans,
      requestedStartISO: options.requestedStartISO,
    },
    options.now ?? FIXED_NOW,
  );
}

/**
 * The instant `months` before `now`, using the SAME local-calendar arithmetic
 * `computeImportCutoffNano` uses (`setMonth(getMonth() - months)`).
 *
 * Re-derived here rather than written as a hardcoded ISO literal because
 * `setMonth` operates on LOCAL calendar fields: "2026-05-20T12:00:00Z" is the
 * right answer on a UTC CI runner and the wrong one on any machine where a DST
 * transition falls inside the window. `jest.config.js` pins no `TZ`, and this
 * repo is developed on America/Costa_Rica and built on UTC runners.
 *
 * The month count is ALWAYS supplied explicitly by the caller (`monthsBack(3)`),
 * never read from `DEFAULT_LOOKBACK_MONTHS`. Reading the constant would let a
 * mutated default move the expectation along with the code and leave the test
 * green — the exact failure mode BACKLOG-2561 was made of.
 */
export function monthsBack(months: number, now: Date = FIXED_NOW): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

/** `monthsBack` as the ISO instant a plan's `fetchStartISO` carries. */
export function monthsBackISO(months: number, now: Date = FIXED_NOW): string {
  return monthsBack(months, now).toISOString();
}

/**
 * ISO instant to Apple-epoch nanoseconds — the unit `message.date` is stored in
 * and the unit `cutoffNano` / `ProtectedSpan` are expressed in.
 *
 * One test asserts hand-computed nanosecond LITERALS against this conversion
 * (see "the Apple-epoch conversion itself"), so the helper cannot quietly agree
 * with a resolver that has drifted.
 */
export function toAppleNano(iso: string): number {
  return (new Date(iso).getTime() - MAC_EPOCH) * NANOS_PER_MS;
}

/** The ISO instant `deltaMs` milliseconds away from `iso`. */
export function shiftISO(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

/** One non-rejected deal's audit period. `endISO` null = still open. */
export function span(startISO: string, endISO: string | null = null): AuditSpan {
  return { startISO, endISO };
}
