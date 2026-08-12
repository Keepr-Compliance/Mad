/**
 * PER-SOURCE COUNTS FOR THE SOURCE FILTER DROPDOWN (BACKLOG-2671)
 *
 * ===========================================================================
 * WHY THESE NUMBERS LIVE IN THE DROPDOWN AND NOT IN THE HEADER
 * ===========================================================================
 * BACKLOG-2662 put the per-source breakdown in the contacts header, as a
 * sentence:
 *
 *     1175 contacts (1168 from Contacts App, 5 from Outlook, 2 from From Texts)
 *
 * It was correct and it was unusable. The sentence grows with every connected
 * source, so it crowded the "Review N possible duplicates" button beside it —
 * two primary controls, either able to displace the other — and it rendered
 * "from From Texts", because a label that reads correctly as a filter row reads
 * badly inside a sentence.
 *
 * The founder's ruling (BACKLOG-2671) is that the counts belong in the control
 * that already exists to answer "which sources": the filter itself. The header
 * goes back to `1175 contacts`. Moving them dissolves the doubled "from" without
 * touching any label — as a ROW, `From Texts   2` reads correctly — which is why
 * nothing in this module renames a source.
 *
 * ===========================================================================
 * THE COUNT IS COMPUTED BY THE FILTER'S OWN PREDICATE. THIS IS THE WHOLE POINT.
 * ===========================================================================
 * A count beside a filter row makes exactly one promise: tick this box and you
 * will see that many rows. The only way to keep that promise is for the count
 * and the list to be decided by THE SAME FUNCTION, so this module calls the
 * exported `matchesSourceFilter` — the predicate `assembleFilterSearch` filters
 * the list with — once per option. It does not re-derive "which source is this"
 * and it does not group by display label.
 *
 * Grouping by LABEL would be the obvious shortcut and it would be wrong, because
 * a contact can belong to more than one source. Since BACKLOG-2472 the predicate
 * reads `liveSourcesOf`, which prefers the `source_types` crosswalk rows over the
 * write-once `source` scalar: a contact linked to BOTH the Mac address book and
 * Outlook matches the Contacts App leaf AND the Outlook leaf, and ticking either
 * one shows it. A label-keyed count files that contact under one heading, so the
 * Outlook row would read one lower than the list Outlook actually produces. That
 * is a lying dropdown, and it is the negative control this module is tested with.
 *
 * ===========================================================================
 * THE CONSEQUENCE WORTH STATING: THE PARTS DO NOT SUM TO THE TOTAL
 * ===========================================================================
 * For the same reason. A contact in two address books is counted under both
 * leaves, so `sum(leaves) >= total`, with equality only when no contact has two
 * live sources.
 *
 * That is not a defect to be corrected by normalising the counts into a
 * partition. These are answers to "how many will I see if I tick this", one per
 * row, and a partition would answer a question nobody is asking while breaking
 * the one promise the number makes. The header's OLD breakdown was a partition —
 * it had to be, being a single sentence about one population — and that
 * difference is precisely why it could not be reused here.
 */

import {
  matchesSourceFilter,
  type FilterGroup,
  type SourceFilterable,
} from "./contactFilterModel";

/**
 * Counts for one rendering of the source filter panel.
 *
 * `byOptionId` is keyed by BOTH leaf ids and group ids, because the panel
 * renders both as clickable rows: a group header ticks all of its enabled
 * children, so its count is the number of rows that selection produces — not the
 * sum of its children, for the double-membership reason above.
 */
export interface SourceFilterCounts {
  /** Rows visible with EVERY enabled leaf ticked — the "All sources" row. */
  readonly total: number;
  /** Leaf id or group id -> rows visible with exactly that option ticked. */
  readonly byOptionId: ReadonlyMap<string, number>;
}

/** The enabled (selectable) leaf ids of one group, in render order. */
function enabledLeafIdsOf(group: FilterGroup): string[] {
  return group.children.filter((child) => !child.disabled).map((child) => child.id);
}

/**
 * Count `rows` under every option the source panel renders.
 *
 * Each count is `|{ row : matchesSourceFilter(row, thatSelection) }|` — i.e. the
 * length of the list the user gets by making that exact selection, holding
 * everything else (search, roles, mode) fixed, because the caller has already
 * applied everything else to `rows`.
 *
 * DISABLED LEAVES ARE EXCLUDED from group and total selections, matching
 * `GroupedMultiSelect`'s tri-state and toggle behaviour, which both operate on
 * enabled children only. A permanently disabled leaf can never be ticked, so
 * including it in the "all" selection would overstate a number the user cannot
 * reach. (No source leaf is disabled today; the role panel's `brokers` is. This
 * keeps the rule the same on both.)
 *
 * Rows matching NO leaf — an unrecognised `source` this build has no filter leaf
 * for — are counted nowhere and are absent from `total`. That is honest: such a
 * row is invisible under every possible selection, so no number the panel shows
 * could promise to reveal it. `contactFilterModel.vocabularyCoverage.test.ts`
 * exists to fail when a source ends up in that state.
 */
export function countRowsBySourceFilter(
  rows: ReadonlyArray<SourceFilterable>,
  groups: ReadonlyArray<FilterGroup>,
): SourceFilterCounts {
  // Selections are built ONCE, outside the row loop: one singleton Set per leaf,
  // one Set per group, one for the total.
  const leafSelections: Array<[string, Set<string>]> = [];
  const groupSelections: Array<[string, Set<string>]> = [];
  const everyEnabledLeaf = new Set<string>();

  for (const group of groups) {
    const enabled = enabledLeafIdsOf(group);
    if (enabled.length === 0) continue;
    for (const leafId of enabled) {
      leafSelections.push([leafId, new Set([leafId])]);
      everyEnabledLeaf.add(leafId);
    }
    // A standalone group's id is not a rendered row of its own (the panel draws
    // its single child instead), but keying it costs nothing and keeps callers
    // from having to know which groups are standalone.
    groupSelections.push([group.id, new Set(enabled)]);
  }

  const byOptionId = new Map<string, number>();
  for (const [id] of [...leafSelections, ...groupSelections]) byOptionId.set(id, 0);

  let total = 0;
  for (const row of rows) {
    if (matchesSourceFilter(row, everyEnabledLeaf)) total += 1;
    for (const [id, selection] of leafSelections) {
      if (matchesSourceFilter(row, selection)) byOptionId.set(id, (byOptionId.get(id) ?? 0) + 1);
    }
    for (const [id, selection] of groupSelections) {
      if (matchesSourceFilter(row, selection)) byOptionId.set(id, (byOptionId.get(id) ?? 0) + 1);
    }
  }

  return { total, byOptionId };
}
