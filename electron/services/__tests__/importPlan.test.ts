/**
 * BACKLOG-2772 — the import plan resolver.
 *
 * This is the ONE place an import's fetch is decided. Before it there were four
 * assemblers — `messageImportHandlers.ts`, the estimate channel,
 * `messagesSyncTrigger.ts` (whose entire filter literal was
 * `{ auditPeriodStart }`: no lookback, no cap, no attachment preference), and
 * background sync reaching the last two — each building its own
 * `{window, cap, attachments, auditPeriodStart}` before calling the shared core.
 * Every import defect of that week lived in the assembly, never in the core:
 * BACKLOG-2561 (four assemblers disagreeing on "All time"), 2760 (the estimate
 * assembler racing the button's), 2733 (`maxMessages ?? 50000` erasing an
 * explicit "Unlimited"), and the trigger quietly running with the cap off.
 *
 * These are the resolver's PURE unit proofs: no mocks, no I/O, no database, and
 * a pinned clock. They assert PLAN OBJECTS, which is the whole point of the
 * refactor — four call sites can now be checked against one value instead of
 * four sets of effects.
 *
 * Every plan under test is produced by the REAL resolver via
 * `helpers/importPlanFixture.ts`. Nothing here hand-builds an `ImportPlan` to
 * drive a test; the only hand-written plan is `expectedPlan` below, which is an
 * expectation and never an input.
 */

import {
  resolveMaxMessages,
  DEFAULT_MAX_MESSAGES,
  type ImportPlan,
  type StoredImportFilters,
} from "../importPlan";
import { DEFAULT_LOOKBACK_MONTHS } from "../macOSMessagesImportService/importHelpers";
import {
  FIXED_NOW,
  monthsBackISO,
  shiftISO,
  span,
  testImportPlan,
  toAppleNano,
  type TestImportPlanOptions,
} from "./helpers/importPlanFixture";

/** A deal that closed long before any default lookback window opens. */
const OLD_DEAL_START = "2019-06-15T08:30:00.000Z";
/** A closed deal's period, entirely in the past. */
const CLOSED_DEAL_START = "2024-03-01T00:00:00.000Z";
const CLOSED_DEAL_END = "2024-09-30T23:59:59.999Z";

/**
 * The plan for a run with NO stored preferences and NO deals, with named fields
 * overridden.
 *
 * An EXPECTATION builder only. It is never fed back into the resolver — see the
 * fixture helper's docblock for why a hand-built `ImportPlan` must never DRIVE a
 * test. The default lookback (3) and default cap (50000) are written as LITERALS
 * rather than read from `DEFAULT_LOOKBACK_MONTHS` / `DEFAULT_MAX_MESSAGES`,
 * so that changing either constant reds every test built on this baseline
 * instead of silently moving the expectation along with the code.
 */
const expectedPlan = (overrides: Partial<ImportPlan> = {}): ImportPlan => ({
  mode: "delta",
  fetchStartISO: monthsBackISO(3),
  cutoffNano: toAppleNano(monthsBackISO(3)),
  effectiveCap: 50000,
  protectedSpans: [],
  fetchAttachments: true,
  overrides: [],
  ...overrides,
});

describe("resolveImportPlan — D2': ONE window, both buttons", () => {
  /*
   * The founder settled this on 2026-08-20: Import and Force Re-import fetch the
   * SAME range and differ only in how they PROCESS it. In his words: "force
   * re-import will always cover the whole window... it's more about the
   * processing of msgs."
   *
   * This is the most important assertion in the file. `fetchStartISO` must have
   * no per-button branch, so the check is not "both look reasonable" but "the
   * two plans are the SAME VALUE apart from `mode`" — an equality a future
   * `mode === "reprocess" ? ... : ...` anywhere in the resolver cannot survive.
   */

  /** Every knob turned at once, so the equality has something to lose. */
  const RICH: TestImportPlanOptions = {
    storedFilters: { lookbackMonths: 6, maxMessages: 1000, skipAttachments: false },
    auditSpans: [span(OLD_DEAL_START), span(CLOSED_DEAL_START, CLOSED_DEAL_END)],
    requestedStartISO: "2023-01-01T00:00:00.000Z",
  };

  it("delta and reprocess differ in `mode` and in NOTHING else", () => {
    const delta = testImportPlan({ ...RICH, mode: "delta" });
    const reprocess = testImportPlan({ ...RICH, mode: "reprocess" });

    expect(delta.mode).toBe("delta");
    expect(reprocess.mode).toBe("reprocess");
    expect({ ...reprocess, mode: "delta" }).toEqual(delta);
  });

  it("carries the requested mode through unchanged", () => {
    // Anti-vacuity for the equality above: `mode` is really a field of the plan,
    // not a value the resolver drops (which would also make the two "equal").
    expect(testImportPlan({ mode: "delta" }).mode).toBe("delta");
    expect(testImportPlan({ mode: "reprocess" }).mode).toBe("reprocess");
  });

  const D2_SHAPES: Array<[string, TestImportPlanOptions]> = [
    ["no preferences and no deals", {}],
    ["an explicit All time preference", { storedFilters: { lookbackMonths: null } }],
    ["a bounded preference", { storedFilters: { lookbackMonths: 12 } }],
    [
      "a deal that predates the preference",
      { storedFilters: { lookbackMonths: 3 }, auditSpans: [span(OLD_DEAL_START)] },
    ],
    [
      "a deal INSIDE the preference",
      {
        storedFilters: { lookbackMonths: 36 },
        auditSpans: [span(CLOSED_DEAL_START, CLOSED_DEAL_END)],
      },
    ],
    [
      "an explicit lower bound from the transaction trigger",
      { requestedStartISO: OLD_DEAL_START },
    ],
    ["Unlimited messages", { storedFilters: { maxMessages: null } }],
    ["attachments skipped", { storedFilters: { skipAttachments: true } }],
  ];

  it.each(D2_SHAPES)(
    "%s: both buttons resolve the identical window",
    (_label, options) => {
      const delta = testImportPlan({ ...options, mode: "delta" });
      const reprocess = testImportPlan({ ...options, mode: "reprocess" });

      expect(reprocess.fetchStartISO).toBe(delta.fetchStartISO);
      expect(reprocess.cutoffNano).toBe(delta.cutoffNano);
      expect({ ...reprocess, mode: "delta" }).toEqual(delta);
    },
  );
});

describe("resolveImportPlan — the founder's equivalence", () => {
  /*
   * "Clicking Import is the same as creating a transaction whose dates go past
   * the existing cache." This module's job is to make that literally true, so it
   * is asserted on the PLAN OBJECT — not on downstream effects, which is how the
   * four assemblers managed to look equivalent while behaving differently.
   */

  it("the trigger firing for an EXISTING deal plans exactly what Import plans", () => {
    const stored: StoredImportFilters = { lookbackMonths: 3 };
    const deal = span(OLD_DEAL_START);

    // The Import button: preferences + every non-rejected deal's period.
    const importButton = testImportPlan({ storedFilters: stored, auditSpans: [deal] });
    // messagesSyncTrigger: the same state, plus the start date it is reacting to.
    const trigger = testImportPlan({
      storedFilters: stored,
      auditSpans: [deal],
      requestedStartISO: deal.startISO,
    });

    expect(trigger).toEqual(importButton);

    // Anti-vacuity: the window really was stretched past the 3-month preference,
    // so the equality above is between two INTERESTING plans, not two defaults.
    expect(importButton.fetchStartISO).toBe(OLD_DEAL_START);
    expect(importButton.overrides).toEqual([
      {
        kind: "window-extended-by-deals",
        requestedStartISO: monthsBackISO(3),
        effectiveStartISO: OLD_DEAL_START,
      },
    ]);
  });

  it("a deal being CREATED plans the same window as the same deal once it exists", () => {
    /*
     * The one legitimate difference. `requestedStartISO` widens the window
     * exactly as a span does, but protects nothing: the deal it belongs to does
     * not exist yet, so there is no audit period to exempt from the cap. The
     * moment the row is written, the same start arrives as a span and the
     * protection appears. The WINDOW never moves across that transition.
     */
    const stored: StoredImportFilters = { lookbackMonths: 3 };

    const beingCreated = testImportPlan({ storedFilters: stored, requestedStartISO: OLD_DEAL_START });
    const nowExists = testImportPlan({ storedFilters: stored, auditSpans: [span(OLD_DEAL_START)] });

    expect({ ...beingCreated, protectedSpans: nowExists.protectedSpans }).toEqual(nowExists);
    expect(beingCreated.protectedSpans).toEqual([]);
    expect(nowExists.protectedSpans).toEqual([
      { startNano: toAppleNano(OLD_DEAL_START), endNano: null },
    ]);
  });
});

describe("resolveImportPlan — lookback resolution (BACKLOG-2561)", () => {
  it("pins the default lookback the plan baseline is written against", () => {
    // The literal `3` appears throughout `expectedPlan`. If the shipped default
    // ever moves, this reds first and says why the rest went red with it.
    expect(DEFAULT_LOOKBACK_MONTHS).toBe(3);
  });

  it.each([
    ["no filters object at all", undefined],
    ["a null filters object", null],
    ["an empty filters object", {}],
  ])("%s falls back to the default 3-month window", (_label, storedFilters) => {
    expect(testImportPlan({ storedFilters })).toEqual(expectedPlan());
  });

  it("a filters object holding ONLY maxMessages still takes the default window", () => {
    // The preferences deep-merge writes just the key the user changed, so
    // `lookbackMonths` is ABSENT rather than null. Absence is not a choice.
    expect(testImportPlan({ storedFilters: { maxMessages: 1000 } })).toEqual(
      expectedPlan({ effectiveCap: 1000 }),
    );
  });

  it("an explicit null is All time — unbounded in BOTH fields", () => {
    // BACKLOG-2561: the Settings dropdown writes `null` for "All time"
    // (`value === "all" ? null : Number(value)`), and every reader that used
    // `?? 3` rewrote it into "last 3 months" while the count preview honoured it.
    expect(testImportPlan({ storedFilters: { lookbackMonths: null } })).toEqual(
      expectedPlan({ fetchStartISO: null, cutoffNano: null }),
    );
  });

  it("a non-positive month count is also unbounded", () => {
    // Pins the core's `lookback <= 0` short-circuit at the assembly level: a 0
    // must not fall through and produce a cutoff of "now".
    expect(testImportPlan({ storedFilters: { lookbackMonths: 0 } })).toEqual(
      expectedPlan({ fetchStartISO: null, cutoffNano: null }),
    );
  });

  it.each([1, 3, 6, 12, 24])("%i months resolves to exactly that many months back", (months) => {
    expect(testImportPlan({ storedFilters: { lookbackMonths: months } })).toEqual(
      expectedPlan({
        fetchStartISO: monthsBackISO(months),
        cutoffNano: toAppleNano(monthsBackISO(months)),
      }),
    );
  });

  it("measures the window from the INJECTED clock, not the wall clock", () => {
    // Anti-vacuity for every date assertion in this file: if `now` were ignored
    // and `new Date()` used, these two plans would be identical.
    const earlier = new Date("2025-02-10T00:00:00.000Z");
    const plan = testImportPlan({ storedFilters: { lookbackMonths: 3 }, now: earlier });

    expect(plan.fetchStartISO).toBe(monthsBackISO(3, earlier));
    expect(plan.fetchStartISO).not.toBe(monthsBackISO(3, FIXED_NOW));
  });

  it("an audit span WIDENS a bounded window", () => {
    expect(
      testImportPlan({
        storedFilters: { lookbackMonths: 3 },
        auditSpans: [span(OLD_DEAL_START)],
      }),
    ).toEqual(
      expectedPlan({
        fetchStartISO: OLD_DEAL_START,
        cutoffNano: toAppleNano(OLD_DEAL_START),
        protectedSpans: [{ startNano: toAppleNano(OLD_DEAL_START), endNano: null }],
        overrides: [
          {
            kind: "window-extended-by-deals",
            requestedStartISO: monthsBackISO(3),
            effectiveStartISO: OLD_DEAL_START,
          },
        ],
      }),
    );
  });

  it("an audit span can NEVER narrow a window — it only ever widens", () => {
    /*
     * A deal that starts INSIDE the user's selection leaves the window alone.
     * The whole plan is asserted so this also proves protection is independent
     * of widening: the span still appears in `protectedSpans` even though it
     * moved nothing.
     */
    expect(
      testImportPlan({
        storedFilters: { lookbackMonths: 36 },
        auditSpans: [span(CLOSED_DEAL_START, CLOSED_DEAL_END)],
      }),
    ).toEqual(
      expectedPlan({
        fetchStartISO: monthsBackISO(36),
        cutoffNano: toAppleNano(monthsBackISO(36)),
        protectedSpans: [
          {
            startNano: toAppleNano(CLOSED_DEAL_START),
            endNano: toAppleNano(CLOSED_DEAL_END),
          },
        ],
      }),
    );
  });

  it("an audit span cannot BOUND an All time window", () => {
    // The failure BACKLOG-2561 describes: an explicit `null` is falsy, so it
    // contributed no cutoff entry while the audit entry still did, and
    // `Math.min` of that single entry bounded an "All time" import at the
    // earliest deal start. The deal must still be PROTECTED, just not limiting.
    expect(
      testImportPlan({
        storedFilters: { lookbackMonths: null },
        auditSpans: [span(OLD_DEAL_START)],
      }),
    ).toEqual(
      expectedPlan({
        fetchStartISO: null,
        cutoffNano: null,
        protectedSpans: [{ startNano: toAppleNano(OLD_DEAL_START), endNano: null }],
      }),
    );
  });

  it("takes the EARLIEST of several deals, not the first or the last", () => {
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      auditSpans: [
        span(CLOSED_DEAL_START, CLOSED_DEAL_END),
        span(OLD_DEAL_START),
        span("2025-01-01T00:00:00.000Z"),
      ],
    });

    expect(plan.fetchStartISO).toBe(OLD_DEAL_START);
  });
});

describe("resolveMaxMessages — Cap' (BACKLOG-2733)", () => {
  /*
   * The defect verbatim: `maxMessages ?? DEFAULT_MAX_MESSAGES`. `null ?? 50000`
   * is `50000`, so a user who picked "Unlimited" in the dropdown was capped —
   * and, before BACKLOG-2744, capped to the OLDEST 50,000, losing exactly the
   * recent conversation they cared about. The fix is the `=== undefined` test:
   * absent means no preference, explicit null means Unlimited, and they are two
   * different facts.
   */

  it("pins the default cap the plan baseline is written against", () => {
    expect(DEFAULT_MAX_MESSAGES).toBe(50000);
  });

  it.each([
    ["no filters object at all", undefined],
    ["a null filters object", null],
    ["an empty filters object", {}],
    ["an explicitly undefined key", { maxMessages: undefined }],
  ])("%s means NO PREFERENCE and yields the default cap", (_label, filters) => {
    expect(resolveMaxMessages(filters)).toBe(50000);
  });

  it("a filters object holding ONLY lookbackMonths yields the default cap, NOT null", () => {
    /*
     * BACKLOG-2733's live shape. Changing only "Import messages from" writes
     * `{ lookbackMonths: N }` and the preferences deep-merge leaves
     * `maxMessages` ABSENT. Reading absence as "Unlimited" would silently
     * uncap every user who ever touched the other dropdown — the mirror-image
     * mistake, and the one a `== null` test would make.
     */
    const stored: StoredImportFilters = { lookbackMonths: 6 };
    expect(resolveMaxMessages(stored)).toBe(50000);
  });

  it("an explicit null is Unlimited and MUST survive as null", () => {
    expect(resolveMaxMessages({ maxMessages: null })).toBeNull();
  });

  it.each([1, 500, 25000, 250000])("an explicit %i is honoured exactly", (cap) => {
    expect(resolveMaxMessages({ maxMessages: cap })).toBe(cap);
  });

  it("an explicit 0 is honoured, not treated as absent", () => {
    // Pins `stored === undefined` against the other tempting spelling, `!stored`:
    // 0 is falsy, and a truthiness test would silently restore the 50000 default.
    expect(resolveMaxMessages({ maxMessages: 0 })).toBe(0);
  });

  it("honours a caller-supplied default when nothing is stored", () => {
    expect(resolveMaxMessages(undefined, 7)).toBe(7);
    expect(resolveMaxMessages({}, 7)).toBe(7);
    // ...but a stored preference still wins over it.
    expect(resolveMaxMessages({ maxMessages: null }, 7)).toBeNull();
    expect(resolveMaxMessages({ maxMessages: 9 }, 7)).toBe(9);
  });
});

describe("resolveImportPlan — effectiveCap carries Cap' into the plan", () => {
  // The expected cap is the SECOND tuple element on purpose: jest fills the
  // title's `%s` placeholders positionally from the row, so a value that must
  // appear in the test name has to sit next to the label.
  it.each<[string, number | null, StoredImportFilters | null | undefined]>([
    ["filters entirely absent", 50000, undefined],
    ["a null filters object", 50000, null],
    ["an empty filters object", 50000, {}],
    ["ONLY lookbackMonths stored (the deep-merge shape)", 50000, { lookbackMonths: 6 }],
    ["ONLY skipAttachments stored", 50000, { skipAttachments: true }],
    ["an explicit Unlimited", null, { maxMessages: null }],
    ["an explicit 1000", 1000, { maxMessages: 1000 }],
  ])("%s resolves effectiveCap to %s", (_label, expectedCap, storedFilters) => {
    expect(testImportPlan({ storedFilters }).effectiveCap).toBe(expectedCap);
  });

  it("the cap is independent of the window — Unlimited does not widen it", () => {
    // Cap' scopes the cap; it does not trade against the window. Asserting the
    // whole plan pins that "Unlimited" touches `effectiveCap` and nothing else.
    expect(testImportPlan({ storedFilters: { maxMessages: null } })).toEqual(
      expectedPlan({ effectiveCap: null }),
    );
  });
});

describe("resolveImportPlan — protectedSpans (Cap': the exemption, scoped)", () => {
  /*
   * Cap' (2026-08-20, final): "Maximum messages" applies only OUTSIDE the audit
   * periods of non-rejected deals. Inside such a period history is always
   * complete and never counts against the cap. Closed deals are protected
   * exactly like live ones; REJECTED deals protect nothing, which is why callers
   * pass only non-rejected spans and this resolver protects every span it is
   * given.
   *
   * The old shape was all-or-nothing (`capApplies = !auditPeriodActive && ...`),
   * so a single pending transaction disabled the cap for the ENTIRE library.
   */

  it("pins the Apple-epoch conversion itself against hand-computed literals", () => {
    /*
     * `startNano` / `endNano` are nanoseconds since 2001-01-01, the unit
     * `message.date` is stored in. The literals below were computed outside
     * JavaScript (python3, from the same two instants) so this assertion cannot
     * agree with a resolver that has drifted just because the test helper drifted
     * with it. Every other span assertion in this file uses `toAppleNano`.
     */
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: null },
      auditSpans: [span(CLOSED_DEAL_START, "2019-06-15T08:30:00.000Z")],
    });

    expect(plan.protectedSpans).toEqual([
      { startNano: 730944000000000000, endNano: 582280200000000000 },
    ]);
  });

  it("emits exactly one protected span per deal, in input order", () => {
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: null },
      auditSpans: [
        span(CLOSED_DEAL_START, CLOSED_DEAL_END),
        span(OLD_DEAL_START),
        span("2025-01-01T00:00:00.000Z", "2025-06-30T00:00:00.000Z"),
      ],
    });

    expect(plan.protectedSpans).toEqual([
      { startNano: toAppleNano(CLOSED_DEAL_START), endNano: toAppleNano(CLOSED_DEAL_END) },
      { startNano: toAppleNano(OLD_DEAL_START), endNano: null },
      {
        startNano: toAppleNano("2025-01-01T00:00:00.000Z"),
        endNano: toAppleNano("2025-06-30T00:00:00.000Z"),
      },
    ]);
  });

  it("an OPEN deal (no close date) protects an open-ended range", () => {
    // A deal that has not closed runs to the present, so there is no upper
    // bound to write. `endNano: null` is that, explicitly.
    const plan = testImportPlan({ auditSpans: [span(CLOSED_DEAL_START)] });
    expect(plan.protectedSpans).toEqual([
      { startNano: toAppleNano(CLOSED_DEAL_START), endNano: null },
    ]);
  });

  it("no deals means no protected spans", () => {
    expect(testImportPlan().protectedSpans).toEqual([]);
    expect(testImportPlan({ auditSpans: [] }).protectedSpans).toEqual([]);
  });

  it.each(["not-a-date", "", "2019-13-45T99:00:00Z"])(
    "an unparseable start (%p) is DROPPED entirely — it neither widens nor protects",
    (badStart) => {
      /*
       * The resolver's stated rule, asserted on the WHOLE plan because the two
       * halves of it live in different places: a malformed `started_at` widening
       * every import to the beginning of time would be a silent, expensive
       * full-device scan, and protecting an unbounded range would silently
       * disable the cap for the entire library. Neither may happen.
       */
      expect(
        testImportPlan({
          storedFilters: { lookbackMonths: 3 },
          auditSpans: [span(badStart)],
        }),
      ).toEqual(expectedPlan());
    },
  );

  it("a valid deal survives alongside an unparseable one", () => {
    // Anti-vacuity for the drop rule: it drops the bad row, not the batch.
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      auditSpans: [span("not-a-date"), span(CLOSED_DEAL_START, CLOSED_DEAL_END)],
    });

    expect(plan.protectedSpans).toEqual([
      { startNano: toAppleNano(CLOSED_DEAL_START), endNano: toAppleNano(CLOSED_DEAL_END) },
    ]);
    expect(plan.fetchStartISO).toBe(CLOSED_DEAL_START);
  });

  it("FLAGGED: an unparseable END is read as open-ended rather than dropped", () => {
    /*
     * Pins CURRENT behaviour, and it is not obviously the behaviour the module
     * wants. `isoToNano` returns null for an unparseable `endISO`, and `null`
     * already means "open-ended" — so a corrupt `closed_at` widens that deal's
     * cap exemption to [start, infinity) instead of being dropped, which is the
     * same silent outcome the resolver's own comment gives as the reason for
     * dropping an unparseable START. Raised with the module's author under
     * BACKLOG-2772; this test exists so a deliberate change reds it, rather
     * than the behaviour changing unnoticed either way.
     */
    const plan = testImportPlan({ auditSpans: [span(CLOSED_DEAL_START, "not-a-date")] });
    expect(plan.protectedSpans).toEqual([
      { startNano: toAppleNano(CLOSED_DEAL_START), endNano: null },
    ]);
  });
});

describe("resolveImportPlan — overrides[] (BACKLOG-2749's dialog reads this)", () => {
  /*
   * DATA, not UI. The one pre-import dialog renders exactly this list and
   * renders nothing at all when it is empty, so an override emitted when nothing
   * was overridden puts a dialog in front of a user who has no decision to make,
   * and a missing one silently fetches further back than they asked for.
   *
   * Only ever a window STRETCH: Cap' removed the other disclosure the old design
   * owed the user (a cap set aside), because under Cap' the cap is never set
   * aside — it is scoped.
   */

  it("emits the exact override object when a deal stretches the window", () => {
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      auditSpans: [span(OLD_DEAL_START)],
    });

    expect(plan.overrides).toEqual([
      {
        kind: "window-extended-by-deals",
        requestedStartISO: monthsBackISO(3),
        effectiveStartISO: OLD_DEAL_START,
      },
    ]);
    // The two ISO instants are the two ends of the stretch, so they must match
    // what the user chose and what the plan actually does.
    expect(plan.fetchStartISO).toBe(plan.overrides[0].effectiveStartISO);
  });

  it("emits an override when the TRIGGER's explicit start stretches the window", () => {
    // The deal does not exist yet, so there is no span — but the user is still
    // about to get more than their selection, and still deserves to be told.
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      requestedStartISO: OLD_DEAL_START,
    });

    expect(plan.overrides).toEqual([
      {
        kind: "window-extended-by-deals",
        requestedStartISO: monthsBackISO(3),
        effectiveStartISO: OLD_DEAL_START,
      },
    ]);
  });

  it("emits ONE override for many deals, describing the furthest reach", () => {
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      auditSpans: [span("2025-01-01T00:00:00.000Z"), span(OLD_DEAL_START), span(CLOSED_DEAL_START)],
    });

    expect(plan.overrides).toEqual([
      {
        kind: "window-extended-by-deals",
        requestedStartISO: monthsBackISO(3),
        effectiveStartISO: OLD_DEAL_START,
      },
    ]);
  });

  it("emits nothing when there are no deals", () => {
    expect(testImportPlan({ storedFilters: { lookbackMonths: 3 } }).overrides).toEqual([]);
  });

  it("emits nothing when the deal is INSIDE the user's selection", () => {
    // Nothing was stretched, so there is nothing to disclose and no dialog.
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: 36 },
      auditSpans: [span(CLOSED_DEAL_START, CLOSED_DEAL_END)],
    });
    expect(plan.overrides).toEqual([]);
  });

  it.each([
    ["a deal older than everything", { auditSpans: [span("2003-04-05T06:07:08.000Z")] }],
    ["an explicit trigger start", { requestedStartISO: "2003-04-05T06:07:08.000Z" }],
  ])("emits nothing on All time (%s) — nothing can override unbounded", (_label, extra) => {
    // An unbounded window already reaches back further than any deal, so the
    // user's own selection is never exceeded. Emitting an override here would
    // mean claiming an "effectiveStartISO" for a window that has no start.
    const plan = testImportPlan({ storedFilters: { lookbackMonths: null }, ...extra });

    expect(plan.overrides).toEqual([]);
    expect(plan.fetchStartISO).toBeNull();
  });

  describe("the boundary, swept rather than sampled", () => {
    /*
     * "Stretched" is a STRICT comparison (`cutoffNano < selectionOnlyCutoff`), so
     * a deal starting exactly AT the lookback cutoff moved nothing and must not
     * raise a dialog. One millisecond earlier did move it and must. Sampling one
     * point on either side would miss an off-by-one at the boundary itself.
     */
    const CUTOFF_ISO = monthsBackISO(3);

    it.each([
      { offsetMs: -1, label: "one ms BEFORE the cutoff", stretches: true },
      { offsetMs: 0, label: "exactly AT the cutoff", stretches: false },
      { offsetMs: 1, label: "one ms AFTER the cutoff", stretches: false },
    ])("a deal starting $label stretches the window: $stretches", ({ offsetMs, stretches }) => {
      const startISO = shiftISO(CUTOFF_ISO, offsetMs);
      const plan = testImportPlan({
        storedFilters: { lookbackMonths: 3 },
        auditSpans: [span(startISO)],
      });

      if (stretches) {
        expect(plan.fetchStartISO).toBe(startISO);
        expect(plan.overrides).toEqual([
          {
            kind: "window-extended-by-deals",
            requestedStartISO: CUTOFF_ISO,
            effectiveStartISO: startISO,
          },
        ]);
      } else {
        expect(plan.fetchStartISO).toBe(CUTOFF_ISO);
        expect(plan.overrides).toEqual([]);
      }
      // Either way the deal is protected — protection does not depend on the
      // window having moved.
      expect(plan.protectedSpans).toEqual([
        { startNano: toAppleNano(startISO), endNano: null },
      ]);
    });
  });
});

describe("resolveImportPlan — fetchAttachments", () => {
  // Expected value second — see the note on the effectiveCap table above.
  it.each<[string, boolean, StoredImportFilters | null | undefined]>([
    ["skipAttachments true", false, { skipAttachments: true }],
    ["skipAttachments false", true, { skipAttachments: false }],
    ["skipAttachments absent", true, { lookbackMonths: 3 }],
    ["an empty filters object", true, {}],
    ["a null filters object", true, null],
    ["no filters object at all", true, undefined],
  ])("%s yields fetchAttachments %s", (_label, expected, storedFilters) => {
    expect(testImportPlan({ storedFilters }).fetchAttachments).toBe(expected);
  });

  it("skipping attachments touches nothing else in the plan", () => {
    expect(testImportPlan({ storedFilters: { skipAttachments: true } })).toEqual(
      expectedPlan({ fetchAttachments: false }),
    );
  });
});

describe("resolveImportPlan — requestedStartISO (the transaction trigger)", () => {
  it("widens the window like a deal does, but adds NO protected span", () => {
    /*
     * The distinction the trigger depends on. The deal it is reacting to does
     * not exist yet, so there is no audit period to exempt from the cap — and
     * inventing one would exempt a range no deal has claimed. The window still
     * has to reach back, because the messages must be there when the deal lands.
     */
    expect(
      testImportPlan({ storedFilters: { lookbackMonths: 3 }, requestedStartISO: OLD_DEAL_START }),
    ).toEqual(
      expectedPlan({
        fetchStartISO: OLD_DEAL_START,
        cutoffNano: toAppleNano(OLD_DEAL_START),
        protectedSpans: [],
        overrides: [
          {
            kind: "window-extended-by-deals",
            requestedStartISO: monthsBackISO(3),
            effectiveStartISO: OLD_DEAL_START,
          },
        ],
      }),
    );
  });

  it.each([null, undefined, "not-a-date", ""])(
    "an absent or unparseable requested start (%p) leaves the window alone",
    (requestedStartISO) => {
      expect(testImportPlan({ requestedStartISO })).toEqual(expectedPlan());
    },
  );

  it("takes the EARLIER of the trigger's start and the deals' starts", () => {
    // Both directions, because "the trigger always wins" and "the deals always
    // win" are both wrong: the window is the union of everything required.
    const triggerIsEarlier = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      auditSpans: [span(CLOSED_DEAL_START)],
      requestedStartISO: OLD_DEAL_START,
    });
    expect(triggerIsEarlier.fetchStartISO).toBe(OLD_DEAL_START);

    const dealIsEarlier = testImportPlan({
      storedFilters: { lookbackMonths: 3 },
      auditSpans: [span(OLD_DEAL_START)],
      requestedStartISO: CLOSED_DEAL_START,
    });
    expect(dealIsEarlier.fetchStartISO).toBe(OLD_DEAL_START);
  });

  it("cannot bound an All time window", () => {
    const plan = testImportPlan({
      storedFilters: { lookbackMonths: null },
      requestedStartISO: OLD_DEAL_START,
    });
    expect(plan.fetchStartISO).toBeNull();
    expect(plan.cutoffNano).toBeNull();
  });
});

describe("resolveImportPlan — fetchStartISO and cutoffNano are one decision", () => {
  it.each<[string, TestImportPlanOptions]>([
    ["default window", {}],
    ["All time", { storedFilters: { lookbackMonths: null } }],
    ["stretched by a deal", { storedFilters: { lookbackMonths: 3 }, auditSpans: [span(OLD_DEAL_START)] }],
    ["stretched by the trigger", { requestedStartISO: OLD_DEAL_START }],
    ["12-month selection", { storedFilters: { lookbackMonths: 12 } }],
  ])("%s: the ISO bound and the nanosecond bound describe the same instant", (_label, options) => {
    // The SQL filters on `cutoffNano`; every label, estimate and log reads
    // `fetchStartISO`. A plan whose two halves disagree is how an import fetches
    // one range while telling the user another — the BACKLOG-2561 shape.
    const plan = testImportPlan(options);

    if (plan.fetchStartISO === null) {
      expect(plan.cutoffNano).toBeNull();
    } else {
      expect(plan.cutoffNano).toBe(toAppleNano(plan.fetchStartISO));
    }
  });
});
