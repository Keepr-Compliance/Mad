/**
 * BACKLOG-3733 — test-only stand-ins for the shared text set the submit takes.
 *
 * Production code gets a `SelectedTextIds` only from a resolved export plan.
 * Suites that test something else (the audit-window bounds, the attachment
 * lookup) pass {@link ALL_TEXT_IDS} so the set filters nothing and their
 * assertions keep meaning exactly what they meant before the set existed.
 */
import type { SelectedTextIds } from "../../exportPlan";

/** A set that contains every id: the submit's queries behave as if unfiltered. */
export const ALL_TEXT_IDS = {
  has: () => true,
} as unknown as SelectedTextIds;

/** A set of exactly these ids. */
export function textIdsForTests(ids: Iterable<string>): SelectedTextIds {
  return new Set(ids) as unknown as SelectedTextIds;
}
