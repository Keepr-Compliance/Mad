/**
 * THE NUMBER BESIDE A FILTER ROW IS THE NUMBER THAT ROW PRODUCES (BACKLOG-2671)
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR
 * ===========================================================================
 * A count beside a filter option makes exactly one promise: tick this and you
 * will see that many rows. `countRowsBySourceFilter` keeps it by calling the
 * list's own predicate, `matchesSourceFilter`, rather than re-deriving "which
 * source is this". These tests are about the ways that could still go wrong.
 *
 * The end-to-end half — the count read off the rendered dropdown versus the
 * EXACT ID SET the list renders when that option is ticked — lives in
 * `ContactSearchList.sourceCounts-2671.test.tsx`. A pure function cannot prove
 * the component hands it the right population, and that population is where
 * BACKLOG-2662's header went wrong.
 *
 * ===========================================================================
 * THE VOCABULARY IS DERIVED BY EXECUTION, NOT BY MEMORY
 * ===========================================================================
 * The founder's fourth requirement was "every source label, derived by
 * execution rather than by grepping the ones anybody remembered". So the sweep
 * below enumerates `ALL_CONTACT_SOURCE_VALUES` — the union
 * `contactSourceVocabulary.ts` publishes beside the function that emits those
 * values — and `ALL_SOURCE_LEAF_IDS`, read off the config the panel renders. A
 * source added with no leaf, or a leaf added with no rows, changes what these
 * tests assert without anyone editing them.
 *
 * `MESSAGE_DERIVED_ONLY_SOURCES` is honoured when building rows, and that is
 * load-bearing rather than tidy: the two Inferred leaves require
 * `is_message_derived`, so a fixture that left the flag off would give those
 * leaves a count of 0 and an empty expected set. `0 === 0` passes while proving
 * nothing, which is the shape of a green that carries no information.
 */

import {
  ALL_CONTACT_SOURCE_VALUES,
  MESSAGE_DERIVED_ONLY_SOURCES,
} from "../../../electron/utils/contactSourceVocabulary";
import {
  ALL_SOURCE_LEAF_IDS,
  SOURCE_GROUPS,
  SOURCE_GROUP,
  SOURCE_LEAF,
  contactSourceLabel,
  matchesSourceFilter,
  type SourceFilterable,
} from "../contactFilterModel";
import { countRowsBySourceFilter } from "../contactSourceCounts";

/**
 * One row per source value the app can produce, with `is_message_derived` set
 * exactly where that value requires it. Transcribed rule, not a guessed one:
 * `MESSAGE_DERIVED_ONLY_SOURCES` is the vocabulary module's own statement of
 * which values only ever appear on a derived contact.
 */
function oneRowPerSourceValue(): SourceFilterable[] {
  return ALL_CONTACT_SOURCE_VALUES.map((source) => ({
    source,
    is_message_derived: MESSAGE_DERIVED_ONLY_SOURCES.includes(source),
  })) as SourceFilterable[];
}

describe("countRowsBySourceFilter — the count equals what the selection produces", () => {
  /**
   * THE CENTRAL PROPERTY, swept over every leaf rather than sampled.
   *
   * For each leaf: the count this module reports must equal the number of rows
   * `matchesSourceFilter` admits for exactly that selection. Same predicate on
   * both sides is the point — it is what makes a disagreement structurally
   * impossible rather than merely untested — so the value of this test is the
   * SWEEP: it runs for leaves nobody wrote a case for.
   */
  it("agrees with the filter predicate for every leaf the panel can render", () => {
    const rows = oneRowPerSourceValue();
    const { byOptionId } = countRowsBySourceFilter(rows, SOURCE_GROUPS);

    for (const leafId of ALL_SOURCE_LEAF_IDS) {
      const admitted = rows.filter((row) => matchesSourceFilter(row, new Set([leafId])));
      expect({ leafId, count: byOptionId.get(leafId) }).toEqual({
        leafId,
        count: admitted.length,
      });
    }
  });

  /**
   * The guard that stops the sweep above from passing vacuously.
   *
   * If every leaf counted 0 the previous test would still be green, and this
   * suite would prove only that two ways of counting nothing agree. Asserted as
   * a whole map so the failure names WHICH leaf emptied out.
   */
  it("gives every leaf a non-empty count — so the sweep cannot pass on zeroes", () => {
    const { byOptionId } = countRowsBySourceFilter(oneRowPerSourceValue(), SOURCE_GROUPS);

    const emptyLeaves = ALL_SOURCE_LEAF_IDS.filter((id) => (byOptionId.get(id) ?? 0) === 0);
    expect(emptyLeaves).toEqual([]);
  });

  it("counts a group as the rows ticking that whole group would show", () => {
    const rows = oneRowPerSourceValue();
    const { byOptionId } = countRowsBySourceFilter(rows, SOURCE_GROUPS);

    for (const group of SOURCE_GROUPS) {
      const enabled = group.children.filter((c) => !c.disabled).map((c) => c.id);
      const admitted = rows.filter((row) => matchesSourceFilter(row, new Set(enabled)));
      expect({ group: group.id, count: byOptionId.get(group.id) }).toEqual({
        group: group.id,
        count: admitted.length,
      });
    }
  });

  it("counts the total as the rows ticking every leaf would show", () => {
    const rows = oneRowPerSourceValue();
    const { total } = countRowsBySourceFilter(rows, SOURCE_GROUPS);

    const everyLeaf = new Set<string>(ALL_SOURCE_LEAF_IDS as readonly string[]);
    expect(total).toBe(rows.filter((row) => matchesSourceFilter(row, everyLeaf)).length);
    // And non-vacuous: the whole vocabulary is reachable.
    expect(total).toBe(ALL_CONTACT_SOURCE_VALUES.length);
  });
});

describe("a contact with two live sources", () => {
  /**
   * ===========================================================================
   * THE NEGATIVE CONTROL THAT KEEPS THIS MODULE FROM BEING REWRITTEN AS A
   * LABEL-KEYED PARTITION
   * ===========================================================================
   * Grouping by `contactSourceLabel(row.source)` is the obvious shortcut — it is
   * what BACKLOG-2662's header did — and on rows with a single source it gives
   * identical answers. This is the row where it does not.
   *
   * Since BACKLOG-2472 the predicate reads `liveSourcesOf`, which prefers the
   * `source_types` crosswalk over the write-once `source` scalar. This contact
   * is linked to BOTH the Mac address book and Outlook, so ticking EITHER leaf
   * shows it. A label-keyed count files it under one heading only, and the
   * Outlook row would then read one lower than the list Outlook actually
   * produces — a dropdown that lies about the very click it is inviting.
   *
   * The fixture's `source_types` shape is transcribed from the real producer:
   * `attachLiveSources` (`electron/services/db/contactSourceSets.ts`) maps each
   * crosswalk row through `toPersistedContactSource` and returns them SORTED.
   */
  const inBothAddressBooks: SourceFilterable = {
    source: "contacts_app",
    source_types: ["contacts_app", "outlook"],
    is_message_derived: false,
  } as SourceFilterable;

  it("is counted under BOTH of its sources, because ticking either one shows it", () => {
    const { byOptionId } = countRowsBySourceFilter([inBothAddressBooks], SOURCE_GROUPS);

    expect(byOptionId.get(SOURCE_LEAF.CONTACTS_APP)).toBe(1);
    expect(byOptionId.get(SOURCE_LEAF.EMAIL_OUTLOOK)).toBe(1);
    // Both counts are real: the filter admits it under each leaf on its own.
    expect(
      matchesSourceFilter(inBothAddressBooks, new Set([SOURCE_LEAF.CONTACTS_APP])),
    ).toBe(true);
    expect(
      matchesSourceFilter(inBothAddressBooks, new Set([SOURCE_LEAF.EMAIL_OUTLOOK])),
    ).toBe(true);
  });

  it("is the row a label-keyed count would get wrong — the shortcut is measurably different here", () => {
    // What a partition over the display label would have said. Not a
    // reimplementation of anything shipped: this is the REJECTED design, kept
    // executable so the difference is a measurement rather than an assertion in
    // a comment.
    expect(contactSourceLabel(inBothAddressBooks.source)).toBe("Contacts App");
    const labelKeyedOutlookCount = [inBothAddressBooks].filter(
      (row) => contactSourceLabel(row.source) === "Outlook",
    ).length;

    const { byOptionId } = countRowsBySourceFilter([inBothAddressBooks], SOURCE_GROUPS);

    expect(labelKeyedOutlookCount).toBe(0);
    expect(byOptionId.get(SOURCE_LEAF.EMAIL_OUTLOOK)).toBe(1);
  });

  it("makes the parts exceed the total — stated, because it looks like a bug and is not", () => {
    const { total, byOptionId } = countRowsBySourceFilter([inBothAddressBooks], SOURCE_GROUPS);

    const sumOfLeaves = ALL_SOURCE_LEAF_IDS.reduce(
      (sum, id) => sum + (byOptionId.get(id) ?? 0),
      0,
    );

    expect(total).toBe(1);
    expect(sumOfLeaves).toBe(2);
  });
});

describe("rows the panel cannot reach", () => {
  it("counts a source with no leaf nowhere, and leaves it out of the total", () => {
    // An unrecognised source matches no leaf, so no selection can reveal it —
    // there is no honest number to show. `contactFilterModel.vocabularyCoverage`
    // is the test that fails when a REAL source ends up in this state.
    // `unknown` first because `nonesuch-provider` is deliberately OUTSIDE the
    // `ContactSource` union — that is the whole point of the case, and a direct
    // cast is the one `tsc` refuses.
    const rows = [
      { source: "nonesuch-provider", is_message_derived: false },
    ] as unknown as SourceFilterable[];
    const { total, byOptionId } = countRowsBySourceFilter(rows, SOURCE_GROUPS);

    expect(total).toBe(0);
    for (const leafId of ALL_SOURCE_LEAF_IDS) expect(byOptionId.get(leafId)).toBe(0);
  });

  it("never sweeps a DISABLED leaf into a group or the total", () => {
    // No SOURCE leaf is disabled today; the role panel's `brokers` is. The rule
    // is asserted on a synthetic group so it holds when that changes, and so the
    // same module can serve both panels.
    const groups = [
      {
        id: "grp_probe",
        label: "Probe",
        children: [
          { id: SOURCE_LEAF.EMAIL_OUTLOOK, label: "Outlook" },
          { id: "leaf_disabled", label: "Disabled", disabled: true },
        ],
      },
    ];
    const rows = [
      { source: "outlook", is_message_derived: false },
      { source: "manual", is_message_derived: false },
    ] as SourceFilterable[];

    const { total, byOptionId } = countRowsBySourceFilter(rows, groups);

    // The manual row is only reachable through leaves this probe panel does not
    // offer, so it is in neither the group count nor the total.
    expect(byOptionId.get("grp_probe")).toBe(1);
    expect(total).toBe(1);
    expect(byOptionId.has("leaf_disabled")).toBe(false);
  });

  it("returns zeroed rows rather than an empty map for an empty population", () => {
    const { total, byOptionId } = countRowsBySourceFilter([], SOURCE_GROUPS);

    expect(total).toBe(0);
    expect(byOptionId.get(SOURCE_LEAF.CONTACTS_APP)).toBe(0);
    expect(byOptionId.get(SOURCE_GROUP.EMAIL)).toBe(0);
  });
});
