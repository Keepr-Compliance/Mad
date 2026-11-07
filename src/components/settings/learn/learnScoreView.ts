/**
 * What the Learn mode screens show from a score — BACKLOG-4120 PR3.
 *
 * Counts only (the score itself holds no address, subject or id). The three
 * tiles on L1 and L4:
 *   found      hand-entered deals Keepr found, of the hand-entered deals in
 *              the mail window created on or after this user's cutoff (recall
 *              without legacy manual deals; the details keep both bases)
 *   wrongFinds shown deals that are not real: detections matched to a deal
 *              you rejected plus detections you answered No to (the "7 of 10
 *              shown deals are real" bar is per shown detection)
 *   missed     the same base, deals Keepr did not find
 * The detail lines carry what the boards do not: recall with and without the
 * cleanup Yes answers and without manual deals created before this user's
 * cutoff (with "minimum" when no auto-detected row proves the cutoff), and
 * how many deals side and outcome could not be scored on.
 */
import type { LearnScore } from "../../../../electron/types/ipc/window-api-learn";

type Rate = LearnScore["recall"];

export interface LearnTiles {
  found: number;
  of: number;
  wrongFinds: number;
  missed: number;
  /** True when no deal is left to score on (every manual deal predates the cutoff). */
  empty: boolean;
}

export function learnTiles(s: LearnScore): LearnTiles {
  const shownWrong = s.precisionAfterCleanup.n - s.precisionAfterCleanup.k;
  const base = s.recallExcludingLegacy;
  return { found: base.k, of: base.n, wrongFinds: shownWrong, missed: base.n - base.k, empty: base.n === 0 };
}

function pct(r: Rate): string {
  return r.interval ? `${r.interval.rate}%` : "n/a";
}

function line(label: string, r: Rate): string {
  return `${label}: ${r.k} of ${r.n} (${pct(r)})`;
}

export function learnDetailLines(s: LearnScore): string[] {
  const legacy = `${s.legacyManualPositives}${s.legacyCutoffIsMinimum ? " (minimum)" : ""}`;
  return [
    line("Deals found", s.recall),
    line("Deals found, counting your Yes answers", s.recallWithCleanupYes),
    line(`Deals found, without manual deals created before ${s.legacyCutoffDay}`, s.recallExcludingLegacy),
    line(
      `Deals found, counting your Yes answers, without manual deals created before ${s.legacyCutoffDay}`,
      s.recallWithCleanupYesExcludingLegacy,
    ),
    `Manual deals created before ${s.legacyCutoffDay} (possibly auto-detected): ${legacy}`,
    line("Shown deals that are real", s.precisionAfterCleanup),
    `Buyer or seller: ${s.side.correct} right, ${s.side.wrong} wrong, ${s.side.notPredicted} not predicted; ${s.side.skipped} skipped (deal type not buyer or seller)`,
    `Outcome: ${s.outcome.scorable} deals could be scored; ${s.outcome.skipped} skipped (status not closed, active or pending)`,
    `Mail questions: ${s.bulk.realEstate} real estate, ${s.bulk.newsletterSpam} newsletter or spam, ${s.bulk.skip} skipped`,
  ];
}
