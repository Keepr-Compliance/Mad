/**
 * BACKLOG-2561 — "All time" must actually mean all time.
 *
 * `messageImport.filters.lookbackMonths` is ONE fact with several readers, and
 * they disagreed. The Settings dropdown spells "All time" as an explicit `null`
 * (`MacOSMessagesImportSettings.tsx:426/:437`). Every reader that resolved it
 * with `??` silently rewrote that choice into the 3-month default, because
 * `null ?? 3 === 3` — `??` cannot tell "the key is absent" from "the user
 * explicitly chose null", and this codebase uses explicit null to MEAN
 * something.
 *
 * These tests pin the distinction at the shared helpers both the import and its
 * on-screen label go through. They are the thing that keeps those readers
 * agreeing, so the sweep below asserts the import bound and the label bound are
 * EQUAL across every combination rather than checking each in isolation — a
 * per-reader test is what let the original bug through, since the label
 * faithfully mirrored an import that was itself wrong.
 *
 * Every date is derived from the real Apple-epoch conversion the production code
 * uses (`MAC_EPOCH`, nanoseconds since 2001-01-01), never hand-computed.
 */

import {
  computeImportCutoffNano,
  computeEffectiveImportWindow,
  resolveLookbackMonths,
  DEFAULT_LOOKBACK_MONTHS,
} from "../macOSMessagesImportService/importHelpers";
import { MAC_EPOCH } from "../../constants";

/** Fixed reference instant so every cutoff is deterministic. */
const NOW = new Date("2026-08-14T12:00:00.000Z");
const NANOS_PER_MS = 1_000_000;

/** Apple-epoch nanoseconds → ISO instant, the inverse of the production math. */
function nanoToISO(nano: number | null): string | null {
  return nano === null ? null : new Date(MAC_EPOCH + nano / NANOS_PER_MS).toISOString();
}

/** ISO instant → Apple-epoch nanoseconds (for building corpus rows). */
function isoToNano(iso: string): number {
  return (new Date(iso).getTime() - MAC_EPOCH) * NANOS_PER_MS;
}

describe("BACKLOG-2561 · resolveLookbackMonths — absent is not a choice", () => {
  it("defaults when the whole filters object is absent", () => {
    expect(resolveLookbackMonths(undefined)).toBe(DEFAULT_LOOKBACK_MONTHS);
    expect(resolveLookbackMonths(null)).toBe(DEFAULT_LOOKBACK_MONTHS);
  });

  it("defaults when filters exist but the lookbackMonths KEY is absent", () => {
    // This is the exact shape the app writes when only the message cap has been
    // changed: handleMaxMessagesChange sends { maxMessages }, and the preference
    // deep-merge leaves lookbackMonths absent.
    expect(resolveLookbackMonths({ maxMessages: 50000 } as { lookbackMonths?: number | null })).toBe(
      DEFAULT_LOOKBACK_MONTHS
    );
    expect(resolveLookbackMonths({})).toBe(DEFAULT_LOOKBACK_MONTHS);
    expect(resolveLookbackMonths({ lookbackMonths: undefined })).toBe(DEFAULT_LOOKBACK_MONTHS);
  });

  it("preserves an EXPLICIT null — the dropdown's spelling of All time", () => {
    expect(resolveLookbackMonths({ lookbackMonths: null })).toBeNull();
  });

  it("preserves every explicit number the dropdown can emit", () => {
    // Transcribed from the <option> values in MacOSMessagesImportSettings.tsx.
    for (const months of [3, 6, 9, 12, 18, 24]) {
      expect(resolveLookbackMonths({ lookbackMonths: months })).toBe(months);
    }
  });
});

describe("BACKLOG-2561 · computeImportCutoffNano — explicit All time is unbounded", () => {
  it("returns null (no date filter) for an explicit All-time preference", () => {
    expect(computeImportCutoffNano({ lookbackMonths: null }, NOW)).toBeNull();
  });

  /**
   * The fourth collapse site. `null` is falsy, so before the fix it contributed
   * no cutoff entry while the audit entry still did — and Math.min of that one
   * entry BOUNDED an "All time" import at the earliest audit start, silently,
   * for anyone who has a transaction (i.e. every real user).
   */
  it("stays unbounded for All time even when an audit period is present", () => {
    expect(
      computeImportCutoffNano(
        { lookbackMonths: null, auditPeriodStart: "2026-01-01T00:00:00.000Z" },
        NOW
      )
    ).toBeNull();
  });

  /**
   * messagesSyncTrigger.ts calls importMessages with `{ auditPeriodStart }` and
   * NO lookbackMonths key, and depends on the audit period governing the window.
   * An ABSENT key must therefore keep its pre-BACKLOG-2561 behaviour — the fix
   * distinguishes absent from null, it does not treat both as unbounded.
   */
  it("still lets the audit period govern when the lookback key is ABSENT", () => {
    const auditISO = "2026-01-01T00:00:00.000Z";
    expect(nanoToISO(computeImportCutoffNano({ auditPeriodStart: auditISO }, NOW))).toBe(auditISO);
  });

  it("still takes the EARLIER of an explicit lookback and the audit period", () => {
    const auditISO = "2025-01-01T00:00:00.000Z"; // far older than 3 months
    expect(
      nanoToISO(computeImportCutoffNano({ lookbackMonths: 3, auditPeriodStart: auditISO }, NOW))
    ).toBe(auditISO);
  });

  it("keeps the explicit lookback when the audit period is NEWER", () => {
    const auditISO = "2026-08-01T00:00:00.000Z"; // newer than 3 months ago
    const expected = new Date(NOW.getTime());
    expected.setMonth(expected.getMonth() - 3);
    expect(
      nanoToISO(computeImportCutoffNano({ lookbackMonths: 3, auditPeriodStart: auditISO }, NOW))
    ).toBe(expected.toISOString());
  });
});

/**
 * The bug in one assertion: an All-time preference over a corpus where EVERY
 * message predates the 3-month default must import the whole corpus.
 *
 * Identity, not counts — the assertion is on the exact ID set, so "imported 4
 * messages" cannot pass for "imported the right 4".
 *
 * The selection predicate mirrors the production SQL, which is
 * `AND message.date > ${appleDateCutoffNano}` (macOSMessagesImportService.ts
 * for the import, and `AND date > ${appleDateCutoffNano}` for the available
 * count). `message-import-handlers.allTime-2561.test.ts` carries a source guard
 * that fails if that clause ever changes shape, so this mirror cannot drift
 * silently.
 */
describe("BACKLOG-2561 · an all-time import over an all-old corpus", () => {
  const CORPUS = [
    { id: "msg-2019-newyear", date: isoToNano("2019-01-01T00:00:00.000Z") },
    { id: "msg-2023-closing", date: isoToNano("2023-06-15T09:30:00.000Z") },
    { id: "msg-2025-spring", date: isoToNano("2025-04-02T17:45:00.000Z") },
    { id: "msg-2026-january", date: isoToNano("2026-01-20T08:00:00.000Z") },
  ];
  const ALL_IDS = ["msg-2019-newyear", "msg-2023-closing", "msg-2025-spring", "msg-2026-january"];

  /** The production date filter: strictly greater than the cutoff, or no filter. */
  function importedIds(cutoffNano: number | null): string[] {
    return CORPUS.filter((m) => cutoffNano === null || m.date > cutoffNano).map((m) => m.id);
  }

  it("imports every message when the preference is an explicit All time", () => {
    const lookbackMonths = resolveLookbackMonths({ lookbackMonths: null });
    const cutoff = computeImportCutoffNano({ lookbackMonths, maxMessages: null }, NOW);
    expect(importedIds(cutoff)).toEqual(ALL_IDS);
  });

  it("imports every message for All time even with an audit period attached", () => {
    const lookbackMonths = resolveLookbackMonths({ lookbackMonths: null });
    const cutoff = computeImportCutoffNano(
      { lookbackMonths, auditPeriodStart: "2026-01-01T00:00:00.000Z" },
      NOW
    );
    expect(importedIds(cutoff)).toEqual(ALL_IDS);
  });

  it("imports NOTHING from this corpus under the 3-month default (the old behaviour)", () => {
    // Not a regression guard for the bug — this is what "All time" WAS doing, and
    // it documents that the corpus really is entirely outside the default window,
    // so the assertions above are load-bearing rather than vacuous.
    const cutoff = computeImportCutoffNano({ lookbackMonths: DEFAULT_LOOKBACK_MONTHS }, NOW);
    expect(importedIds(cutoff)).toEqual([]);
  });
});

/**
 * Control 3: sweep the boundary rather than sampling it. The production
 * predicate is strictly `>`, so a message landing EXACTLY on the cutoff is
 * excluded — an off-by-one here silently drops or duplicates the oldest day of
 * an audit window.
 */
describe("BACKLOG-2561 · the 3-month boundary, swept", () => {
  /**
   * The step is ONE MILLISECOND, not one nanosecond, and that is not laziness.
   *
   * An Apple-epoch nanosecond value for a 2026 date is ~7.9e17, far past
   * `Number.MAX_SAFE_INTEGER` (9.0e15), so consecutive integers are not
   * representable there: `cutoff + 1 === cutoff` in float64, and the first draft
   * of this test failed for exactly that reason. The cutoff is derived from
   * `Date.getTime() * 1_000_000` anyway, so a millisecond is the finest step the
   * production value can actually express. Verified below rather than asserted.
   */
  const ONE_MS_IN_NANOS = 1_000_000;

  it("has a cutoff whose neighbours a nanosecond away are not even representable", () => {
    const cutoff = computeImportCutoffNano({ lookbackMonths: 3 }, NOW) as number;
    expect(cutoff).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(cutoff + 1).toBe(cutoff); // documents WHY the step below is a millisecond
    expect(cutoff + ONE_MS_IN_NANOS).toBeGreaterThan(cutoff);
  });

  it("excludes exactly-at-cutoff, includes just inside, excludes just outside", () => {
    const cutoff = computeImportCutoffNano({ lookbackMonths: 3 }, NOW) as number;
    expect(cutoff).not.toBeNull();

    const rows = [
      { id: "one-ms-older", date: cutoff - ONE_MS_IN_NANOS },
      { id: "exactly-at-cutoff", date: cutoff },
      { id: "one-ms-newer", date: cutoff + ONE_MS_IN_NANOS },
    ];
    // Production filters with a strict `>`, so the row landing ON the cutoff is out.
    const kept = rows.filter((r) => r.date > cutoff).map((r) => r.id);
    expect(kept).toEqual(["one-ms-newer"]);
  });

  it("keeps all three boundary rows once the preference is All time", () => {
    const bounded = computeImportCutoffNano({ lookbackMonths: 3 }, NOW) as number;
    const rows = [
      { id: "one-ms-older", date: bounded - ONE_MS_IN_NANOS },
      { id: "exactly-at-cutoff", date: bounded },
      { id: "one-ms-newer", date: bounded + ONE_MS_IN_NANOS },
    ];
    const allTime = computeImportCutoffNano({ lookbackMonths: null }, NOW);
    expect(allTime).toBeNull();
    const kept = rows.filter((r) => allTime === null || r.date > allTime).map((r) => r.id);
    expect(kept).toEqual(["one-ms-older", "exactly-at-cutoff", "one-ms-newer"]);
  });
});

/**
 * Control 5, and the reason this file exists at all: the label and the import
 * are two readers of one fact. Sweeping the stored-preference axis against the
 * audit-period axis is what catches a reader that handles null differently from
 * absent — checking each reader alone cannot.
 */
describe("BACKLOG-2561 · the label and the import agree on every input", () => {
  const STORED_PREFS: Array<[string, { lookbackMonths?: number | null } | undefined]> = [
    ["key absent (filters object with only a cap)", { maxMessages: 50000 } as { lookbackMonths?: number | null }],
    ["explicit null (All time)", { lookbackMonths: null }],
    ["explicit number (3)", { lookbackMonths: 3 }],
    ["explicit number (24)", { lookbackMonths: 24 }],
  ];

  const AUDIT_STARTS: Array<[string, string | null]> = [
    ["no transactions", null],
    ["audit period EARLIER than the lookback", "2024-02-29T00:00:00.000Z"],
    ["audit period LATER than the lookback", "2026-08-10T00:00:00.000Z"],
  ];

  for (const [prefLabel, storedFilters] of STORED_PREFS) {
    for (const [auditLabel, auditStartISO] of AUDIT_STARTS) {
      it(`${prefLabel} × ${auditLabel}`, () => {
        // Both handlers resolve the preference the same way, then feed it to
        // their own computation. That is the pairing under test.
        const lookbackMonths = resolveLookbackMonths(storedFilters);

        const importBoundISO = nanoToISO(
          computeImportCutoffNano(
            { lookbackMonths, auditPeriodStart: auditStartISO ?? undefined },
            NOW
          )
        );
        const labelBound = computeEffectiveImportWindow({ lookbackMonths, auditStartISO }, NOW);

        expect(importBoundISO).toBe(labelBound.effectiveCutoffISO);
      });
    }
  }

  it("reports the audit period as the governing source only when it actually governs", () => {
    const earlier = computeEffectiveImportWindow(
      { lookbackMonths: 3, auditStartISO: "2024-02-29T00:00:00.000Z" },
      NOW
    );
    expect(earlier.source).toBe("audit-period");

    const allTime = computeEffectiveImportWindow(
      { lookbackMonths: null, auditStartISO: "2024-02-29T00:00:00.000Z" },
      NOW
    );
    expect(allTime.source).toBe("lookback-pref");
    expect(allTime.effectiveCutoffISO).toBeNull();
  });
});

/**
 * Control 6: BACKLOG-2276's audit-period floor must survive this change. A
 * transaction older than the user's lookback preference still reaches the import
 * back past that preference — the fix only stops an UNBOUNDED preference from
 * being narrowed, it does not stop a bounded one from being widened.
 */
describe("BACKLOG-2561 · the BACKLOG-2276 audit floor still widens the window", () => {
  const AUDIT_START = "2024-02-29T00:00:00.000Z";
  const CORPUS = [
    { id: "before-audit-start", date: isoToNano("2024-01-01T00:00:00.000Z") },
    { id: "inside-audit-window", date: isoToNano("2024-06-01T00:00:00.000Z") },
    { id: "inside-lookback", date: isoToNano("2026-08-01T00:00:00.000Z") },
  ];

  it("reaches back to the audit start for a 3-month preference", () => {
    const cutoff = computeImportCutoffNano(
      { lookbackMonths: 3, auditPeriodStart: AUDIT_START },
      NOW
    );
    const kept = CORPUS.filter((m) => cutoff === null || m.date > (cutoff as number)).map((m) => m.id);
    expect(kept).toEqual(["inside-audit-window", "inside-lookback"]);
  });

  it("reaches back further than the audit start when the preference is All time", () => {
    const cutoff = computeImportCutoffNano(
      { lookbackMonths: null, auditPeriodStart: AUDIT_START },
      NOW
    );
    const kept = CORPUS.filter((m) => cutoff === null || m.date > (cutoff as number)).map((m) => m.id);
    expect(kept).toEqual(["before-audit-start", "inside-audit-window", "inside-lookback"]);
  });

  it("ignores an unparseable audit start rather than bounding on NaN", () => {
    const expected = new Date(NOW.getTime());
    expected.setMonth(expected.getMonth() - 3);
    expect(
      nanoToISO(computeImportCutoffNano({ lookbackMonths: 3, auditPeriodStart: "not-a-date" }, NOW))
    ).toBe(expected.toISOString());
  });
});
