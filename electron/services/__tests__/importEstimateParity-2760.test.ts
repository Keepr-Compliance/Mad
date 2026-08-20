/**
 * BACKLOG-2760 — the ESTIMATE and the IMPORT must select the same messages.
 *
 * ─── WHY THIS EXISTS AS A TEST RATHER THAN A FIX ─────────────────────────────
 *
 * These two readers have now disagreed three times, and each time the fix was
 * for the instance rather than the agreement:
 *
 *   BACKLOG-2561  the LABEL said "All time" while the IMPORT ran 3 months
 *   BACKLOG-2743  the pre-flight and the estimate sized different windows
 *   BACKLOG-2760  the ESTIMATE reported 3 months while "All time" was stored
 *
 * So this pins the agreement itself. It is deliberately not a test of either
 * path's internals — it asserts that the filter object the IMPORT builds and the
 * filter object the ESTIMATE builds resolve to the SAME cutoff, and therefore
 * select the SAME message set, for every shape the app can be in.
 *
 * ─── THE TWO PATHS BUILD THEIR FILTERS DIFFERENTLY ───────────────────────────
 *
 * They are not the same object, which is the whole risk:
 *
 *   IMPORT   (messageImportHandlers.ts:161-185)
 *            { lookbackMonths: resolveLookbackMonths(prefs),
 *              auditPeriodStart: <RAW earliest audit start> }
 *
 *   ESTIMATE (MacOSMessagesImportSettings.tsx → messages:get-import-count)
 *            { lookbackMonths: <loaded preference>,
 *              auditPeriodStart: <computeEffectiveImportWindow().effectiveCutoffISO>,
 *                                 i.e. ALREADY min(lookbackCutoff, auditStart) }
 *
 * The estimate feeds back a cutoff that has already been through the same
 * minimum. That happens to be idempotent — min(L, min(L, A)) === min(L, A) — but
 * "happens to be" is exactly the kind of reasoning that produced the three bugs
 * above, so it is asserted rather than trusted.
 *
 * ─── ASSERTIONS ARE EXACT MESSAGE SETS, NOT COUNTS ───────────────────────────
 *
 * Per the repo rule: identity, not cardinality. The corpus places messages ON
 * each cutoff and one millisecond either side, because the import's SQL uses a
 * STRICT `date > cutoff` and a single sample per branch cannot catch an
 * off-by-one at that boundary.
 */

import {
  computeImportCutoffNano,
  computeEffectiveImportWindow,
  resolveLookbackMonths,
} from "../macOSMessagesImportService/importHelpers";
import { MAC_EPOCH } from "../../constants";

const NANOS_PER_MS = 1_000_000;

/** Fixed reference instant so every cutoff in this file is deterministic. */
const NOW = new Date("2026-08-16T12:00:00.000Z");

/** The stored `messageImport.filters` shape, as written by the Settings panel. */
type StoredFilters = { lookbackMonths?: number | null };

/** Apple-epoch nanoseconds, the units chat.db stores `message.date` in. */
const toAppleNano = (d: Date): number => (d.getTime() - MAC_EPOCH) * NANOS_PER_MS;

/** `now` minus N months, matching computeImportCutoffNano's own arithmetic. */
function monthsBefore(months: number, now: Date = NOW): Date {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d;
}

/**
 * The filters the IMPORT sends (messageImportHandlers.ts). The audit start is
 * the RAW earliest transaction audit start, and the key is omitted entirely when
 * there is no transaction.
 */
function importFilters(prefs: StoredFilters, rawAuditStartISO: string | null) {
  const filters: { lookbackMonths: number | null; auditPeriodStart?: string } = {
    lookbackMonths: resolveLookbackMonths(prefs),
  };
  if (rawAuditStartISO) filters.auditPeriodStart = rawAuditStartISO;
  return filters;
}

/**
 * The filters the ESTIMATE sends (MacOSMessagesImportSettings.tsx). The audit
 * start is the ALREADY-RESOLVED effective cutoff, and the key is always present
 * (null when unbounded).
 */
function estimateFilters(prefs: StoredFilters, rawAuditStartISO: string | null) {
  const lookbackMonths = resolveLookbackMonths(prefs);
  const window = computeEffectiveImportWindow(
    { lookbackMonths, auditStartISO: rawAuditStartISO },
    NOW
  );
  return { lookbackMonths, auditPeriodStart: window.effectiveCutoffISO };
}

/**
 * A message corpus that SWEEPS every cutoff this suite exercises: on the
 * boundary, 1 ms before, 1 ms after. Ids are asserted as sets.
 */
const THREE_MONTH_CUTOFF = monthsBefore(3);
const TWENTY_FOUR_MONTH_CUTOFF = monthsBefore(24);

const CORPUS: Array<{ id: string; at: Date }> = [
  { id: "ancient", at: new Date("2019-01-01T00:00:00.000Z") },
  { id: "before-24mo", at: new Date(TWENTY_FOUR_MONTH_CUTOFF.getTime() - 1) },
  { id: "on-24mo", at: new Date(TWENTY_FOUR_MONTH_CUTOFF.getTime()) },
  { id: "after-24mo", at: new Date(TWENTY_FOUR_MONTH_CUTOFF.getTime() + 1) },
  { id: "mid-window", at: new Date("2026-02-01T00:00:00.000Z") },
  { id: "before-3mo", at: new Date(THREE_MONTH_CUTOFF.getTime() - 1) },
  { id: "on-3mo", at: new Date(THREE_MONTH_CUTOFF.getTime()) },
  { id: "after-3mo", at: new Date(THREE_MONTH_CUTOFF.getTime() + 1) },
  { id: "yesterday", at: new Date("2026-08-15T12:00:00.000Z") },
];

/**
 * Which messages a cutoff selects, using the import's OWN comparison:
 * `WHERE ... AND date > cutoff` — strict, so a message exactly on the cutoff is
 * excluded. `null` means no date filter at all.
 */
function selectedIds(cutoffNano: number | null): string[] {
  return CORPUS.filter(
    (m) => cutoffNano === null || toAppleNano(m.at) > cutoffNano
  ).map((m) => m.id);
}

const ALL_IDS = CORPUS.map((m) => m.id);
const FROM_3MO = ["after-3mo", "yesterday"];
const FROM_24MO = [
  "after-24mo",
  "mid-window",
  "before-3mo",
  "on-3mo",
  "after-3mo",
  "yesterday",
];

/**
 * Every state the app can be in, as (what is stored, whether a non-rejected
 * transaction exists). The audit-period variable is asserted BOTH ways for each
 * preference, because it was the originally-filed suspect for BACKLOG-2760.
 */
const SHAPES: Array<{
  name: string;
  prefs: StoredFilters;
  auditStartISO: string | null;
  expected: string[];
}> = [
  {
    name: "3-month preference, NO transaction",
    prefs: { lookbackMonths: 3 },
    auditStartISO: null,
    expected: FROM_3MO,
  },
  {
    name: "All time preference, NO transaction",
    prefs: { lookbackMonths: null },
    auditStartISO: null,
    expected: ALL_IDS,
  },
  {
    // The founder's exact state, and the one that was mis-sized. An explicit
    // All time short-circuits to unbounded BEFORE the audit start is consulted
    // (BACKLOG-2561), so a transaction cannot narrow it.
    name: "All time preference, transaction present",
    prefs: { lookbackMonths: null },
    auditStartISO: TWENTY_FOUR_MONTH_CUTOFF.toISOString(),
    expected: ALL_IDS,
  },
  {
    name: "3-month preference, audit period OLDER (widens to 24 months)",
    prefs: { lookbackMonths: 3 },
    auditStartISO: TWENTY_FOUR_MONTH_CUTOFF.toISOString(),
    expected: FROM_24MO,
  },
  {
    name: "24-month preference, audit period NEWER (must not narrow)",
    prefs: { lookbackMonths: 24 },
    auditStartISO: THREE_MONTH_CUTOFF.toISOString(),
    expected: FROM_24MO,
  },
  {
    // Absent key = no preference = the 3-month default, NOT All time. This is
    // the shape BACKLOG-2561 was about, and it reaches here whenever only the
    // message cap has ever been changed.
    name: "ABSENT preference key, NO transaction",
    prefs: {},
    auditStartISO: null,
    expected: FROM_3MO,
  },
  {
    name: "ABSENT preference key, audit period widens it",
    prefs: {},
    auditStartISO: TWENTY_FOUR_MONTH_CUTOFF.toISOString(),
    expected: FROM_24MO,
  },
];

describe("BACKLOG-2760 — the estimate and the import select identical messages", () => {
  it.each(SHAPES)("$name", ({ prefs, auditStartISO, expected }) => {
    const importCutoff = computeImportCutoffNano(
      importFilters(prefs, auditStartISO),
      NOW
    );
    const estimateCutoff = computeImportCutoffNano(
      estimateFilters(prefs, auditStartISO),
      NOW
    );

    // The two readers agree on the boundary …
    expect(estimateCutoff).toBe(importCutoff);

    // … and therefore on the exact set of messages, asserted by identity.
    const importSelected = selectedIds(importCutoff);
    const estimateSelected = selectedIds(estimateCutoff);
    expect(new Set(estimateSelected)).toEqual(new Set(importSelected));
    expect(new Set(importSelected)).toEqual(new Set(expected));

    // Cardinality too, so a duplicate id cannot hide inside a Set comparison.
    expect(importSelected).toHaveLength(expected.length);
  });

  it("excludes a message sitting exactly ON the cutoff, on both paths", () => {
    // The import's SQL is `date > cutoff`. If either reader ever moved to `>=`
    // the two would drift by one message at the boundary and nothing else in
    // this suite would notice.
    const prefs = { lookbackMonths: 3 };
    const importCutoff = computeImportCutoffNano(importFilters(prefs, null), NOW);
    const estimateCutoff = computeImportCutoffNano(estimateFilters(prefs, null), NOW);

    expect(selectedIds(importCutoff)).not.toContain("on-3mo");
    expect(selectedIds(estimateCutoff)).not.toContain("on-3mo");
    expect(selectedIds(importCutoff)).toContain("after-3mo");
    expect(selectedIds(estimateCutoff)).toContain("after-3mo");
  });

  it("the corpus can actually distinguish the windows it is asked about", () => {
    // A parity test whose corpus has no input at the boundary passes forever
    // (BACKLOG-2439). Prove the three windows are genuinely different sets
    // before trusting any agreement between them.
    const unbounded = selectedIds(null);
    const threeMonth = selectedIds(
      computeImportCutoffNano({ lookbackMonths: 3 }, NOW)
    );
    const twentyFour = selectedIds(
      computeImportCutoffNano({ lookbackMonths: 24 }, NOW)
    );

    expect(unbounded.length).toBeGreaterThan(twentyFour.length);
    expect(twentyFour.length).toBeGreaterThan(threeMonth.length);
    expect(threeMonth.length).toBeGreaterThan(0);
  });
});
