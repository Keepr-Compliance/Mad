/**
 * @jest-environment node
 *
 * BACKLOG-4120 PR1 — pure Learn mode logic: Wilson (C1), answer key (C2),
 * match rule on real analyzeEmail output (C3), side/outcome mapping (C5),
 * scoring arithmetic, Copy block aggregates only, analyzeEmail timing guard.
 *
 * Every address is synthetic (street "Canarytest", city "Testville", state
 * "ZZ", ZIP 00000/99999). Detection keys are NOT written by hand: they are
 * produced by running the real `analyzeEmail` on synthetic text (C3), and the
 * test asserts each shape it relies on actually came out of the extractor.
 */
import transactionExtractorService from "../../transactionExtractorService";
import { wilsonInterval } from "../wilson";
import { addressKey, isSameDeal, sameStreet, streetKey } from "../dealMatcher";
import { AUTO_DETECT_PROVENANCE_CUTOFF_MS, buildAnswerKey, bucketOf, createdAtMs, outcomeOf, sideOf } from "../answerKey";
import { cleanupCandidates, formatCopyBlock, scoreRun } from "../scoring";
import { EMPTY_CENSUS } from "../../__tests__/helpers/emptyCensus-4175";
import type { AnswerKeyRow } from "../../db/learnModeDbService";
import type { LearnRunResult } from "../baselineRunner";
import { BUNDLED_SENDER_RULES } from "../../../utils/senderFilter/bundledRules";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 2, 1, 12); // 2026-03-01

function keyRow(over: Partial<AnswerKeyRow> = {}): AnswerKeyRow {
  return {
    property_address: "4120 Canarytest Lane, Testville, ZZ 00000",
    property_zip: "00000",
    transaction_type: "purchase",
    status: "active",
    detection_source: "manual",
    detection_status: "confirmed",
    started_at: null,
    closed_at: null,
    created_at: null,
    ...over,
  };
}

/** The address analyzeEmail emits for a synthetic body. Fails loudly if it emits none. */
function extracted(body: string): string {
  const a = transactionExtractorService.analyzeEmail({ subject: "", bodyPlain: body, date: "2026-03-01" });
  expect(a.addresses.length).toBeGreaterThan(0);
  return a.addresses[0];
}

// ---------------------------------------------------------------------------
describe("C1 Wilson 95% interval pins", () => {
  it.each([
    [18, 20, 69.9, 97.2],
    [20, 20, 83.9, 100.0],
    [95, 100, 88.8, 97.8],
  ])("%i/%i -> %f-%f", (k, n, low, high) => {
    const w = wilsonInterval(k, n);
    expect(w).not.toBeNull();
    expect([w!.low, w!.high]).toEqual([low, high]);
  });

  it("n = 0 has no interval; k > n is refused", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("C2 answer key = hand-entered deals only", () => {
  const rows: AnswerKeyRow[] = [
    keyRow({ detection_source: "manual" }),
    keyRow({ detection_source: "auto", property_address: "1 Canarytest Way, Testville, ZZ 00000" }),
    keyRow({ detection_source: "hybrid", property_address: "2 Canarytest Way, Testville, ZZ 00000" }),
    keyRow({ detection_source: "manual", status: "rejected", property_address: "3 Canarytest Way, Testville, ZZ 00000" }),
    keyRow({ detection_source: "auto", detection_status: "rejected", property_address: "4 Canarytest Way, Testville, ZZ 00000" }),
  ];
  const key = buildAnswerKey(rows, { firstMs: T0, lastMs: T0 + DAY });

  it("auto and hybrid are never positives; rejected (any source) are negatives", () => {
    expect(key.positives.map((p) => p.property_address)).toEqual(["4120 Canarytest Lane, Testville, ZZ 00000"]);
    expect(key.negatives).toHaveLength(2);
    expect(key.neutral).toHaveLength(2);
    expect(key.buckets).toEqual({ manual: 1, auto: 1, hybrid: 1, rejected: 2 });
  });

  it("bucket rule", () => {
    expect(bucketOf(keyRow({ status: "rejected", detection_source: "manual" }))).toBe("rejected");
    expect(bucketOf(keyRow({ detection_status: "rejected", detection_source: "hybrid" }))).toBe("rejected");
    expect(bucketOf(keyRow({ detection_source: "auto" }))).toBe("auto");
  });

  it("a label outside the scanned mail window is left out and counted", () => {
    const k = buildAnswerKey(
      [keyRow({ started_at: "2025-01-01", closed_at: "2025-02-01" })],
      { firstMs: T0, lastMs: T0 + DAY },
    );
    expect(k.positives).toHaveLength(0);
    expect(k.labelsWithoutLocalMail).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("C3 match rule on real analyzeEmail output", () => {
  const TX = "4120 Canarytest Lane, Testville, ZZ 00000";
  const shapes = {
    withCommas: "Offer accepted on 4120 Canarytest Lane, Testville, ZZ 00000. Escrow closing, buyer inspection done.",
    commaLess: "Offer accepted on 4120 Canarytest Lane Testville ZZ 00000 closing escrow buyer inspection",
    lineBreak: "Offer accepted for\n4120 Canarytest Lane\nTestville, ZZ 00000\nclosing escrow buyer inspection",
    stAbbrev: "Listing agreement for 4120 Canarytest St, Testville, ZZ 00000 seller closing escrow",
  };

  it("the extractor really emits a comma-less key and a line-break key (fixture shapes are not invented)", () => {
    expect(extracted(shapes.commaLess)).toBe("4120 canarytest lane testville zz 00000");
    expect(extracted(shapes.lineBreak)).toBe("4120 canarytest lane\ntestville, zz 00000");
  });

  it.each(Object.entries(shapes))("%s matches the hand-entered address", (_name, body) => {
    expect(sameStreet(extracted(body), TX, "00000")).toBe(true);
  });

  it("Rd / Road Southwest: same street", () => {
    const det = extracted("Escrow closing for 3414 Examplecanary Rd, Testville, ZZ 00000 buyer offer");
    expect(sameStreet(det, "3414 Examplecanary Road Southwest", "00000")).toBe(true);
  });

  it("ZIP guard: same street, different ZIP -> no match", () => {
    expect(sameStreet(extracted(shapes.withCommas), "4120 Canarytest Lane, Testville, ZZ 99999", "99999")).toBe(false);
  });

  it("different street number -> no match", () => {
    expect(sameStreet(extracted(shapes.withCommas), "4121 Canarytest Lane, Testville, ZZ 00000", "00000")).toBe(false);
  });

  it("address key ignores everything but street + ZIP", () => {
    expect(addressKey(extracted(shapes.commaLess))).toBe("4120 canarytest|00000");
    expect(streetKey(TX)).toBe("4120 canarytest");
  });

  it("date overlap: open bounds match, a closed deal before the mail does not", () => {
    const d = { address: extracted(shapes.withCommas), firstMs: T0, lastMs: T0 + DAY };
    const tx = { property_address: TX, property_zip: "00000", started_at: null, closed_at: null };
    expect(isSameDeal(d, tx)).toBe(true);
    expect(isSameDeal(d, { ...tx, started_at: "2025-01-01", closed_at: "2025-02-01" })).toBe(false);
  });

  it("partial overlap matches: mail starts before the deal was entered, or runs past its close", () => {
    const address = extracted(shapes.withCommas);
    const tx = { property_address: TX, property_zip: "00000", started_at: "2026-03-05", closed_at: "2026-04-30" };
    // mail 2026-02-19 .. 2026-03-11 : starts before started_at, ends inside the window
    expect(isSameDeal({ address, firstMs: T0 - 10 * DAY, lastMs: T0 + 10 * DAY }, tx)).toBe(true);
    // mail 2026-04-20 .. 2026-05-20 : starts inside, ends after closed_at
    const apr20 = Date.UTC(2026, 3, 20, 12);
    expect(isSameDeal({ address, firstMs: apr20, lastMs: apr20 + 30 * DAY }, tx)).toBe(true);
    // fully before the window -> no match
    expect(isSameDeal({ address, firstMs: T0 - 20 * DAY, lastMs: T0 - 10 * DAY }, tx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("C2b manual rows created before 2.33.0 are reported separately", () => {
  const CUT = AUTO_DETECT_PROVENANCE_CUTOFF_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  const win = { firstMs: T0, lastMs: T0 + DAY };

  it("cutoff is the v2.33.0 commit instant, 2026-08-31T07:20:25Z", () => {
    expect(iso(CUT)).toBe("2026-08-31T07:20:25.000Z");
  });

  it("created_at parses as SQLite CURRENT_TIMESTAMP (UTC) and as ISO; junk and NULL are unknown", () => {
    expect(createdAtMs("2026-08-31 07:20:25")).toBe(CUT);
    expect(createdAtMs("2026-08-31T07:20:25.000Z")).toBe(CUT);
    expect(createdAtMs("2026-08-31T01:20:25-06:00")).toBe(CUT);
    expect(createdAtMs(null)).toBeNull();
    expect(createdAtMs("not a date")).toBeNull();
  });

  it("boundary: 1 s before the cutoff is legacy, the cutoff itself and after are not, NULL is not", () => {
    const rows = [
      keyRow({ property_address: "1 Canarytest Way, Testville, ZZ 00000", created_at: iso(CUT - 1000) }),
      keyRow({ property_address: "2 Canarytest Way, Testville, ZZ 00000", created_at: iso(CUT) }),
      keyRow({ property_address: "3 Canarytest Way, Testville, ZZ 00000", created_at: iso(CUT + 1000) }),
      keyRow({ property_address: "4 Canarytest Way, Testville, ZZ 00000", created_at: null }),
    ];
    const k = buildAnswerKey(rows, win);
    expect(k.positives.map((p) => p.legacyManual)).toEqual([true, false, false, false]);
    expect(k.legacyManualPositives).toBe(1);
  });

  it("an auto row created before the cutoff is not a legacy-manual positive", () => {
    const k = buildAnswerKey([keyRow({ detection_source: "auto", created_at: iso(CUT - 1000) })], win);
    expect(k.positives).toHaveLength(0);
    expect(k.legacyManualPositives).toBe(0);
  });

  it("recall is reported with and without the pre-2.33.0 manual rows", () => {
    const rows = [
      keyRow({ property_address: "10 Canarytest Way, Testville, ZZ 00000", created_at: "2026-08-01 10:00:00" }), // legacy, found
      keyRow({ property_address: "20 Canarytest Way, Testville, ZZ 00000", created_at: "2026-10-01 10:00:00" }), // found
      keyRow({ property_address: "30 Canarytest Way, Testville, ZZ 00000", created_at: "2026-10-02 10:00:00" }), // missed
    ];
    const s4 = scoreRun(
      run([det("d1", "10 canarytest way, testville, zz 00000"), det("d2", "20 canarytest way, testville, zz 00000")]),
      rows,
      [],
      [],
      0,
      EMPTY_CENSUS,
    );
    expect([s4.positives, s4.legacyManualPositives]).toEqual([3, 1]);
    expect([s4.recall.k, s4.recall.n]).toEqual([2, 3]);
    expect([s4.recallExcludingLegacy.k, s4.recallExcludingLegacy.n]).toEqual([1, 2]);
    const text = formatCopyBlock(s4);
    expect(text).toContain("created before 2026-08-31, possibly auto-detected: 1 in the mail window, minimum)");
    expect(text).toContain("Recall without manual deals created before the cutoff: 1/2");
  });

  it("recall with cleanup Yes is reported with and without the pre-2.33.0 manual rows", () => {
    const rows = [
      keyRow({ property_address: "10 Canarytest Way, Testville, ZZ 00000", created_at: "2026-08-01 10:00:00" }), // legacy, found
      keyRow({ property_address: "20 Canarytest Way, Testville, ZZ 00000", created_at: "2026-10-01 10:00:00" }), // found
      keyRow({ property_address: "30 Canarytest Way, Testville, ZZ 00000", created_at: "2026-10-02 10:00:00" }), // missed
    ];
    const addr40 = "40 canarytest way, testville, zz 00000";
    const s = scoreRun(
      run([
        det("d1", "10 canarytest way, testville, zz 00000"),
        det("d2", "20 canarytest way, testville, zz 00000"),
        det("d3", addr40), // unmatched, user answered Yes
      ]),
      rows,
      [{ address_key: addressKey(addr40) as string, answer: "yes" as const, rule_version: 1 }],
      [],
      0,
      EMPTY_CENSUS,
    );
    expect(s.cleanupYes).toBe(1);
    // full key: (2 + 1) / (3 + 1); without legacy: (1 + 1) / (2 + 1)
    expect([s.recallWithCleanupYes.k, s.recallWithCleanupYes.n]).toEqual([3, 4]);
    expect([s.recallWithCleanupYesExcludingLegacy.k, s.recallWithCleanupYesExcludingLegacy.n]).toEqual([2, 3]);
    expect(formatCopyBlock(s)).toContain("Recall with cleanup Yes, without manual deals created before the cutoff: 2/3");
  });

  it("per-user cutoff: a manual row after 2.33.0 but before the user's first auto row is legacy", () => {
    // PR2 (SR 45eea66c): cutoff = max(global, earliest auto/hybrid created_at of this user).
    const rows = [
      keyRow({ property_address: "11 Canarytest Way, Testville, ZZ 00000", created_at: "2026-09-10 10:00:00" }), // before first auto -> legacy
      keyRow({ property_address: "12 Canarytest Way, Testville, ZZ 00000", created_at: "2026-09-20 10:00:00" }), // after first auto -> hand-entered
      keyRow({
        property_address: "13 Canarytest Way, Testville, ZZ 00000",
        detection_source: "auto",
        created_at: "2026-09-15 10:00:00",
      }),
    ];
    const k = buildAnswerKey(rows, win);
    expect(k.positives.map((p) => p.legacyManual)).toEqual([true, false]);
    expect(k.legacyManualPositives).toBe(1);
    expect(iso(k.legacyCutoffMs)).toBe("2026-09-15T10:00:00.000Z");
    expect(k.legacyCutoffIsMinimum).toBe(false);
    const s = scoreRun(run([det("d1", "11 canarytest way, testville, zz 00000")]), rows, [], [], 0, EMPTY_CENSUS);
    const text = formatCopyBlock(s);
    expect(text).toContain("created before 2026-09-15, possibly auto-detected: 1 in the mail window)");
    expect(text).not.toContain("minimum");
  });

  it("per-user cutoff: a REJECTED auto row also proves the upgrade; hybrid counts too", () => {
    const rows = [
      keyRow({ property_address: "14 Canarytest Way, Testville, ZZ 00000", created_at: "2026-09-10 10:00:00" }),
      keyRow({
        property_address: "15 Canarytest Way, Testville, ZZ 00000",
        detection_source: "auto",
        detection_status: "rejected",
        created_at: "2026-09-11 10:00:00",
      }),
      keyRow({
        property_address: "16 Canarytest Way, Testville, ZZ 00000",
        detection_source: "hybrid",
        created_at: "2026-09-13 10:00:00",
      }),
    ];
    const k = buildAnswerKey(rows, win);
    // the rejected auto row is the earliest proof
    expect(iso(k.legacyCutoffMs)).toBe("2026-09-11T10:00:00.000Z");
    expect(k.positives.map((p) => p.legacyManual)).toEqual([true]);
    // hybrid alone also proves it
    const h = buildAnswerKey([rows[0], rows[2]], win);
    expect(iso(h.legacyCutoffMs)).toBe("2026-09-13T10:00:00.000Z");
    expect(h.legacyCutoffIsMinimum).toBe(false);
  });

  it("per-user cutoff never moves before the global cutoff (an auto row dated earlier)", () => {
    const rows = [
      keyRow({ property_address: "17 Canarytest Way, Testville, ZZ 00000", created_at: iso(CUT - 1000) }),
      keyRow({ property_address: "18 Canarytest Way, Testville, ZZ 00000", detection_source: "auto", created_at: "2026-08-01 10:00:00" }),
    ];
    const k = buildAnswerKey(rows, win);
    expect(k.legacyCutoffMs).toBe(CUT);
    expect(k.legacyCutoffIsMinimum).toBe(false);
    expect(k.positives.map((p) => p.legacyManual)).toEqual([true]);
  });

  it("no auto/hybrid row: global cutoff, and the Copy line says the count is a minimum", () => {
    const rows = [keyRow({ property_address: "19 Canarytest Way, Testville, ZZ 00000", created_at: "2026-09-10 10:00:00" })];
    const k = buildAnswerKey(rows, win);
    expect(k.legacyCutoffMs).toBe(CUT);
    expect(k.legacyCutoffIsMinimum).toBe(true);
    expect(k.positives.map((p) => p.legacyManual)).toEqual([false]);
    const s = scoreRun(run([]), rows, [], [], 0, EMPTY_CENSUS);
    expect(formatCopyBlock(s)).toContain("created before 2026-08-31, possibly auto-detected: 0 in the mail window, minimum)");
  });

  it("labelsWithoutLocalMail counts a rejected row outside the scanned window (SF2)", () => {
    const k = buildAnswerKey(
      [
        keyRow({ status: "rejected", started_at: "2025-01-01", closed_at: "2025-02-01" }),
        keyRow({ property_address: "21 Canarytest Way, Testville, ZZ 00000", started_at: "2025-01-01", closed_at: "2025-02-01" }),
      ],
      win,
    );
    expect(k.negatives).toHaveLength(0);
    expect(k.positives).toHaveLength(0);
    expect(k.labelsWithoutLocalMail).toBe(2);
  });

  it("a hand-entered deal and a rejected auto deal at one address: the detection is a true detection", () => {
    // Producible after 2.33.0: the user rejects a wrong auto deal, then enters the same address by hand.
    const address = "60 Canarytest Way, Testville, ZZ 00000";
    const rows = [
      keyRow({ property_address: address, created_at: "2026-10-01 10:00:00" }), // manual, confirmed
      keyRow({
        property_address: address,
        detection_source: "auto",
        detection_status: "rejected",
        created_at: "2026-10-02 10:00:00",
      }),
    ];
    const addr70 = "70 canarytest way, testville, zz 00000";
    const s = scoreRun(
      run([det("d1", address.toLowerCase()), det("d2", addr70)]),
      rows,
      [{ address_key: addressKey(addr70) as string, answer: "no" as const, rule_version: 1 }],
      [],
      0,
      EMPTY_CENSUS,
    );
    expect([s.positives, s.found]).toEqual([1, 1]);
    expect([s.trueDetections, s.knownWrong]).toEqual([1, 0]);
    expect([s.precisionBeforeCleanup.k, s.precisionBeforeCleanup.n]).toEqual([1, 2]);
    expect([s.precisionAfterCleanup.k, s.precisionAfterCleanup.n]).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
describe("C5 side / outcome mapping", () => {
  it("purchase -> buyer, sale -> seller, other / NULL -> not scored", () => {
    expect([sideOf("purchase"), sideOf("sale"), sideOf("other"), sideOf(null)]).toEqual(["buyer", "seller", null, null]);
  });
  it("closed / active / pending map; rejected does not", () => {
    expect([outcomeOf("closed"), outcomeOf("active"), outcomeOf("pending"), outcomeOf("rejected")]).toEqual([
      "closed",
      "active",
      "pending",
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
function run(detections: LearnRunResult["detections"]): LearnRunResult {
  return {
    runId: "00000000-0000-0000-0000-000000000000",
    ruleVersion: 1,
    windowMonths: 12,
    sinceIso: "2025-03-01T00:00:00.000Z",
    rowsScanned: 500,
    nullSentAt: 10,
    realEstateCount: 40,
    pages: 3,
    firstMs: T0,
    lastMs: T0 + 30 * DAY,
    detections,
    senderRulesVersion: 1,
    senderRules: BUNDLED_SENDER_RULES,
    senderRulesProvenance: { version: 1, source: "bundled", downloadRejected: false },
    seedHidesQuestions: true,
    // No sender filter loss: the filtered runs hold the same detections.
    filtered: { full: detections, minusContactKeeps: detections },
    senderStats: {
      keptBy: { K1: 0, K2: 0, K3: 0 },
      keepConflicts: 0,
      coverage: {
        gmail: { rows: 0, headers: 0, labels: 0 },
        outlook: { rows: 0, headers: 0, labels: 0 },
        unknown: { rows: 0, headers: 0, labels: 0 },
      },
    },
    // BACKLOG-4219: the detector-surface pass, same shape (no loss, no keeps).
    detector: {
      filtered: { full: detections, minusContactKeeps: detections },
      senderStats: {
        keptBy: { K1: 0, K2: 0, K3: 0 },
        keepConflicts: 0,
        coverage: {
          gmail: { rows: 0, headers: 0, labels: 0 },
          outlook: { rows: 0, headers: 0, labels: 0 },
          unknown: { rows: 0, headers: 0, labels: 0 },
        },
      },
    },
  };
}

function det(id: string, address: string, side: "buyer" | "seller" | null = "buyer") {
  return { id, address, addressKey: addressKey(address), firstMs: T0, lastMs: T0 + DAY, emailCount: 2, emailIds: [], seedEmailIds: [], hiddenEmailIds: [], side };
}

describe("scoring arithmetic", () => {
  const keyRows: AnswerKeyRow[] = [
    keyRow({ transaction_type: "purchase", status: "closed" }), // found, side correct
    keyRow({ property_address: "10 Canarytest Way, Testville, ZZ 00000", transaction_type: "other" }), // found, side skipped
    keyRow({ property_address: "20 Canarytest Way, Testville, ZZ 00000" }), // missed
    keyRow({ property_address: "30 Canarytest Way, Testville, ZZ 00000", status: "rejected" }), // negative
  ];
  const r = run([
    det("d1", "4120 canarytest lane, testville, zz 00000", "buyer"),
    det("d2", "10 canarytest way, testville, zz 00000", "seller"),
    det("d3", "30 canarytest way, testville, zz 00000"),
    det("d4", "40 canarytest way, testville, zz 00000"),
    det("d5", "50 canarytest way, testville, zz 00000"),
    det("d6", "60 canarytest way, testville, zz 00000"),
  ]);
  const answers = [
    { address_key: "40 canarytest|00000", answer: "yes" as const, rule_version: 1 },
    { address_key: "50 canarytest|00000", answer: "no" as const, rule_version: 1 },
  ];
  const s = scoreRun(r, keyRows, answers, [], 0, EMPTY_CENSUS);

  it("counts", () => {
    expect({
      detections: s.detections,
      trueDetections: s.trueDetections,
      knownWrong: s.knownWrong,
      unmatched: s.unmatched,
      cleanupYes: s.cleanupYes,
      cleanupNo: s.cleanupNo,
      cleanupUnanswered: s.cleanupUnanswered,
      positives: s.positives,
      found: s.found,
      missed: s.missed,
    }).toEqual({
      detections: 6,
      trueDetections: 2,
      knownWrong: 1,
      unmatched: 3,
      cleanupYes: 1,
      cleanupNo: 1,
      cleanupUnanswered: 1,
      positives: 3,
      found: 2,
      missed: 1,
    });
  });

  it("recall with and without cleanup Yes; precision before and after", () => {
    expect([s.recall.k, s.recall.n]).toEqual([2, 3]);
    expect([s.recallWithCleanupYes.k, s.recallWithCleanupYes.n]).toEqual([3, 4]);
    expect([s.precisionBeforeCleanup.k, s.precisionBeforeCleanup.n]).toEqual([2, 6]);
    expect([s.precisionAfterCleanup.k, s.precisionAfterCleanup.n]).toEqual([3, 5]);
  });

  it("side scored only where the deal maps; skipped counted (C5)", () => {
    expect(s.side).toEqual({ correct: 1, wrong: 0, notPredicted: 0, skipped: 1 });
    expect(s.outcome).toEqual({ scorable: 2, skipped: 0, predicted: 0 });
  });

  it("two detections of ONE deal (groupByProperty keys by exact string) count one deal found", () => {
    // Both keys are real analyzeEmail output for the same street (C3 shapes).
    const withCommas = extracted("Offer accepted on 4120 Canarytest Lane, Testville, ZZ 00000. Escrow closing, buyer.");
    const commaLess = extracted("Offer accepted on 4120 Canarytest Lane Testville ZZ 00000 closing escrow buyer");
    expect(withCommas).not.toBe(commaLess);
    const dup = scoreRun(run([det("d1", withCommas), det("d2", commaLess)]), [keyRow()], [], [], 0, EMPTY_CENSUS);
    expect([dup.trueDetections, dup.found, dup.missed]).toEqual([2, 1, 0]);
    expect([dup.recall.k, dup.recall.n]).toEqual([1, 1]);
    expect([dup.precisionBeforeCleanup.k, dup.precisionBeforeCleanup.n]).toEqual([2, 2]);
  });

  it("one deal split into two detections, one cleanup Yes: counts ONE deal in recall, per-detection in precision", () => {
    // Both addresses are real analyzeEmail output (C3 shapes) and share one addressKey.
    const withCommas = extracted("Offer accepted on 4120 Canarytest Lane, Testville, ZZ 00000. Escrow closing, buyer.");
    const commaLess = extracted("Offer accepted on 4120 Canarytest Lane Testville ZZ 00000 closing escrow buyer");
    expect(addressKey(withCommas)).toBe(addressKey(commaLess));
    const yes = [{ address_key: addressKey(withCommas) as string, answer: "yes" as const, rule_version: 1 }];
    const s2 = scoreRun(run([det("d1", withCommas), det("d2", commaLess)]), [], yes, [], 0, EMPTY_CENSUS);
    expect([s2.unmatched, s2.unmatchedDeals, s2.unaskable]).toEqual([2, 1, 0]);
    expect([s2.cleanupYes, s2.cleanupNo, s2.cleanupUnanswered]).toEqual([1, 0, 0]);
    expect([s2.recallWithCleanupYes.k, s2.recallWithCleanupYes.n]).toEqual([1, 1]);
    expect([s2.precisionAfterCleanup.k, s2.precisionAfterCleanup.n]).toEqual([2, 2]);
  });

  it("an unmatched detection with no addressKey is its own count, not 'unanswered'", () => {
    const noKey = { ...det("d1", "x"), addressKey: null };
    const s3 = scoreRun(run([noKey]), [], [], [], 0, EMPTY_CENSUS);
    expect([s3.unmatched, s3.unmatchedDeals, s3.unaskable, s3.cleanupUnanswered]).toEqual([1, 0, 1, 0]);
  });

  it("cleanup candidates = unmatched detections only", () => {
    expect(cleanupCandidates(r, keyRows).map((c) => c.detectionId)).toEqual(["d4", "d5", "d6"]);
  });

  it("Copy block holds aggregates only: no address, no detection id, no run id", () => {
    const text = formatCopyBlock(s);
    expect(text).not.toMatch(/canarytest/i);
    expect(text).not.toMatch(/\bd\d+\b/);
    expect(text).not.toContain(r.runId);
    expect(text).toContain("Recall: 2/3");
  });
});

// ---------------------------------------------------------------------------
describe("timing guard (SR R7)", () => {
  it("analyzeEmail on a 400 KB synthetic body stays under 250 ms", () => {
    const para =
      "Escrow update for 4120 Canarytest Lane Testville ZZ 00000 buyer offer inspection 12345 and 67890 a1 b2 c3. ";
    const body = para.repeat(Math.ceil((400 * 1024) / para.length));
    expect(body.length).toBeGreaterThanOrEqual(400 * 1024);
    const t = process.hrtime.bigint();
    transactionExtractorService.analyzeEmail({ subject: "x", bodyPlain: body, date: "2026-03-01" });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    expect(ms).toBeLessThan(250);
  });
});
