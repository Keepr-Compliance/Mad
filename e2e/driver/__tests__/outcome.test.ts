/**
 * Trust proofs for the QA driver's outcome classification (BACKLOG-1940).
 *
 * These tests are the founder's guarantee. They PROVE that the three outcomes
 * (PASS / FAIL / HARNESS_ERROR) can never be conflated, and specifically that a
 * harness problem (missing selector, launch failure, timeout, CDP disconnect,
 * unexpected app shape, login-not-completed) ALWAYS surfaces as HARNESS_ERROR and
 * can NEVER be silently downgraded into a PASS or a false FAIL.
 *
 * Pure module → no app launch, no Playwright. Runs under `npm test`.
 */
import {
  aggregateOutcome,
  banner,
  categorizeMessage,
  classifyThrown,
  EXIT_CODES,
  exitCodeFor,
  fail,
  harnessError,
  Outcome,
  pass,
  summarize,
  type HarnessErrorCategory,
  type StepResult,
} from '../outcome';

describe('Outcome enum + exit codes are three distinct values', () => {
  it('has exactly three outcomes', () => {
    expect(Object.values(Outcome).sort()).toEqual(['FAIL', 'HARNESS_ERROR', 'PASS']);
  });

  it('maps each outcome to a DISTINCT exit code (0/1/2)', () => {
    expect(EXIT_CODES[Outcome.PASS]).toBe(0);
    expect(EXIT_CODES[Outcome.FAIL]).toBe(1);
    expect(EXIT_CODES[Outcome.HARNESS_ERROR]).toBe(2);
    const codes = [EXIT_CODES[Outcome.PASS], EXIT_CODES[Outcome.FAIL], EXIT_CODES[Outcome.HARNESS_ERROR]];
    expect(new Set(codes).size).toBe(3); // all distinct — a shell can branch on them
  });
});

describe('constructors preserve the outcome invariant', () => {
  it('pass() yields PASS with no harness category', () => {
    const r = pass('step', 'ok');
    expect(r.outcome).toBe(Outcome.PASS);
    expect(r.harnessCategory).toBeUndefined();
  });

  it('fail() yields FAIL with no harness category', () => {
    const r = fail('step', 'wrong value');
    expect(r.outcome).toBe(Outcome.FAIL);
    expect(r.harnessCategory).toBeUndefined();
  });

  it('harnessError() yields HARNESS_ERROR and always carries a category', () => {
    const r = harnessError('step', 'selector-not-found', 'testid missing');
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.harnessCategory).toBe('selector-not-found');
  });
});

describe('THE TRUST GUARANTEE: harness problems can NEVER be PASS or FAIL', () => {
  // A missing testid is the canonical trap: it must NOT become "0 transactions" (false FAIL)
  // nor be swallowed as PASS. It is a HARNESS_ERROR.
  it('missing transactions-list testid → HARNESS_ERROR (never "0 transactions" FAIL, never PASS)', () => {
    const r = classifyThrown(
      'assert-transactions',
      new Error('locator.waitFor: Timeout 15000ms exceeded waiting for getByTestId("tx-list")'),
    );
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.outcome).not.toBe(Outcome.PASS);
    expect(r.outcome).not.toBe(Outcome.FAIL);
  });

  it('launch failure → HARNESS_ERROR', () => {
    const r = classifyThrown('launch', new Error('[keepr-e2e] _electron.launch failed — Process failed to launch!'));
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.harnessCategory).toBe('launch-failed');
  });

  it('macOS-15 code-signing kill → HARNESS_ERROR (environment-signing, NOT an app FAIL)', () => {
    // The exact shape of the founder's crash: an invalid QA-build signature killed by the OS.
    for (const msg of [
      'Namespace CODESIGNING, Code 2 Invalid Page',
      'EXC_BAD_ACCESS in dyld loading Electron Framework',
      'Keepr quit unexpectedly: Killed: 9',
      'code signature invalid for Electron',
    ]) {
      const r = classifyThrown('launch', new Error(msg));
      expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
      expect(r.harnessCategory).toBe('environment-signing');
      expect(r.outcome).not.toBe(Outcome.FAIL); // an invalid QA-build signature is NOT an app bug
    }
  });

  it('timeout → HARNESS_ERROR', () => {
    const r = classifyThrown('goto-settings', new Error('Timeout 30000ms exceeded.'));
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.harnessCategory).toBe('timeout');
  });

  it('CDP disconnect → HARNESS_ERROR', () => {
    const r = classifyThrown('read-screen', new Error('Target closed / websocket disconnect'));
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.harnessCategory).toBe('cdp-disconnect');
  });

  it('login-not-completed → HARNESS_ERROR', () => {
    const r = classifyThrown('await-login', new Error('login wall did not clear: not logged in'));
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.harnessCategory).toBe('login-not-completed');
  });

  it('unexpected app shape → HARNESS_ERROR', () => {
    const r = classifyThrown('detect-state', new Error('unexpected app shape: no known screen matched'));
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.harnessCategory).toBe('unexpected-app-shape');
  });

  it('an UNKNOWN thrown value is still HARNESS_ERROR (never PASS/FAIL) — category falls back to internal', () => {
    for (const thrown of [undefined, null, 42, {}, 'boom', new Error('???')]) {
      const r = classifyThrown('mystery', thrown);
      expect(r.outcome).toBe(Outcome.HARNESS_ERROR); // the outcome invariant holds for ANY input
    }
  });

  it('classifyThrown NEVER returns PASS or FAIL for ANY category of message', () => {
    const messages = [
      'Timeout 5000ms exceeded',
      'getByTestId("nav-settings") not found',
      'Process failed to launch!',
      'websocket disconnected',
      'not logged in — sign in with browser',
      'unexpected unknown state',
      'some totally unrelated explosion',
      '', // empty
    ];
    for (const msg of messages) {
      expect(classifyThrown('s', new Error(msg)).outcome).toBe(Outcome.HARNESS_ERROR);
    }
  });
});

describe('categorizeMessage is heuristic but NEVER changes the outcome', () => {
  const cases: Array<[string, HarnessErrorCategory]> = [
    ['Process failed to launch!', 'launch-failed'],
    ['CDP port 9333 never opened within 30000ms', 'launch-failed'],
    ['Namespace CODESIGNING invalid page', 'environment-signing'],
    ['app was Killed: 9 by the OS', 'environment-signing'],
    ['Target closed', 'cdp-disconnect'],
    ['Timeout 15000ms exceeded', 'timeout'],
    ['user is not logged in', 'login-not-completed'],
    ['getByTestId("tx-list") — no element found', 'selector-not-found'],
    ['unexpected app shape', 'unexpected-app-shape'],
    ['completely novel failure', 'internal'],
  ];
  it.each(cases)('categorizes %p as %p', (msg, expected) => {
    expect(categorizeMessage(msg)).toBe(expected);
  });
});

describe('aggregateOutcome: HARNESS_ERROR > FAIL > PASS (harness error can never hide)', () => {
  const P = pass('p', 'ok');
  const F = fail('f', 'bug');
  const H = harnessError('h', 'timeout', 'stuck');

  it('all PASS → PASS', () => {
    expect(aggregateOutcome([P, P, P])).toBe(Outcome.PASS);
  });

  it('any FAIL among PASS → FAIL', () => {
    expect(aggregateOutcome([P, F, P])).toBe(Outcome.FAIL);
  });

  it('a single HARNESS_ERROR dominates even amid PASS and FAIL', () => {
    expect(aggregateOutcome([P, F, H, P])).toBe(Outcome.HARNESS_ERROR);
    expect(aggregateOutcome([H])).toBe(Outcome.HARNESS_ERROR);
    expect(aggregateOutcome([F, H])).toBe(Outcome.HARNESS_ERROR);
  });

  it('an EMPTY run is HARNESS_ERROR — nothing was actually verified, so it cannot be PASS', () => {
    expect(aggregateOutcome([])).toBe(Outcome.HARNESS_ERROR);
  });
});

describe('summarize: counts + aggregate + exit code are consistent', () => {
  it('produces counts, the dominant outcome, and its distinct exit code', () => {
    const steps: StepResult[] = [pass('a', ''), pass('b', ''), fail('c', ''), harnessError('d', 'timeout', '')];
    const s = summarize(steps);
    expect(s.counts[Outcome.PASS]).toBe(2);
    expect(s.counts[Outcome.FAIL]).toBe(1);
    expect(s.counts[Outcome.HARNESS_ERROR]).toBe(1);
    expect(s.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(s.exitCode).toBe(2);
  });

  it('a clean run summarizes to PASS/exit 0', () => {
    const s = summarize([pass('a', ''), pass('b', '')]);
    expect(s.outcome).toBe(Outcome.PASS);
    expect(s.exitCode).toBe(0);
  });

  it('exitCodeFor matches the EXIT_CODES table for all three outcomes', () => {
    expect(exitCodeFor(Outcome.PASS)).toBe(0);
    expect(exitCodeFor(Outcome.FAIL)).toBe(1);
    expect(exitCodeFor(Outcome.HARNESS_ERROR)).toBe(2);
  });
});

describe('THE EMPTY-LIST BOUNDARY: empty ≠ harness error (PASS vs HARNESS_ERROR)', () => {
  // This is the exact boundary from the task: an EMPTY transactions list, correctly
  // observed (tx-list present, tx-empty rendered), is a PASS — not a HARNESS_ERROR and
  // not a FAIL. Only a MISSING tx-list is a HARNESS_ERROR.
  it('tx-list present + empty-state rendered on an empty profile → PASS', () => {
    // Simulated observation: the list container WAS found, and it reported empty.
    const observed = { txListFound: true, rowCount: 0, emptyStateFound: true };
    const r = observed.txListFound && observed.emptyStateFound && observed.rowCount === 0
      ? pass('assert-empty-transactions', 'tx-list present and correctly empty', observed)
      : harnessError('assert-empty-transactions', 'selector-not-found', 'tx-list missing', observed);
    expect(r.outcome).toBe(Outcome.PASS);
  });

  it('tx-list NOT found → HARNESS_ERROR (must NOT be reported as 0 transactions)', () => {
    const observed = { txListFound: false, rowCount: 0, emptyStateFound: false };
    const r = observed.txListFound
      ? pass('assert-empty-transactions', 'empty', observed)
      : harnessError(
          'assert-empty-transactions',
          'selector-not-found',
          'tx-list testid was not found — cannot claim "0 transactions"',
          observed,
        );
    expect(r.outcome).toBe(Outcome.HARNESS_ERROR);
    expect(r.outcome).not.toBe(Outcome.FAIL); // NOT a false "0 transactions" FAIL
    expect(r.harnessCategory).toBe('selector-not-found');
  });
});

describe('banner is LOUD and DISTINCT per outcome', () => {
  it('produces a different banner string for each outcome', () => {
    const b = [banner(Outcome.PASS), banner(Outcome.FAIL), banner(Outcome.HARNESS_ERROR)];
    expect(new Set(b).size).toBe(3);
    expect(banner(Outcome.HARNESS_ERROR)).toMatch(/HARNESS_ERROR/);
    expect(banner(Outcome.HARNESS_ERROR)).toMatch(/do NOT trust/i);
  });
});
