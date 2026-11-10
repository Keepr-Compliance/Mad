/**
 * BACKLOG-4175: run `decide()` over a batch for one surface (address pass or
 * detector) and split it into what passes and what a LIVE signal drops.
 *
 * Pure: no I/O, no logging. Every rule value (addresses, hosts, header names,
 * modes) comes from the rule set passed in; nothing here is a rule value.
 * The counts carry no address, host or account id, so a caller may log them.
 */
import type { SenderRuleMode, SenderRuleSet, SenderRuleSignal } from "./bundledRules";
import {
  decide,
  type FilterRow,
  type KeepRuleId,
  type KeepSets,
  type SenderDecision,
  type SenderFilterSurface,
  type SuppressRuleId,
} from "./senderFilter";

/** Is any signal live on this surface? (When none is, nothing can be dropped.) */
export function anySignalLive(rules: SenderRuleSet, surface: SenderFilterSurface): boolean {
  return (Object.keys(rules.modes) as SenderRuleSignal[]).some((s) => rules.modes[s][surface] === "live");
}

export interface SiteFilterCounts {
  /** Messages decided. */
  evaluated: number;
  /** Dropped because a live signal suppressed them. */
  liveDropped: number;
  /**
   * Per signal: its mode on this surface and how many messages it matched first
   * in precedence order (live or measure), so each message counts once.
   */
  bySignal: Record<SenderRuleSignal, { mode: SenderRuleMode; matched: number }>;
  /** Messages a keep rule saved from a suppress signal. */
  keptBy: Record<KeepRuleId, number>;
}

export interface SiteFilterResult<T> {
  passed: T[];
  /** `rule` is the live rule that dropped the item (`SenderDecision.liveRule`). */
  dropped: Array<{ item: T; rule: SuppressRuleId }>;
  counts: SiteFilterCounts;
}

export function filterForSurface<T>(
  items: readonly T[],
  toRow: (item: T) => FilterRow,
  rules: SenderRuleSet,
  surface: SenderFilterSurface,
  keep: KeepSets,
): SiteFilterResult<T> {
  const bySignal = {} as SiteFilterCounts["bySignal"];
  for (const s of Object.keys(rules.modes) as SenderRuleSignal[]) {
    bySignal[s] = { mode: rules.modes[s][surface], matched: 0 };
  }
  const counts: SiteFilterCounts = {
    evaluated: 0,
    liveDropped: 0,
    bySignal,
    keptBy: { K1: 0, K2: 0, K3: 0 },
  };
  const passed: T[] = [];
  const dropped: SiteFilterResult<T>["dropped"] = [];
  for (const item of items) {
    const d: SenderDecision = decide(toRow(item), rules, surface, keep);
    counts.evaluated++;
    if (d.outcome === "keep") counts.keptBy[d.rule as KeepRuleId]++;
    if (d.outcome === "suppress" && d.signal) counts.bySignal[d.signal].matched++;
    if (d.outcome === "suppress" && d.liveRule !== null) {
      counts.liveDropped++;
      dropped.push({ item, rule: d.liveRule });
    } else {
      passed.push(item);
    }
  }
  return { passed, dropped, counts };
}
