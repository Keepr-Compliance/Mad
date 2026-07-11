/**
 * Outlook (M365) seeder for the QA harness (BACKLOG-1848).
 *
 * A concrete `SeederComponent` that wraps the verified
 * `scripts/qa/email/seed-m365.py` (MAPI-threaded, date-shifted, folder-routed).
 * H4 (BACKLOG-1851) builds the full seed->ingest->link EXACT suite on top of
 * this; H1 ships it as the reference seeder proving the interface.
 *
 * SAFETY: this component only touches the live mailbox when `options.live` is
 * set AND `options.dryRun` is not. Otherwise it prints the exact command it
 * would run and reports `stub`, so the default `qa:ceremony` is side-effect free.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import type { CeremonyContext, SeederComponent, StageResult } from '../types';
import { expandPath } from '../manifest';

/** Apple system Python — has SSL bundled (see seed-m365.py header). */
const PYTHON_BIN = '/usr/bin/python3';
const SEED_SCRIPT = 'scripts/qa/email/seed-m365.py';

interface Prereqs {
  ok: boolean;
  problems: string[];
  corpusDir?: string;
  tokenFile?: string;
  scriptPath: string;
}

function checkPrereqs(ctx: CeremonyContext): Prereqs {
  const problems: string[] = [];
  const scriptPath = `${ctx.repoRoot}/${SEED_SCRIPT}`;
  if (!existsSync(scriptPath)) problems.push(`seeder script missing: ${scriptPath}`);
  if (!existsSync(PYTHON_BIN)) {
    problems.push(`python interpreter missing: ${PYTHON_BIN}`);
  }

  const seed = ctx.scenario.seed ?? {};
  const corpusDir = seed.corpusDir ? expandPath(seed.corpusDir) : undefined;
  if (!corpusDir) {
    problems.push('scenario.seed.corpusDir is required for live seeding');
  } else if (!existsSync(corpusDir)) {
    problems.push(`corpus dir not found: ${corpusDir}`);
  }

  const tokenFile = seed.tokenFile ? expandPath(seed.tokenFile) : undefined;
  if (tokenFile && !existsSync(tokenFile)) {
    problems.push(`token file not found: ${tokenFile}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    corpusDir,
    tokenFile,
    scriptPath,
  };
}

function buildArgs(pre: Prereqs, ctx: CeremonyContext, mode: 'wipe' | 'seed'): string[] {
  const seed = ctx.scenario.seed ?? {};
  const args = [SEED_SCRIPT];
  if (mode === 'wipe') {
    args.push('--wipe-only');
  } else {
    if (pre.corpusDir) args.push('--corpus', pre.corpusDir);
    args.push('--date-shift-months', String(ctx.scenario.dateShiftMonths));
    if (seed.outboundSender) args.push('--outbound-sender', seed.outboundSender);
  }
  if (pre.tokenFile) args.push('--token-file', pre.tokenFile);
  return args;
}

function plannedCommand(pre: Prereqs, ctx: CeremonyContext, mode: 'wipe' | 'seed'): string {
  return `${PYTHON_BIN} ${buildArgs(pre, ctx, mode).join(' ')}`;
}

function runSeeder(
  ctx: CeremonyContext,
  mode: 'wipe' | 'seed',
  stage: StageResult['stage'],
): StageResult {
  const started = Date.now();
  const pre = checkPrereqs(ctx);
  const cmd = plannedCommand(pre, ctx, mode);

  // Non-live or dry-run: never touch the mailbox.
  if (!ctx.options.live || ctx.options.dryRun) {
    ctx.logger.info(`[outlook-seeder] would run: ${cmd}`);
    return {
      stage,
      status: 'stub',
      durationMs: Date.now() - started,
      detail: `dry (not --live): ${cmd}`,
    };
  }

  if (!pre.ok) {
    ctx.logger.error(`[outlook-seeder] prerequisites missing:`);
    pre.problems.forEach((p) => ctx.logger.error(`  - ${p}`));
    return {
      stage,
      status: 'fail',
      durationMs: Date.now() - started,
      detail: `prerequisites missing: ${pre.problems.join('; ')}`,
    };
  }

  ctx.logger.info(`[outlook-seeder] running: ${cmd}`);
  const proc = spawnSync(PYTHON_BIN, buildArgs(pre, ctx, mode), {
    cwd: ctx.repoRoot,
    encoding: 'utf-8',
  });
  const durationMs = Date.now() - started;

  if (proc.error) {
    return {
      stage,
      status: 'fail',
      durationMs,
      detail: `seeder failed to launch: ${proc.error.message}`,
    };
  }
  const tail = (proc.stdout || '').trim().split('\n').slice(-5).join('\n');
  if (proc.status !== 0) {
    ctx.logger.error(`[outlook-seeder] exit ${proc.status}\n${proc.stderr || ''}`);
    return {
      stage,
      status: 'fail',
      durationMs,
      detail: `seeder exit ${proc.status}${tail ? ` — ${tail}` : ''}`,
    };
  }
  ctx.logger.info(`[outlook-seeder] ${mode} ok\n${tail}`);
  return {
    stage,
    status: 'pass',
    durationMs,
    detail: `${mode} ok`,
  };
}

export const outlookSeeder: SeederComponent = {
  name: 'outlook-m365-seeder',
  source: 'outlook',
  async wipe(ctx: CeremonyContext): Promise<StageResult> {
    return runSeeder(ctx, 'wipe', 'wipe');
  },
  async seed(ctx: CeremonyContext): Promise<StageResult> {
    return runSeeder(ctx, 'seed', 'seed');
  },
};
