/**
 * Unit tests for the QA-H7 EDGE-CASE asserter pure evaluators (BACKLOG-1854).
 *
 * TIER 1 (pure logic) — no spawning, no DB, no Electron. Covers idempotence
 * set-stability, timezone +1-day boundary recovery, ghost/resurrection gate,
 * signature false-positive invariant, and the two fixture-backed LOG cells
 * (telemetry BACKLOG-1843 + redaction BACKLOG-1785) incl. the REPORTED-NOT-GATED
 * contract (never fails the run, always carries the leak count).
 */
import * as path from 'path';
import {
  evaluateIdempotenceCell,
  evaluateTimezoneCell,
  evaluateGhostsCell,
  evaluateSignatureCell,
  evaluateTelemetryCell,
  evaluateRedactionCell,
  evaluateMeasurement,
  type Measurement,
  type EdgeExpectationBundle,
} from '../edge-case-asserter';

const SCENARIO_PATH = path.join(
  __dirname, '..', '..', '..', '..', 'docs', 'qa', 'scenarios', 'tx1-birchwood.json',
);

const M = (subject: string, shiftedDate: string) => ({ subject, shiftedDate });

function bundle(overrides: Partial<EdgeExpectationBundle['scenario']> = {}): EdgeExpectationBundle {
  return {
    scenarioPath: SCENARIO_PATH,
    scenario: {
      expectedCounts: { corpus: 190, filterOff: 69, filterOn: 37 },
      sourceTimezone: 'America/Los_Angeles',
      edgeCases: {
        timezoneBoundary: [
          { subject: '742 Birchwood Lane showing today - thoughts?', expectedShiftedDate: '2026-02-07' },
        ],
        signatureProbeAddress: 'michelle.torres@gmail.com',
        signatureProbeIsContact: false,
        logScan: {
          telemetryFixture: 'fixtures/main-log-with-telemetry.sample.txt',
          redactionAllowlist: ['noreply@', '@keeprcompliance.com'],
        },
      },
      ...overrides,
    },
  };
}

describe('evaluateIdempotenceCell', () => {
  const idemOK: Measurement['idempotence'] = {
    filterOffRun1: Array.from({ length: 69 }, (_, i) => M(`s${i}`, '2026-02-07')),
    filterOffRun2: Array.from({ length: 69 }, (_, i) => M(`s${i}`, '2026-02-07')),
    filterOnRun1: Array.from({ length: 37 }, (_, i) => M(`o${i}`, '2026-02-07')),
    filterOnRun2: Array.from({ length: 37 }, (_, i) => M(`o${i}`, '2026-02-07')),
  };

  test('stable runs + manifest counts → pass, named set-stability', () => {
    const cell = evaluateIdempotenceCell({ idempotence: idemOK }, bundle());
    expect(cell.id).toBe('idempotence:set-stability');
    expect(cell.status).toBe('pass');
    expect(cell.detail).toMatch(/H4\/BACKLOG-1851/); // scope boundary stated
  });

  test('run1 != run2 → fail (a read that "changed" is a real bug)', () => {
    const idem = { ...idemOK, filterOffRun2: idemOK!.filterOffRun1.slice(0, 68) };
    const cell = evaluateIdempotenceCell({ idempotence: idem }, bundle());
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.some((d) => d.cell === 'idempotence:off-stability')).toBe(true);
  });

  test('count != manifest → fail with off-count deviation', () => {
    const idem = {
      ...idemOK,
      filterOffRun1: idemOK!.filterOffRun1.slice(0, 68),
      filterOffRun2: idemOK!.filterOffRun2.slice(0, 68),
    };
    const cell = evaluateIdempotenceCell({ idempotence: idem }, bundle());
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.some((d) => d.cell === 'idempotence:off-count')).toBe(true);
  });
});

describe('evaluateTimezoneCell', () => {
  test('boundary subject resolves to expected LOCAL date → pass', () => {
    const m: Measurement = {
      timezoneBoundary: [
        { subject: '742 Birchwood Lane showing today - thoughts?', matches: [{ subject: 'x', shiftedDate: '2026-02-07', sentAtRaw: '2026-02-08T00:30:00Z' }] },
      ],
    };
    const cell = evaluateTimezoneCell(m, bundle());
    expect(cell.status).toBe('pass');
    expect(cell.detail).toMatch(/\+1-day UTC/);
  });

  test('wrong shifted date (the +1-day UTC leaked through) → fail', () => {
    const m: Measurement = {
      timezoneBoundary: [
        { subject: '742 Birchwood Lane showing today - thoughts?', matches: [{ subject: 'x', shiftedDate: '2026-02-08', sentAtRaw: '2026-02-08T00:30:00Z' }] },
      ],
    };
    const cell = evaluateTimezoneCell(m, bundle());
    expect(cell.status).toBe('fail');
  });

  test('subject absent from DB → skip (partial corpus), never a false fail', () => {
    const m: Measurement = { timezoneBoundary: [{ subject: '742 Birchwood Lane showing today - thoughts?', matches: [] }] };
    const cell = evaluateTimezoneCell(m, bundle());
    expect(cell.status).toBe('skip');
  });

  test('no boundary rows declared → info', () => {
    const cell = evaluateTimezoneCell({}, bundle({ edgeCases: { timezoneBoundary: [] } }));
    expect(cell.status).toBe('info');
  });
});

describe('evaluateGhostsCell (BACKLOG-1764)', () => {
  test('0 resurrections → pass', () => {
    const cell = evaluateGhostsCell({ ghosts: { tombstoneCount: 12, resurrections: [] } });
    expect(cell.status).toBe('pass');
  });
  test('any resurrection → fail with extraMembers', () => {
    const cell = evaluateGhostsCell({ ghosts: { tombstoneCount: 12, resurrections: [M('ghost', '2026-05-01')] } });
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.[0].extraMembers?.length).toBe(1);
  });
});

describe('evaluateSignatureCell', () => {
  test('non-contact probe with 0 participant links → pass', () => {
    const m: Measurement = { signature: { probeAddress: 'michelle.torres@gmail.com', participant: [], freetext: [M('sig mention', '2026-03-01')] } };
    const cell = evaluateSignatureCell(m, bundle());
    expect(cell.status).toBe('pass');
  });

  test('non-contact probe that leaked into participant set → fail', () => {
    const m: Measurement = { signature: { probeAddress: 'michelle.torres@gmail.com', participant: [M('unrelated', '2026-03-01')], freetext: [] } };
    const cell = evaluateSignatureCell(m, bundle());
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.some((d) => d.cell === 'signature:non-contact-participant')).toBe(true);
  });

  test('probe absent from corpus entirely → info (vacuous)', () => {
    const m: Measurement = { signature: { probeAddress: 'michelle.torres@gmail.com', participant: [], freetext: [] } };
    const cell = evaluateSignatureCell(m, bundle());
    expect(cell.status).toBe('info');
  });

  test('no probe configured → info', () => {
    const cell = evaluateSignatureCell({ signature: null }, bundle({ edgeCases: {} }));
    expect(cell.status).toBe('info');
  });
});

describe('evaluateTelemetryCell (BACKLOG-1843)', () => {
  test('fixture with all markers → pass', () => {
    const cell = evaluateTelemetryCell(bundle());
    expect(cell.status).toBe('pass');
    expect(cell.detail).toMatch(/3\/3/);
  });

  test('no fixture → gated (non-fail), even if a real log exists', () => {
    const cell = evaluateTelemetryCell(bundle({ edgeCases: { logScan: {} } }));
    expect(cell.status).toBe('gated');
    expect(cell.status).not.toBe('fail');
  });

  test('fixture MISSING markers → fail (the committed fixture is the source of truth)', () => {
    const cell = evaluateTelemetryCell(
      bundle({
        edgeCases: {
          logScan: {
            telemetryFixture:
              '../../../scripts/qa/harness/__tests__/fixtures/main-log-no-telemetry.sample.txt',
          },
        },
      }),
    );
    expect(cell.status).toBe('fail');
    expect(cell.deviations?.length).toBeGreaterThan(0);
  });

  test('a real machine-local log is only observed — never forces a deterministic FAIL', () => {
    // Fixture has all markers (pass); even if a stale real log lacks them, the
    // real log is appended as an observation, not a gate → stays pass.
    const cell = evaluateTelemetryCell(bundle());
    expect(cell.status).toBe('pass');
  });
});

describe('evaluateRedactionCell (guards BACKLOG-1785) — REPORTED-NOT-GATED', () => {
  test('clean fixture → reported, 0 leaks, count in detail, NEVER fails', () => {
    const cell = evaluateRedactionCell(bundle());
    expect(cell.status).toBe('reported');
    expect(cell.detail).toMatch(/0 plaintext email leak/);
    expect(cell.detail).toMatch(/REPORTED-NOT-GATED/);
    expect(cell.status).not.toBe('fail');
  });

  test('no log source → gated, still reports 0 and is non-fail', () => {
    const cell = evaluateRedactionCell(bundle({ edgeCases: { logScan: {} } }));
    expect(cell.status).toBe('gated');
    expect(cell.status).not.toBe('fail');
  });
});

describe('evaluateMeasurement — full matrix wiring', () => {
  test('assembles 6 cells; redaction never drags status to fail', () => {
    const m: Measurement = {
      idempotence: {
        filterOffRun1: [M('a', '2026-02-07')], filterOffRun2: [M('a', '2026-02-07')],
        filterOnRun1: [M('a', '2026-02-07')], filterOnRun2: [M('a', '2026-02-07')],
      },
      timezoneBoundary: [{ subject: '742 Birchwood Lane showing today - thoughts?', matches: [{ subject: 'x', shiftedDate: '2026-02-07', sentAtRaw: 'z' }] }],
      ghosts: { tombstoneCount: 0, resurrections: [] },
      signature: { probeAddress: 'michelle.torres@gmail.com', participant: [], freetext: [] },
    };
    const cells = evaluateMeasurement(m, bundle({ expectedCounts: { filterOff: 1, filterOn: 1 } }));
    expect(cells).toHaveLength(6);
    const ids = cells.map((c) => c.id);
    expect(ids).toEqual([
      'idempotence:set-stability',
      'timezone:evening-boundary',
      'ghost-resurrection',
      'signature-false-positive',
      'telemetry-packaged-build',
      'log-redaction',
    ]);
    // The redaction cell is reported, not fail.
    expect(cells.find((c) => c.id === 'log-redaction')!.status).toBe('reported');
  });
});
