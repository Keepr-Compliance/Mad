import { resolve } from 'path';
import { runCeremony } from '../runner';
import { buildComponents } from '../components/registry';
import {
  stubDriver,
  stubDbAsserter,
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
  ExportAssertResult,
  ExportManifestAsserter,
  Logger,
  ScenarioManifest,
  SetDiffResult,
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

describe('runCeremony — export stage (H5 / BACKLOG-1852)', () => {
  const matchingExport = [
    { subject: 'A', shiftedDate: '2026-01-01' },
    { subject: 'B', shiftedDate: '2026-01-02' },
  ];

  function componentsWithExport(exportAsserter: ExportManifestAsserter): CeremonyComponents {
    return {
      seeder: createStubSeeder('outlook'),
      driver: stubDriver,
      dbAsserter: stubDbAsserter,
      exportAsserter,
      updateRunner: stubUpdateRunner,
    };
  }

  it('passes when the exported set matches and there are no structural deviations', async () => {
    const asserter: ExportManifestAsserter = {
      name: 'fake-export',
      async assert(): Promise<ExportAssertResult> {
        return { stage: 'assert-export', status: 'pass', durationMs: 1, deviations: [], exportedEmails: matchingExport };
      },
    };
    const report = await runCeremony(makeCtx(), componentsWithExport(asserter), expected);
    const stage = report.stages.find((s) => s.stage === 'assert-export');
    expect(stage?.status).toBe('pass');
    expect(stage?.deviations).toBeUndefined();
  });

  it('PRESERVES the asserter structural deviations (manifest) even when the email set matches', async () => {
    const asserter: ExportManifestAsserter = {
      name: 'fake-export',
      async assert(): Promise<ExportAssertResult> {
        return {
          stage: 'assert-export',
          status: 'fail',
          durationMs: 1,
          deviations: [{ cell: 'attachmentCount', expected: 3, got: 2 }],
          exportedEmails: matchingExport,
        };
      },
    };
    const report = await runCeremony(makeCtx(), componentsWithExport(asserter), expected);
    expect(report.passed).toBe(false);
    const stage = report.stages.find((s) => s.stage === 'assert-export');
    expect(stage?.status).toBe('fail');
    expect(stage?.deviations?.map((d) => d.cell)).toContain('attachmentCount');
  });

  it('runs the email-set gate only when a lossless set was measured (empty = skipped, structural still applies)', async () => {
    const asserter: ExportManifestAsserter = {
      name: 'fake-export',
      async assert(): Promise<ExportAssertResult> {
        // folderExport-PDF-only deliverable: no lossless set, only a manifest finding.
        return {
          stage: 'assert-export',
          status: 'fail',
          durationMs: 1,
          deviations: [{ cell: 'manifest.transactionId', expected: 1, got: 0 }],
          exportedEmails: [],
        };
      },
    };
    const report = await runCeremony(makeCtx(), componentsWithExport(asserter), expected);
    const stage = report.stages.find((s) => s.stage === 'assert-export');
    expect(stage?.status).toBe('fail');
    const cells = stage?.deviations?.map((d) => d.cell) ?? [];
    expect(cells).toContain('manifest.transactionId');
    // Email-set gate skipped (no exportedEmails=0 -> 2 false "missing").
    expect(cells).not.toContain('exportedEmails');
  });

  it('never upgrades an asserter hard failure (no deviation) to pass', async () => {
    const asserter: ExportManifestAsserter = {
      name: 'fake-export',
      async assert(): Promise<ExportAssertResult> {
        // Operational failure (e.g. export dir not found): fail, empty deviations.
        return {
          stage: 'assert-export',
          status: 'fail',
          durationMs: 1,
          detail: 'Export directory not found: /no/such/dir',
          deviations: [],
          exportedEmails: [],
        };
      },
    };
    const report = await runCeremony(makeCtx(), componentsWithExport(asserter), expected);
    const stage = report.stages.find((s) => s.stage === 'assert-export');
    expect(stage?.status).toBe('fail');
    expect(report.passed).toBe(false);
  });

  it('fails with a membership finding when the exported set diverges', async () => {
    const asserter: ExportManifestAsserter = {
      name: 'fake-export',
      async assert(): Promise<ExportAssertResult> {
        return {
          stage: 'assert-export',
          status: 'pass',
          durationMs: 1,
          deviations: [],
          exportedEmails: [{ subject: 'A', shiftedDate: '2026-01-01' }], // missing B
        };
      },
    };
    const report = await runCeremony(makeCtx(), componentsWithExport(asserter), expected);
    const stage = report.stages.find((s) => s.stage === 'assert-export');
    expect(stage?.status).toBe('fail');
    const dev = stage?.deviations?.find((d) => d.cell === 'exportedEmails');
    expect(dev).toMatchObject({ expected: 2, got: 1 });
    expect(dev?.missingMembers?.map((m) => m.subject)).toEqual(['B']);
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
