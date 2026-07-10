/**
 * Gmail (Google Workspace) seeder for the QA harness (BACKLOG-1851 / QA-H4).
 *
 * A concrete `SeederComponent` (source `gmail`) that wraps the net-new
 * `scripts/qa/email/seed-gmail.py` (Gmail API `users.messages.insert`,
 * date-shifted via a Date-header rewrite + `internalDateSource=dateHeader`,
 * native In-Reply-To/References threading, INBOX/SENT label routing).
 *
 * GATING (founder decision 2026-07-07): the Gmail cell is GATED on the Google
 * Workspace tenant (BACKLOG-1845). Until that tenant + its OAuth token exist,
 * this component reports status `gated` — a reasoned skip-with-reason that is
 * NEVER a failure and keeps the overall ceremony verdict green. It converges on
 * the SAME `ParsedEmail` shape the app's `gmailFetchService` produces, so once
 * the tenant lands the cell activates unchanged.
 *
 * SAFETY: only touches a live mailbox when `options.live` is set AND
 * `options.dryRun` is not. Otherwise it prints the exact command it would run
 * and reports `stub`, so the default `qa:ceremony` is side-effect free.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import type { CeremonyContext, SeederComponent, StageResult } from '../types';
import { expandPath } from '../manifest';

/** Apple system Python — has SSL bundled (see seed-gmail.py header). */
const PYTHON_BIN = '/usr/bin/python3';
const SEED_SCRIPT = 'scripts/qa/email/seed-gmail.py';

interface Prereqs {
  /** True when the environment is fully provisioned to run a live seed. */
  ok: boolean;
  /**
   * True when the ONLY thing missing is the Google Workspace tenant / its OAuth
   * token — i.e. the cell is GATED (BACKLOG-1845), not misconfigured. When set,
   * `problems` describes the gating reason.
   */
  gated: boolean;
  problems: string[];
  corpusDir?: string;
  tokenFile?: string;
  scriptPath: string;
}

function checkPrereqs(ctx: CeremonyContext): Prereqs {
  const hardProblems: string[] = [];
  const scriptPath = `${ctx.repoRoot}/${SEED_SCRIPT}`;
  if (!existsSync(scriptPath)) hardProblems.push(`seeder script missing: ${scriptPath}`);
  if (!existsSync(PYTHON_BIN)) {
    hardProblems.push(`python interpreter missing: ${PYTHON_BIN}`);
  }

  const seed = ctx.scenario.seed ?? {};
  const corpusDir = seed.corpusDir ? expandPath(seed.corpusDir) : undefined;
  if (!corpusDir) {
    hardProblems.push('scenario.seed.corpusDir is required for live seeding');
  } else if (!existsSync(corpusDir)) {
    hardProblems.push(`corpus dir not found: ${corpusDir}`);
  }

  // The token is the GATING signal (BACKLOG-1845): no tenant → no token → gated.
  // Distinguish this from hard config errors (missing script/python/corpus),
  // which are genuine failures the operator must fix.
  const tokenFile = seed.tokenFile ? expandPath(seed.tokenFile) : undefined;
  const tokenPresent = !!tokenFile && existsSync(tokenFile);
  const gated = !tokenPresent;
  const gatingReason = !tokenFile
    ? 'no Gmail OAuth token configured (scenario.seed.tokenFile) — Google Workspace tenant absent (BACKLOG-1845)'
    : `Gmail OAuth token not found at ${tokenFile} — Google Workspace tenant absent (BACKLOG-1845)`;

  return {
    ok: hardProblems.length === 0 && tokenPresent,
    gated,
    problems: hardProblems.length ? hardProblems : gated ? [gatingReason] : [],
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
    ctx.logger.info(`[gmail-seeder] would run: ${cmd}`);
    return {
      stage,
      status: 'stub',
      durationMs: Date.now() - started,
      detail: `dry (not --live): ${cmd}`,
    };
  }

  // GATED: the Google Workspace tenant / token is absent (BACKLOG-1845). This is
  // a reasoned skip-with-reason, NOT a failure — the run stays green.
  if (pre.gated) {
    const reason = pre.problems.join('; ');
    ctx.logger.warn(`[gmail-seeder] GATED — ${reason}`);
    return {
      stage,
      status: 'gated',
      durationMs: Date.now() - started,
      detail: `GATED: ${reason}`,
    };
  }

  if (!pre.ok) {
    ctx.logger.error(`[gmail-seeder] prerequisites missing:`);
    pre.problems.forEach((p) => ctx.logger.error(`  - ${p}`));
    return {
      stage,
      status: 'fail',
      durationMs: Date.now() - started,
      detail: `prerequisites missing: ${pre.problems.join('; ')}`,
    };
  }

  ctx.logger.info(`[gmail-seeder] running: ${cmd}`);
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
    ctx.logger.error(`[gmail-seeder] exit ${proc.status}\n${proc.stderr || ''}`);
    return {
      stage,
      status: 'fail',
      durationMs,
      detail: `seeder exit ${proc.status}${tail ? ` — ${tail}` : ''}`,
    };
  }
  ctx.logger.info(`[gmail-seeder] ${mode} ok\n${tail}`);
  return {
    stage,
    status: 'pass',
    durationMs,
    detail: `${mode} ok`,
  };
}

export const gmailSeeder: SeederComponent = {
  name: 'gmail-workspace-seeder',
  source: 'gmail',
  async wipe(ctx: CeremonyContext): Promise<StageResult> {
    return runSeeder(ctx, 'wipe', 'wipe');
  },
  async seed(ctx: CeremonyContext): Promise<StageResult> {
    return runSeeder(ctx, 'seed', 'seed');
  },
};
