/**
 * BACKLOG-4120 PR3 — what the tiles and detail lines read from a score.
 * Base shape: the transcribed SCORE fixture; values changed per case.
 */
import { learnDetailLines, learnTiles } from "../learnScoreView";
import { SCORE } from "./learnFixtures-4120";
import type { LearnScoreResult } from "../../../../../electron/types/ipc/window-api-learn";

const base = (SCORE as Extract<LearnScoreResult, { success: true }>).score;

describe("tiles", () => {
  it("wrong finds = shown detections that are not real (No answers + rejected matches), not just rejected", () => {
    const s = {
      ...base,
      found: 18,
      positives: 20,
      missed: 2,
      recallExcludingLegacy: { k: 18, n: 20, interval: { rate: 90, low: 69.9, high: 97.2 } },
      knownWrong: 1,
      precisionAfterCleanup: { k: 7, n: 10, interval: { rate: 70, low: 39.7, high: 89.2 } },
    };
    expect(learnTiles(s)).toEqual({ found: 18, of: 20, wrongFinds: 3, missed: 2, empty: false });
  });

  it("found and missed use the base without pre-cutoff manual deals", () => {
    const s = {
      ...base,
      found: 5,
      positives: 8,
      missed: 3,
      recallExcludingLegacy: { k: 4, n: 5, interval: { rate: 80, low: 37.6, high: 96.4 } },
    };
    expect(learnTiles(s)).toMatchObject({ found: 4, of: 5, missed: 1, empty: false });
  });

  it("empty when every manual deal predates the cutoff", () => {
    expect(learnTiles(base)).toMatchObject({ found: 0, of: 0, missed: 0, empty: true });
  });
});

describe("detail lines", () => {
  it("'minimum' only when no auto-detected row proves the cutoff", () => {
    expect(learnDetailLines(base)).toContain(
      "Manual deals created before 2026-08-31 (possibly auto-detected): 1 (minimum)",
    );
    expect(learnDetailLines({ ...base, legacyCutoffIsMinimum: false, legacyCutoffDay: "2026-09-10" })).toContain(
      "Manual deals created before 2026-09-10 (possibly auto-detected): 1",
    );
  });

  it("recall with and without the legacy manual deals, and the skipped counts", () => {
    const s = {
      ...base,
      recall: { k: 3, n: 4, interval: { rate: 75, low: 30.1, high: 95.4 } },
      recallExcludingLegacy: { k: 2, n: 3, interval: { rate: 66.7, low: 20.8, high: 93.9 } },
      recallWithCleanupYesExcludingLegacy: { k: 3, n: 4, interval: { rate: 75, low: 30.1, high: 95.4 } },
      side: { correct: 1, wrong: 0, notPredicted: 1, skipped: 2 },
      outcome: { scorable: 3, skipped: 1, predicted: 0 },
    };
    const lines = learnDetailLines(s);
    expect(lines).toContain("Deals found: 3 of 4 (75%)");
    expect(lines).toContain("Deals found, without manual deals created before 2026-08-31: 2 of 3 (66.7%)");
    expect(lines).toContain(
      "Deals found, counting your Yes answers, without manual deals created before 2026-08-31: 3 of 4 (75%)",
    );
    expect(lines).toContain(
      "Buyer or seller: 1 right, 0 wrong, 1 not predicted; 2 skipped (deal type not buyer or seller)",
    );
    expect(lines).toContain("Outcome: 3 deals could be scored; 1 skipped (status not closed, active or pending)");
  });
});

describe("sender filter line (BACKLOG-4175)", () => {
  it("sums the mailboxes' full counts and names the lost deals", () => {
    const mailbox = (k: number, n: number) => ({
      label: "mailbox",
      provider: "gmail" as const,
      n,
      full: { k, bySignal: {} },
      minusContactKeeps: { k, bySignal: {} },
      addressPassReady: k === 0,
      detectorReady: false,
    });
    const s = {
      ...base,
      senderCensus: {
        ...base.senderCensus,
        dealLinkedSuppressed: [mailbox(1, 3), mailbox(2, 4)],
        foundDealsLost: { full: 1, minusContactKeeps: 2 },
      },
    };
    expect(learnDetailLines(s)).toContain(
      "Sender filter (measured only): would hide 3 of 7 emails linked to your deals; deals it would lose: 1",
    );
  });
});
