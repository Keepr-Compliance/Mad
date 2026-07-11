/**
 * QA Harness — ExportManifestAsserter adapter tests (BACKLOG-1852 / QA-H5).
 *
 * Covers the live-gating contract (stub unless --live), the KEEPR_QA_EXPORT_DIR
 * requirement, source-timezone resolution, and a real fixture read under --live.
 */
import * as path from 'path';
import {
  createExportManifestAsserter,
  readSourceTimezone,
} from '../export-manifest-asserter';
import type {
  CeremonyContext,
  CeremonyOptions,
  ExpectedSets,
  Logger,
  ScenarioManifest,
} from '../types';

const FIX = path.join(__dirname, 'fixtures');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCENARIO_PATH = path.join(REPO_ROOT, 'docs', 'qa', 'scenarios', 'tx1-birchwood.json');

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const expected: ExpectedSets = {
  counts: { corpus: 190, filterOff: 69, filterOn: 37, missing: 0, extra: 0, ghosts: 0 },
  filterOff: [],
  filterOn: [],
};

function makeCtx(overrides: Partial<CeremonyOptions> = {}, scenarioPath = SCENARIO_PATH): CeremonyContext {
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
    scenario: { id: 'tx1-birchwood', version: 'v2.20.0', source: 'outlook' } as unknown as ScenarioManifest,
    scenarioPath,
    repoRoot: REPO_ROOT,
    logger: silentLogger,
    options,
  };
}

describe('readSourceTimezone', () => {
  it('reads sourceTimezone from the raw scenario JSON', () => {
    expect(readSourceTimezone(SCENARIO_PATH)).toBe('America/Los_Angeles');
  });

  it('falls back to the Pacific default for a missing/invalid file', () => {
    expect(readSourceTimezone('/no/such/scenario.json')).toBe('America/Los_Angeles');
  });
});

describe('createExportManifestAsserter — live gating', () => {
  const asserter = createExportManifestAsserter();

  it('returns a stub (never pass) when not --live', async () => {
    const r = await asserter.assert(makeCtx({ live: false }), expected);
    expect(r.status).toBe('stub');
    expect(r.exportedEmails).toEqual([]);
  });

  it('returns a stub under --dry-run even with --live', async () => {
    const r = await asserter.assert(makeCtx({ live: true, dryRun: true }), expected);
    expect(r.status).toBe('stub');
  });

  it('fails fast with an actionable hint when --live but no KEEPR_QA_EXPORT_DIR', async () => {
    const prev = process.env.KEEPR_QA_EXPORT_DIR;
    delete process.env.KEEPR_QA_EXPORT_DIR;
    try {
      const r = await asserter.assert(makeCtx({ live: true }), expected);
      expect(r.status).toBe('fail');
      expect(r.detail).toMatch(/KEEPR_QA_EXPORT_DIR/);
    } finally {
      if (prev !== undefined) process.env.KEEPR_QA_EXPORT_DIR = prev;
    }
  });

  it('fails when the export directory does not exist', async () => {
    const prev = process.env.KEEPR_QA_EXPORT_DIR;
    process.env.KEEPR_QA_EXPORT_DIR = '/no/such/export/dir';
    try {
      const r = await asserter.assert(makeCtx({ live: true }), expected);
      expect(r.status).toBe('fail');
      expect(r.detail).toMatch(/not found/);
    } finally {
      if (prev !== undefined) process.env.KEEPR_QA_EXPORT_DIR = prev;
      else delete process.env.KEEPR_QA_EXPORT_DIR;
    }
  });

  it('reads a real EML fixture deliverable under --live and measures the email set', async () => {
    const prev = process.env.KEEPR_QA_EXPORT_DIR;
    process.env.KEEPR_QA_EXPORT_DIR = path.join(FIX, 'eml-export-tx1');
    try {
      const r = await asserter.assert(makeCtx({ live: true }), expected);
      // No manifest in a txt_eml deliverable, but the email set is measured.
      expect(r.exportedEmails).toHaveLength(5);
      expect(r.detail).toMatch(/tz=America\/Los_Angeles/);
      expect(r.status).toBe('pass'); // no structural deviations (asserter's advisory status)
    } finally {
      if (prev !== undefined) process.env.KEEPR_QA_EXPORT_DIR = prev;
      else delete process.env.KEEPR_QA_EXPORT_DIR;
    }
  });
});
