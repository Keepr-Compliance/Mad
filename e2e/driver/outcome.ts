/**
 * Trustworthy outcome classification for the Keepr QA driver (BACKLOG-1940).
 *
 * THE FOUNDER'S CORE CONCERN: every run/step must resolve to exactly ONE of three
 * distinct outcomes, and they must NEVER be conflated:
 *
 *   PASS          the app behaved correctly / an assertion held.
 *   FAIL          the app produced wrong data or state — a REAL application bug.
 *   HARNESS_ERROR the harness itself could not complete: a selector/testid was not
 *                 found, launch failed, CDP disconnected, a step timed out, the app
 *                 shape was unexpected, or login never completed.
 *
 * The critical, load-bearing distinction:
 *   "the transactions list testid was not found" is a HARNESS_ERROR (or an
 *   app-shape-changed signal). It must NEVER be reported as "0 transactions"
 *   (a false FAIL), and must NEVER be swallowed as PASS.
 *
 * A HARNESS_ERROR is what makes the harness trustworthy: it says "do not trust this
 * run's PASS/FAIL verdict — the harness could not observe the thing it was asked to
 * judge." It is LOUD and DISTINCT: a dedicated enum value, a dedicated exit code, and
 * a classifier that CANNOT downgrade it into PASS/FAIL.
 *
 * This module is pure (no Playwright, no I/O) so it is fully unit-testable without
 * launching the app. See __tests__/outcome.test.ts for the misclassification proofs.
 */

/** The three mutually-exclusive outcomes. String-valued for stable logging/serialization. */
export enum Outcome {
  /** The app behaved correctly / the assertion held. */
  PASS = 'PASS',
  /** The app produced wrong data or state — a REAL application bug. */
  FAIL = 'FAIL',
  /** The harness could not complete — DO NOT trust any PASS/FAIL for this step. */
  HARNESS_ERROR = 'HARNESS_ERROR',
}

/**
 * Why a HARNESS_ERROR happened. Purely informational — it never changes the fact that
 * the outcome is HARNESS_ERROR. Kept as a closed union so new causes are added deliberately.
 */
export type HarnessErrorCategory =
  | 'selector-not-found' // an expected testid/element was not present
  | 'launch-failed' // the app could not be launched/attached
  | 'environment-signing' // ENVIRONMENT: the QA build's code signature is invalid → macOS kills it on launch
  | 'cdp-disconnect' // the CDP/renderer connection dropped mid-run
  | 'timeout' // a step exceeded its deadline
  | 'unexpected-app-shape' // the screen did not match any known shape
  | 'login-not-completed' // the login wall never cleared within budget
  | 'internal'; // an unexpected throw inside the harness itself

/** A single classified step result. Immutable-by-convention. */
export interface StepResult {
  /** The step name, e.g. "goto-settings", "assert-empty-transactions". */
  readonly step: string;
  /** The one-of-three verdict. */
  readonly outcome: Outcome;
  /** Human-readable detail (what was checked / what went wrong). */
  readonly detail: string;
  /** Present ONLY when outcome === HARNESS_ERROR. Informational. */
  readonly harnessCategory?: HarnessErrorCategory;
  /** Optional structured evidence (selector tried, observed value, etc.). */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** Distinct process exit codes so a CI/founder shell can branch on the outcome. */
export const EXIT_CODES: Readonly<Record<Outcome, number>> = Object.freeze({
  [Outcome.PASS]: 0,
  [Outcome.FAIL]: 1,
  [Outcome.HARNESS_ERROR]: 2,
});

// -----------------------------------------------------------------------------
// Constructors — the ONLY sanctioned way to make a StepResult. Using constructors
// (instead of hand-built objects) guarantees the outcome/category invariants hold.
// -----------------------------------------------------------------------------

/** PASS: the assertion held. */
export function pass(step: string, detail: string, evidence?: Record<string, unknown>): StepResult {
  return { step, outcome: Outcome.PASS, detail, evidence };
}

/**
 * FAIL: the app produced wrong data/state — a REAL bug. Use this ONLY when the harness
 * successfully OBSERVED the app and the observation was wrong. If the harness could not
 * observe (missing selector, timeout, ...), use harnessError instead — never fail().
 */
export function fail(step: string, detail: string, evidence?: Record<string, unknown>): StepResult {
  return { step, outcome: Outcome.FAIL, detail, evidence };
}

/**
 * HARNESS_ERROR: the harness could not complete this step, so its PASS/FAIL is unknowable.
 * LOUD + DISTINCT. This is the value that prevents a missing testid from masquerading as
 * a real "0 transactions" FAIL.
 */
export function harnessError(
  step: string,
  category: HarnessErrorCategory,
  detail: string,
  evidence?: Record<string, unknown>,
): StepResult {
  return { step, outcome: Outcome.HARNESS_ERROR, detail, harnessCategory: category, evidence };
}

// -----------------------------------------------------------------------------
// Error → outcome classifier. Maps a thrown value onto a HARNESS_ERROR (never PASS/FAIL).
// A thrown error inside a driving step is, by definition, a harness problem — the app
// itself does not throw into our process. So this can only ever yield HARNESS_ERROR.
// -----------------------------------------------------------------------------

/**
 * Classify a thrown value from a driving step into a HARNESS_ERROR with a best-effort
 * category. GUARANTEE: the returned outcome is ALWAYS HARNESS_ERROR — a thrown error can
 * never be silently classified as PASS or FAIL. The category is heuristic (from the message)
 * and is informational only; it does not affect the outcome.
 */
export function classifyThrown(step: string, err: unknown): StepResult {
  const message = err instanceof Error ? err.message : String(err);
  const category = categorizeMessage(message);
  return harnessError(step, category, message, { thrown: true });
}

/** Best-effort category from an error message. Never affects the (always HARNESS_ERROR) outcome. */
export function categorizeMessage(message: string): HarnessErrorCategory {
  const m = message.toLowerCase();
  // Order matters: most specific signals first.
  // ENVIRONMENT/signing: on macOS 15 the strict code-signing monitor KILLS an ad-hoc/unsigned QA
  // build on launch (EXC_BAD_ACCESS / "Namespace CODESIGNING" / "invalid page" / SIGKILL in dyld,
  // before any app code runs). This is NOT an app bug and NOT a plain launch bug — it's an invalid
  // QA-build signature. Detect it distinctly so it can never be read as a PASS/FAIL of the app.
  if (/codesigning|code signature|invalid page|invalid signature|exc_bad_access|killed: 9|sigkill|codesign/.test(m)) {
    return 'environment-signing';
  }
  if (/failed to launch|could not be launched|no packaged .*executable|port .*never opened/.test(m)) {
    return 'launch-failed';
  }
  if (/disconnect|target closed|websocket|browser has been closed|connection closed/.test(m)) {
    return 'cdp-disconnect';
  }
  if (/timeout|timed out|exceeded|deadline/.test(m)) return 'timeout';
  if (/login|sign in|not logged in/.test(m)) return 'login-not-completed';
  if (/not found|no element|testid|selector|locator|waiting for/.test(m)) return 'selector-not-found';
  if (/unexpected|unknown state|no known shape|did not match/.test(m)) return 'unexpected-app-shape';
  return 'internal';
}

// -----------------------------------------------------------------------------
// Aggregation. A run's overall outcome is the WORST of its steps, with a strict
// precedence that keeps HARNESS_ERROR from ever being hidden behind a PASS/FAIL.
//
//   HARNESS_ERROR  >  FAIL  >  PASS
//
// Rationale: if ANY step could not be observed (HARNESS_ERROR), the whole run's verdict
// is untrustworthy and MUST surface as HARNESS_ERROR — you cannot claim the run "passed"
// or even "failed" when part of it was never actually judged.
// -----------------------------------------------------------------------------

const PRECEDENCE: Readonly<Record<Outcome, number>> = Object.freeze({
  [Outcome.PASS]: 0,
  [Outcome.FAIL]: 1,
  [Outcome.HARNESS_ERROR]: 2,
});

/** The single worst outcome across steps. Empty run → HARNESS_ERROR (nothing was verified). */
export function aggregateOutcome(results: readonly StepResult[]): Outcome {
  if (results.length === 0) return Outcome.HARNESS_ERROR;
  let worst: Outcome = Outcome.PASS;
  for (const r of results) {
    if (PRECEDENCE[r.outcome] > PRECEDENCE[worst]) worst = r.outcome;
  }
  return worst;
}

/** Map an aggregated outcome onto its distinct process exit code. */
export function exitCodeFor(outcome: Outcome): number {
  return EXIT_CODES[outcome];
}

/** A whole-run summary, ready to print + drive an exit code. */
export interface RunSummary {
  readonly outcome: Outcome;
  readonly exitCode: number;
  readonly counts: Readonly<Record<Outcome, number>>;
  readonly steps: readonly StepResult[];
}

/** Build the run summary (counts, aggregate outcome, exit code) from step results. */
export function summarize(steps: readonly StepResult[]): RunSummary {
  const counts: Record<Outcome, number> = {
    [Outcome.PASS]: 0,
    [Outcome.FAIL]: 0,
    [Outcome.HARNESS_ERROR]: 0,
  };
  for (const s of steps) counts[s.outcome] += 1;
  const outcome = aggregateOutcome(steps);
  return { outcome, exitCode: exitCodeFor(outcome), counts, steps };
}

/**
 * Render a LOUD, unambiguous one-line banner for an outcome. HARNESS_ERROR is visually
 * distinct so it can never be mistaken for a PASS or FAIL when skimming a log.
 */
export function banner(outcome: Outcome): string {
  switch (outcome) {
    case Outcome.PASS:
      return '✅ PASS — the app behaved correctly.';
    case Outcome.FAIL:
      return '❌ FAIL — the app produced wrong data/state (REAL app bug).';
    case Outcome.HARNESS_ERROR:
      return '🟠 HARNESS_ERROR — the harness could NOT complete; do NOT trust any PASS/FAIL for this run.';
  }
}
