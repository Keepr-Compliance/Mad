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
import { buildAnswerKey, bucketOf, outcomeOf, sideOf } from "../answerKey";
import { cleanupCandidates, formatCopyBlock, scoreRun } from "../scoring";
import type { AnswerKeyRow } from "../../db/learnModeDbService";
import type { LearnRunResult } from "../baselineRunner";

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
  };
}

function det(id: string, address: string, side: "buyer" | "seller" | null = "buyer") {
  return { id, address, addressKey: addressKey(address), firstMs: T0, lastMs: T0 + DAY, emailCount: 2, side };
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
  const s = scoreRun(r, keyRows, answers, []);

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
    const dup = scoreRun(run([det("d1", withCommas), det("d2", commaLess)]), [keyRow()], [], []);
    expect([dup.trueDetections, dup.found, dup.missed]).toEqual([2, 1, 0]);
    expect([dup.recall.k, dup.recall.n]).toEqual([1, 1]);
    expect([dup.precisionBeforeCleanup.k, dup.precisionBeforeCleanup.n]).toEqual([2, 2]);
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
