/**
 * Ceremony orchestrator for the QA harness (BACKLOG-1848).
 *
 * Sequences the deterministic ceremony:
 *   wipe -> seed -> drive -> assert-db -> assert-export -> (update-migrate -> re-assert-db)
 *
 * The runner is the single authority on the verdict: asserters MEASURE (return
 * `actual` sets), the runner JUDGES via `evaluateSetDiff` / `diffMembers` so the
 * exact-count logic lives in exactly one place (diff.ts). Any exact-count
 * mismatch produces a `CountDeviation` and fails the ceremony.
 */
import type {
  CeremonyComponents,
  CeremonyContext,
  CeremonyReport,
  CountDeviation,
  EmailSetMember,
  ExpectedSets,
  StageResult,
} from './types';
import { diffMembers, evaluateSetDiff } from './diff';

/** Judge a DB/re-assert stage from its measured `actual` sets. */
function judgeSetDiffStage(
  stage: StageResult & { actual?: unknown },
  measured: {
    corpus: number;
    filterOff: ExpectedSets['filterOff'];
    filterOn: ExpectedSets['filterOn'];
    ghosts: ExpectedSets['filterOff'];
  } | undefined,
  expected: ExpectedSets,
): StageResult {
  if (
    stage.status === 'stub' ||
    stage.status === 'skipped' ||
    stage.status === 'gated' ||
    !measured
  ) {
    // stub/skipped/gated stages never MEASURED a set — passthrough as-is so an
    // empty `actual` is never judged as a deviation (a gated cell must stay
    // non-fail; BACKLOG-1851).
    return stage;
  }
  const deviations = evaluateSetDiff(expected, measured);
  return {
    stage: stage.stage,
    status: deviations.length === 0 ? 'pass' : 'fail',
    durationMs: stage.durationMs,
    detail: stage.detail,
    deviations: deviations.length ? deviations : undefined,
  };
}

/**
 * Judge the export stage. The H5 asserter (BACKLOG-1852) MEASURES: it returns
 * `exportedEmails` (the lossless emitted set) plus its own manifest/structure
 * `deviations`. This function:
 *   1. PRESERVES the asserter's structural deviations (manifest.json,
 *      attachmentCount, deliverable shape) — the runner cannot recompute these,
 *      so they must survive, and
 *   2. runs the exact email-set gate — exported set must equal the expected
 *      filter-OFF set (H1's shared MULTISET diff) — ONLY when a lossless set was
 *      measured (non-empty). A folderExport-PDF-only deliverable yields no
 *      lossless set, so its email-set gate is skipped and only the structural
 *      gate applies (the emitted `emails/` PDFs are filename-lossy; see
 *      export-manifest-core.ts).
 */
function judgeExportStage(
  stage: StageResult & { exportedEmails?: EmailSetMember[] },
  expected: ExpectedSets,
): StageResult {
  if (
    stage.status === 'stub' ||
    stage.status === 'skipped' ||
    stage.status === 'gated'
  ) {
    // gated joins stub/skipped: a gated cell never MEASURED an export set, so it
    // passes through untouched (never a deviation; BACKLOG-1851). The empty/
    // lossy-set case is handled inline below via `if (exported && exported.length > 0)`.
    return stage;
  }

  // Start from the asserter's structural findings so they are not dropped.
  const deviations: CountDeviation[] = [...(stage.deviations ?? [])];

  const exported = stage.exportedEmails;
  if (exported && exported.length > 0) {
    const { missing, extra } = diffMembers(expected.filterOff, exported);
    if (exported.length !== expected.counts.filterOff) {
      deviations.push({
        cell: 'exportedEmails',
        expected: expected.counts.filterOff,
        got: exported.length,
        missingMembers: missing,
        extraMembers: extra,
      });
    } else if (missing.length || extra.length) {
      // Count matches but membership differs — still a finding.
      deviations.push({
        cell: 'exportedEmails(membership)',
        expected: expected.counts.filterOff,
        got: exported.length,
        missingMembers: missing,
        extraMembers: extra,
      });
    }
  }

  // The runner is the authority on email-set membership (it may DOWNGRADE a
  // pass to fail), but it must never UPGRADE the asserter's own hard failure —
  // an operational error (missing/unreadable deliverable) reports `fail` with no
  // deviation, and that verdict is preserved.
  const failed = deviations.length > 0 || stage.status === 'fail';
  return {
    stage: stage.stage,
    status: failed ? 'fail' : 'pass',
    durationMs: stage.durationMs,
    detail: stage.detail,
    deviations: deviations.length ? deviations : undefined,
  };
}

/** A downstream stage short-circuited because the seeder gated the whole run. */
function gatedStage(stage: StageResult['stage'], detail: string): StageResult {
  return { stage, status: 'gated', durationMs: 0, detail };
}

async function safeStage(
  stage: StageResult['stage'],
  fn: () => Promise<StageResult>,
): Promise<StageResult> {
  const started = Date.now();
  try {
    return await fn();
  } catch (err) {
    return {
      stage,
      status: 'fail',
      durationMs: Date.now() - started,
      detail: `threw: ${(err as Error).message}`,
    };
  }
}

export async function runCeremony(
  ctx: CeremonyContext,
  components: CeremonyComponents,
  expected: ExpectedSets,
): Promise<CeremonyReport> {
  const { logger, options } = ctx;
  const startedAt = new Date();
  const stages: StageResult[] = [];

  const record = (r: StageResult): void => {
    const badge =
      r.status === 'pass'
        ? 'PASS'
        : r.status === 'fail'
          ? 'FAIL'
          : r.status.toUpperCase();
    logger.info(`[${badge}] ${r.stage}${r.detail ? ` — ${r.detail}` : ''}`);
    stages.push(r);
  };

  // 1 + 2. wipe + seed
  if (options.skipSeed) {
    record({ stage: 'wipe', status: 'skipped', durationMs: 0, detail: '--skip-seed' });
    record({ stage: 'seed', status: 'skipped', durationMs: 0, detail: '--skip-seed' });
  } else {
    record(await safeStage('wipe', () => components.seeder.wipe(ctx)));
    record(await safeStage('seed', () => components.seeder.seed(ctx)));
  }

  // If the seeder GATED (a required live resource — e.g. the Google Workspace
  // tenant, BACKLOG-1845 — is absent), there is nothing to ingest or assert.
  // Short-circuit every downstream stage to `gated` so the run reports a
  // reasoned skip-with-reason instead of an avalanche of empty-DB deviations.
  // A gated seed is NEVER a failure (founder decision 2026-07-07, BACKLOG-1851).
  const seederGated = stages.some(
    (s) => (s.stage === 'wipe' || s.stage === 'seed') && s.status === 'gated',
  );
  const gatedReason = seederGated
    ? `gated by seeder — ${
        stages.find((s) => s.status === 'gated')?.detail ?? 'live resource absent'
      }`
    : '';

  // 3. drive
  if (seederGated) {
    record(gatedStage('drive', gatedReason));
  } else if (options.skipDriver) {
    record({ stage: 'drive', status: 'skipped', durationMs: 0, detail: '--skip-driver' });
  } else {
    record(await safeStage('drive', () => components.driver.drive(ctx)));
  }

  // 4. assert DB set-diff (judged by the runner from measured sets)
  if (seederGated) {
    record(gatedStage('assert-db', gatedReason));
  } else {
    const dbResult = await safeStage('assert-db', async () =>
      components.dbAsserter.assert(ctx, expected),
    );
    record(
      judgeSetDiffStage(
        dbResult,
        'actual' in dbResult ? (dbResult as { actual: any }).actual : undefined,
        expected,
      ),
    );
  }

  // 5. assert export deliverable
  if (seederGated) {
    record(gatedStage('assert-export', gatedReason));
  } else if (options.skipExport) {
    record({
      stage: 'assert-export',
      status: 'skipped',
      durationMs: 0,
      detail: '--skip-export',
    });
  } else {
    const exportResult = await safeStage('assert-export', async () =>
      components.exportAsserter.assert(ctx, expected),
    );
    record(judgeExportStage(exportResult as any, expected));
  }

  // 6. optional update-migrate + re-assert
  if (options.withUpdate) {
    if (seederGated) {
      record(gatedStage('update-migrate', gatedReason));
      record(gatedStage('re-assert-db', gatedReason));
    } else {
      record(await safeStage('update-migrate', () => components.updateRunner.run(ctx)));
      const reAssert = await safeStage('re-assert-db', async () =>
        components.dbAsserter.assert(ctx, expected),
      );
      const judged = judgeSetDiffStage(
        reAssert,
        'actual' in reAssert ? (reAssert as { actual: any }).actual : undefined,
        expected,
      );
      record({ ...judged, stage: 're-assert-db' });
    }
  }

  const endedAt = new Date();
  const deviations = stages.flatMap((s) => s.deviations ?? []);
  const hasFail = stages.some((s) => s.status === 'fail');
  const passed = !hasFail && deviations.length === 0;

  // A ceremony is "stubbed" if any assert-capable stage that was meant to run
  // ran as a stub — the verdict then cannot be a certified deterministic pass.
  const assertStages = new Set(['assert-db', 'assert-export', 're-assert-db']);
  const stubbed = stages.some(
    (s) => assertStages.has(s.stage) && s.status === 'stub',
  );

  // A ceremony is "gated" if any stage reported `gated` (a live resource was
  // absent). Gated is non-fail: the run stays green (exit 0) but is reported
  // distinctly from PASS/WIRING-OK so nobody mistakes it for a certified run.
  const gated = stages.some((s) => s.status === 'gated');

  return {
    scenarioId: ctx.scenario.id,
    passed,
    stubbed,
    gated,
    stages,
    deviations,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
  };
}
