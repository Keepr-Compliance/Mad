/**
 * Paywall Funnel Analytics (BACKLOG-2014)
 *
 * Reads the already-flowing funnel events from the shared `analytics_events`
 * table and aggregates them into an ordered conversion funnel:
 *
 *     paywall-viewed -> unlock-clicked -> payment-succeeded -> export-completed
 *
 * The aggregation math lives in a PURE function (`computeFunnel`) so it can be
 * unit-tested independently of Supabase. `getPaywallFunnel` is a thin fetch
 * wrapper that pulls the raw rows (internal-role SELECT policy, BACKLOG-2014
 * migration) and hands them to `computeFunnel`.
 *
 * COUNTING MODEL
 *   Each step counts DISTINCT USERS who fired that event within the range. A
 *   funnel answers "how many people reached step N", so a single user firing
 *   `paywall-viewed` ten times counts once. Events with a null user_id (should
 *   not happen for funnel events, but the column is nullable) are ignored.
 *
 * CONVERSION MODEL
 *   Two percentages per step:
 *     - conversionFromPrev: distinct users at this step / distinct users at the
 *       PREVIOUS step (step-to-step drop-off). 0% when the previous step is empty.
 *     - conversionFromTop: distinct users at this step / distinct users at the
 *       TOP step (overall funnel yield). 0% when the top step is empty.
 *   The first step is always 100% for both (by definition).
 *
 * THE >100% EDGE CASE
 *   These are event counts, not a strict cohort: a user can complete an export
 *   without ever tripping the paywall for THIS transaction (e.g. a legacy/free
 *   unlock, or exporting a transaction that was already unlocked), so a later
 *   step can legitimately show MORE distinct users than an earlier one. Rather
 *   than silently clamp and hide the signal, we:
 *     - report the RAW percentage (may exceed 100),
 *     - clamp a separate `barPct` to [0, 100] for chart rendering,
 *     - set `exceedsPrevious: true` so the UI can flag it ("more exports than
 *       paywall views in range — expected when unlocked/legacy transactions are
 *       exported").
 */

/** The ordered funnel event names, top to bottom. */
export const FUNNEL_STEP_EVENTS = [
  'paywall-viewed',
  'unlock-clicked',
  'payment-succeeded',
  'export-completed',
] as const;

export type FunnelStepEvent = (typeof FUNNEL_STEP_EVENTS)[number];

/** Human-readable labels for each step. */
export const FUNNEL_STEP_LABELS: Record<FunnelStepEvent, string> = {
  'paywall-viewed': 'Paywall viewed',
  'unlock-clicked': 'Unlock clicked',
  'payment-succeeded': 'Payment succeeded',
  'export-completed': 'Export completed',
};

/**
 * Minimal shape of an analytics_events row the funnel needs. Kept structurally
 * loose (`event_name: string`) so callers can pass raw Supabase rows without a
 * cast; non-funnel event names are simply ignored.
 */
export interface FunnelEventRow {
  event_name: string;
  user_id: string | null;
}

export interface FunnelStep {
  event: FunnelStepEvent;
  label: string;
  /** Distinct users who fired this event in range. */
  userCount: number;
  /**
   * userCount / previous step userCount, as a percentage. Raw value — may
   * exceed 100 (see "THE >100% EDGE CASE"). 100 for the first step.
   */
  conversionFromPrev: number;
  /**
   * userCount / top step userCount, as a percentage. Raw value — may exceed
   * 100. 100 for the first step.
   */
  conversionFromTop: number;
  /** conversionFromPrev clamped to [0, 100] for bar/chart rendering. */
  barPct: number;
  /** True when userCount exceeds the previous step's userCount (raw > 100%). */
  exceedsPrevious: boolean;
}

export interface FunnelResult {
  steps: FunnelStep[];
  /** Distinct users at the top of the funnel (paywall-viewed). */
  topCount: number;
}

/** Round to one decimal place, avoiding floating-point noise like 33.33333. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Pure aggregation: raw analytics_events rows -> ordered funnel with counts and
 * conversion percentages. No I/O, no Supabase — safe to unit test directly.
 */
export function computeFunnel(rows: readonly FunnelEventRow[]): FunnelResult {
  // Distinct users per funnel event.
  const usersByEvent = new Map<FunnelStepEvent, Set<string>>();
  for (const event of FUNNEL_STEP_EVENTS) {
    usersByEvent.set(event, new Set<string>());
  }

  for (const row of rows) {
    if (!row.user_id) continue; // funnel counts identifiable users only
    const bucket = usersByEvent.get(row.event_name as FunnelStepEvent);
    if (bucket) bucket.add(row.user_id);
  }

  const counts = FUNNEL_STEP_EVENTS.map(
    (event) => usersByEvent.get(event)!.size
  );
  const topCount = counts[0];

  const steps: FunnelStep[] = FUNNEL_STEP_EVENTS.map((event, i) => {
    const userCount = counts[i];
    const prevCount = i === 0 ? userCount : counts[i - 1];

    const conversionFromPrev =
      i === 0 ? 100 : prevCount === 0 ? 0 : round1((userCount / prevCount) * 100);
    const conversionFromTop =
      i === 0 ? 100 : topCount === 0 ? 0 : round1((userCount / topCount) * 100);

    const barPct = Math.max(0, Math.min(100, conversionFromPrev));
    const exceedsPrevious = i > 0 && userCount > prevCount;

    return {
      event,
      label: FUNNEL_STEP_LABELS[event],
      userCount,
      conversionFromPrev,
      conversionFromTop,
      barPct,
      exceedsPrevious,
    };
  });

  return { steps, topCount };
}
