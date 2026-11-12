/**
 * What the Learn mode screens show from a score — BACKLOG-4120 PR3.
 *
 * Counts only (the score itself holds no address, subject or id). The three
 * tiles on L1 and L4:
 *   found      deals Keepr found, of your deals in the mail window: the
 *              hand-entered deals created on or after this user's cutoff plus
 *              the cleanup Yes answers on streets with no deal in Keepr
 *              (recall counting your Yes answers, without legacy manual
 *              deals; BACKLOG-4219). The details keep every other base.
 *   wrongFinds shown deals that are not real: detections matched to a deal
 *              you rejected plus detections you answered No to (the "7 of 10
 *              shown deals are real" bar is per shown detection)
 *   missed     the same base, deals Keepr did not find (a Yes is always
 *              found, so this is the hand-entered deals it missed)
 *   empty      no hand-entered deal on or after the cutoff: Yes answers
 *              alone do not make a score (every Yes would read 100%)
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
  /** True when no hand-entered deal is left to score on (every manual deal predates the cutoff); Yes answers alone do not count. */
  empty: boolean;
}

export function learnTiles(s: LearnScore): LearnTiles {
  const shownWrong = s.precisionAfterCleanup.n - s.precisionAfterCleanup.k;
  const base = s.recallWithCleanupYesExcludingLegacy;
  return {
    found: base.k,
    of: base.n,
    wrongFinds: shownWrong,
    missed: base.n - base.k,
    empty: s.recallExcludingLegacy.n === 0,
  };
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
    `Yes answers not counted again (same street as a deal in Keepr): ${s.cleanupYesNotCounted}`,
    line("Shown deals that are real", s.precisionAfterCleanup),
    `Buyer or seller: ${s.side.correct} right, ${s.side.wrong} wrong, ${s.side.notPredicted} not predicted; ${s.side.skipped} skipped (deal type not buyer or seller)`,
    `Outcome: ${s.outcome.scorable} deals could be scored; ${s.outcome.skipped} skipped (status not closed, active or pending)`,
    `Mail questions: ${s.bulk.realEstate} real estate, ${s.bulk.newsletterSpam} newsletter or spam, ${s.bulk.skip} skipped`,
    senderFilterLine(s),
  ];
}

/** BACKLOG-4175: the sender filter is measured only; one line of what it would hide. */
function senderFilterLine(s: LearnScore): string {
  const c = s.senderCensus;
  const k = c.dealLinkedSuppressed.reduce((t, m) => t + m.full.k, 0);
  const n = c.dealLinkedSuppressed.reduce((t, m) => t + m.n, 0);
  return `Sender filter (measured only): would hide ${k} of ${n} emails linked to your deals; deals it would lose: ${c.foundDealsLost.full}`;
}
