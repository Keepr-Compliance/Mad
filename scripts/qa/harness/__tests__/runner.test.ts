import { resolve } from 'path';
import { runCeremony } from '../runner';
import { buildComponents } from '../components/registry';
import {
  stubDriver,
  stubExportAsserter,
  stubUpdateRunner,
  createStubSeeder,
} from '../components/stubs';
import type {
  CeremonyComponents,
  CeremonyContext,
  CeremonyOptions,
  CanonicalEmail,
  DbSetDiffAsserter,
  ExpectedSets,
  Logger,
  ScenarioManifest,
  SeederComponent,
  SetDiffResult,
  StageResult,
} from '../types';

const REPO_ROOT = resolve(__dirname, '../../../..');

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function canonical(subject: string, date: string, onSubset = false): CanonicalEmail {
  return { index: 0, emlFile: 'x.eml', matchedContacts: '', subject, shiftedDate: date, onSubset };
}

const expected: ExpectedSets = {
  counts: { corpus: 2, filterOff: 2, filterOn: 1, missing: 0, extra: 0, ghosts: 0 },
  filterOff: [canonical('A', '2026-01-01', true), canonical('B', '2026-01-02')],
  filterOn: [canonical('A', '2026-01-01', true)],
};

const scenario = {
  id: 'test-scenario',
  version: 'v1',
  source: 'outlook',
} as unknown as ScenarioManifest;

function makeCtx(overrides: Partial<CeremonyOptions> = {}): CeremonyContext {
  const options: CeremonyOptions = {
    live: false,
    skipSeed: false,
    skipDriver: false,
    skipExport: false,
    withUpdate: false,
    dryRun: false,
    ...overrides,
  };
  return {
    scenario,
    scenarioPath: '/tmp/test-scenario.json',
    repoRoot: REPO_ROOT,
    logger: silentLogger,
    options,
  };
}

describe('runCeremony — wiring smoke (all stub)', () => {
  it('reports WIRING-OK: passed but stubbed', async () => {
    const report = await runCeremony(makeCtx(), buildComponents('outlook'), expected);
    expect(report.passed).toBe(true);
    expect(report.stubbed).toBe(true);
    expect(report.deviations).toHaveLength(0);
    // All five stages present.
    expect(report.stages.map((s) => s.stage)).toEqual([
      'wipe',
      'seed',
      'drive',
      'assert-db',
      'assert-export',
    ]);
    expect(report.stages.find((s) => s.stage === 'assert-db')?.status).toBe('stub');
  });
});

describe('runCeremony — injected exact-count mismatch', () => {
  it('fails and surfaces per-cell deviations when the DB set differs', async () => {
    // A fake asserter that "measures" the wrong set (missing B, so filterOff=1).
    const wrongAsserter: DbSetDiffAsserter = {
      name: 'wrong-db-asserter',
      async assert(): Promise<SetDiffResult> {
        return {
          stage: 'assert-db',
          status: 'pass', // claims pass; the runner is the authority and overrides
          durationMs: 1,
          actual: {
            corpus: 2,
            filterOff: [{ subject: 'A', shiftedDate: '2026-01-01' }],
            filterOn: [{ subject: 'A', shiftedDate: '2026-01-01' }],
            ghosts: [],
          },
        };
      },
    };
    const components: CeremonyComponents = {
      seeder: createStubSeeder('outlook'),
      driver: stubDriver,
      dbAsserter: wrongAsserter,
      exportAsserter: stubExportAsserter,
      updateRunner: stubUpdateRunner,
    };

    const report = await runCeremony(makeCtx(), components, expected);
    expect(report.passed).toBe(false);
    const dbStage = report.stages.find((s) => s.stage === 'assert-db');
    expect(dbStage?.status).toBe('fail');
    const cells = report.deviations.map((d) => d.cell);
    expect(cells).toEqual(expect.arrayContaining(['filterOff', 'missing']));
    const filterOff = report.deviations.find((d) => d.cell === 'filterOff');
    expect(filterOff).toMatchObject({ expected: 2, got: 1 });
    expect(filterOff?.missingMembers?.map((m) => m.subject)).toEqual(['B']);
  });
});

describe('runCeremony — skip flags', () => {
  it('marks seed/driver/export skipped without running them', async () => {
    const report = await runCeremony(
      makeCtx({ skipSeed: true, skipDriver: true, skipExport: true }),
      buildComponents('outlook'),
      expected,
    );
    const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s.status]));
    expect(byStage.wipe).toBe('skipped');
    expect(byStage.seed).toBe('skipped');
    expect(byStage.drive).toBe('skipped');
    expect(byStage['assert-export']).toBe('skipped');
  });
});

describe('runCeremony — GATED seeder short-circuits the run (non-fail)', () => {
  // A seeder that GATES (no live tenant, e.g. the Gmail cell / BACKLOG-1845).
  const gatedSeeder: SeederComponent = {
    name: 'gated-seeder',
    source: 'gmail',
    async wipe(): Promise<StageResult> {
      return { stage: 'wipe', status: 'gated', durationMs: 0, detail: 'GATED: no tenant (1845)' };
    },
    async seed(): Promise<StageResult> {
      return { stage: 'seed', status: 'gated', durationMs: 0, detail: 'GATED: no tenant (1845)' };
    },
  };
  // An asserter that MUST NOT be invoked once the seeder has gated.
  const explodingAsserter: DbSetDiffAsserter = {
    name: 'exploding-asserter',
    async assert(): Promise<SetDiffResult> {
      throw new Error('assert-db must not run when the seeder gated the ceremony');
    },
  };
  const components: CeremonyComponents = {
    seeder: gatedSeeder,
    driver: stubDriver,
    dbAsserter: explodingAsserter,
    exportAsserter: stubExportAsserter,
    updateRunner: stubUpdateRunner,
  };

  it('reports GATED: passed (non-fail), not stubbed, downstream stages gated', async () => {
    const report = await runCeremony(makeCtx(), components, expected);

    expect(report.gated).toBe(true);
    expect(report.passed).toBe(true); // gated is NEVER a failure
    expect(report.stubbed).toBe(false); // assert-db is gated, not stub
    expect(report.deviations).toHaveLength(0);

    const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s.status]));
    expect(byStage.wipe).toBe('gated');
    expect(byStage.seed).toBe('gated');
    // Short-circuit: drive + assert-db + assert-export all gated (asserter never ran).
    expect(byStage.drive).toBe('gated');
    expect(byStage['assert-db']).toBe('gated');
    expect(byStage['assert-export']).toBe('gated');
    expect(report.stages.map((s) => s.stage)).toEqual([
      'wipe',
      'seed',
      'drive',
      'assert-db',
      'assert-export',
    ]);
  });

  it('a gated run is not dragged to FAIL even with --with-update', async () => {
    const report = await runCeremony(makeCtx({ withUpdate: true }), components, expected);
    expect(report.gated).toBe(true);
    expect(report.passed).toBe(true);
    const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s.status]));
    expect(byStage['update-migrate']).toBe('gated');
    expect(byStage['re-assert-db']).toBe('gated');
  });
});
