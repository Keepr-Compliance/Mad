/**
 * Stub components for the QA harness (BACKLOG-1848).
 *
 * Each stub satisfies a published interface but performs no real work. They let
 * `qa:ceremony` wire all five stages end-to-end before the sibling tasks merge:
 *   - AppDriverComponent    -> H2 (BACKLOG-1849)
 *   - DbSetDiffAsserter     -> H3 (BACKLOG-1850)
 *   - SeederComponent       -> H4 (BACKLOG-1851)  [outlook has a real impl too]
 *   - ExportManifestAsserter-> H5 (BACKLOG-1852)
 *   - UpdateMigrateRunner   -> F  (later)
 *
 * A stub always reports status `stub` — never `pass` — so a stubbed ceremony is
 * never mistaken for a certified deterministic run.
 */
import type {
  AppDriverComponent,
  CeremonyContext,
  DbSetDiffAsserter,
  EmailSource,
  ExpectedSets,
  ExportAssertResult,
  ExportManifestAsserter,
  SeederComponent,
  SetDiffResult,
  StageResult,
  UpdateMigrateRunner,
} from '../types';

function stubStage(
  stage: StageResult['stage'],
  owner: string,
  detail: string,
): StageResult {
  return {
    stage,
    status: 'stub',
    durationMs: 0,
    detail: `[stub -> ${owner}] ${detail}`,
  };
}

export function createStubSeeder(source: EmailSource = 'outlook'): SeederComponent {
  return {
    name: `stub-seeder(${source})`,
    source,
    async wipe(ctx: CeremonyContext): Promise<StageResult> {
      ctx.logger.warn(`Seeder wipe is stubbed — awaiting H4 (BACKLOG-1851).`);
      return stubStage('wipe', 'BACKLOG-1851', 'no mailbox wipe performed');
    },
    async seed(ctx: CeremonyContext): Promise<StageResult> {
      ctx.logger.warn(`Seeder seed is stubbed — awaiting H4 (BACKLOG-1851).`);
      return stubStage('seed', 'BACKLOG-1851', 'no corpus seeded');
    },
  };
}

export const stubDriver: AppDriverComponent = {
  name: 'stub-driver',
  async drive(ctx: CeremonyContext): Promise<StageResult> {
    ctx.logger.warn(`App driver is stubbed — awaiting H2 (BACKLOG-1849).`);
    return stubStage('drive', 'BACKLOG-1849', 'app not booted/driven');
  },
};

export const stubDbAsserter: DbSetDiffAsserter = {
  name: 'stub-db-asserter',
  async assert(
    ctx: CeremonyContext,
    _expected: ExpectedSets,
  ): Promise<SetDiffResult> {
    ctx.logger.warn(`DB set-diff asserter is stubbed — awaiting H3 (BACKLOG-1850).`);
    return {
      ...stubStage('assert-db', 'BACKLOG-1850', 'no DB set-diff performed'),
      actual: { corpus: 0, filterOff: [], filterOn: [], ghosts: [] },
    };
  },
};

export const stubExportAsserter: ExportManifestAsserter = {
  name: 'stub-export-asserter',
  async assert(
    ctx: CeremonyContext,
    _expected: ExpectedSets,
  ): Promise<ExportAssertResult> {
    ctx.logger.warn(
      `Export-manifest asserter is stubbed — awaiting H5 (BACKLOG-1852).`,
    );
    return {
      ...stubStage('assert-export', 'BACKLOG-1852', 'no export deliverable diffed'),
      exportedEmails: [],
    };
  },
};

export const stubUpdateRunner: UpdateMigrateRunner = {
  name: 'stub-update-runner',
  async run(ctx: CeremonyContext): Promise<StageResult> {
    ctx.logger.warn(`Update-migrate runner is stubbed — awaiting Phase 3 (F).`);
    return stubStage('update-migrate', 'QA-F', 'no update/migrate performed');
  },
};
