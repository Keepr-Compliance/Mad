/**
 * QA Harness — DbSetDiffAsserter adapter (BACKLOG-1850 / QA-H3).
 *
 * Implements the `DbSetDiffAsserter` contract published by H1 (BACKLOG-1848) so
 * the ceremony runner can plug in the encrypted-DB set-diff stage.
 *
 * ── H1 ALIGNMENT (READ ME) ────────────────────────────────────────────────
 * At authoring time H1's `scripts/qa/harness/types.ts` was NOT yet merged into
 * the integration branch (parallel Wave-1). To keep this file self-contained
 * AND avoid a `types.ts` filename collision with H1's PR, the interface shapes
 * below are declared INLINE and mirror H1's published types.ts exactly.
 * WHEN H1 MERGES: delete the "Inline H1 contract mirror" block and replace it
 * with `import type { ... } from './types';` — the structural shapes are
 * identical, so no other change is required.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The real work happens in an Electron-MAIN child process
 * (scripts/qa/harness/db-assert.js) because:
 *   - the DB key is only reachable via Electron `safeStorage` (macOS Keychain),
 *   - `better-sqlite3-multiple-ciphers` is built against Electron's ABI.
 * This TS module (imported by the runner under bare ts-node) therefore spawns
 * that child in `--json` mode and marshals its stdout into a `SetDiffResult`.
 *
 * In non-live / dry-run mode it returns a `stub` StageResult so `qa:ceremony`
 * stays a safe wiring smoke test that touches no keychain, DB, or app.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ── Inline H1 contract mirror (see H1 ALIGNMENT above) ─────────────────────
export interface EmailSetMember {
  subject: string;
  shiftedDate: string;
}
export interface ExpectedCounts {
  corpus: number;
  filterOff: number;
  filterOn: number;
  missing: number;
  extra: number;
  ghosts: number;
}
export interface ExpectedSets {
  counts: ExpectedCounts;
  filterOff: unknown[];
  filterOn: unknown[];
}
export interface CountDeviation {
  cell: string;
  expected: number;
  got: number;
  missingMembers?: EmailSetMember[];
  extraMembers?: EmailSetMember[];
}
export type StageName =
  | 'wipe'
  | 'seed'
  | 'drive'
  | 'assert-db'
  | 'assert-export'
  | 'update-migrate'
  | 're-assert-db';
export type StageStatus = 'pass' | 'fail' | 'skipped' | 'stub';
export interface StageResult {
  stage: StageName;
  status: StageStatus;
  durationMs: number;
  detail?: string;
  deviations?: CountDeviation[];
}
export interface SetDiffResult extends StageResult {
  actual: {
    corpus: number;
    filterOff: EmailSetMember[];
    filterOn: EmailSetMember[];
    ghosts: EmailSetMember[];
  };
}
// Minimal subset of H1's CeremonyOptions/CeremonyContext — only the fields this
// asserter reads. Declared WITHOUT an index signature so H1's richer types stay
// assignable to these (contravariant `assert` parameter).
export interface CeremonyOptions {
  live: boolean;
  dryRun: boolean;
}
export interface CeremonyContext {
  scenarioPath: string;
  repoRoot: string;
  options: CeremonyOptions;
}
export interface DbSetDiffAsserter {
  readonly name: string;
  assert(ctx: CeremonyContext, expected: ExpectedSets): Promise<SetDiffResult>;
}
// ── end inline contract mirror ─────────────────────────────────────────────

const STAGE = 'assert-db' as const;

/** Locate the Electron binary the app was built with. */
function resolveElectronBin(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, 'node_modules', '.bin', 'electron'),
    path.join(repoRoot, 'node_modules', '.bin', 'electron.cmd'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Extract the last stdout line that parses as JSON (Electron logs noise too). */
function extractJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      /* keep scanning upward */
    }
  }
  return null;
}

function emptyActual(): SetDiffResult['actual'] {
  return { corpus: 0, filterOff: [], filterOn: [], ghosts: [] };
}

export function createDbSetDiffAsserter(): DbSetDiffAsserter {
  return {
    name: 'db-set-diff-asserter',

    async assert(ctx: CeremonyContext, expected: ExpectedSets): Promise<SetDiffResult> {
      const started = Date.now();

      // Non-live: this stage has real side effects (keychain read + DB open),
      // so it only runs for real when `live` is set. Otherwise stub out.
      if (!ctx.options.live || ctx.options.dryRun) {
        return {
          stage: STAGE,
          status: 'stub',
          durationMs: Date.now() - started,
          detail:
            `stub — expected ${expected.counts.filterOff} OFF / ${expected.counts.filterOn} ON ` +
            '(run with --live to open the encrypted DB)',
          deviations: [],
          actual: emptyActual(),
        };
      }

      const electronBin = resolveElectronBin(ctx.repoRoot);
      const script = path.join(ctx.repoRoot, 'scripts', 'qa', 'harness', 'db-assert.js');
      if (!electronBin) {
        return {
          stage: STAGE,
          status: 'fail',
          durationMs: Date.now() - started,
          detail: 'Electron binary not found under node_modules/.bin — cannot open the app DB.',
          deviations: [],
          actual: emptyActual(),
        };
      }

      const args = [script, '--scenario', ctx.scenarioPath, '--json'];
      const run = spawnSync(electronBin, args, {
        cwd: ctx.repoRoot,
        encoding: 'utf8',
        // The child inherits env, so $KEEPR_QA_DB_KEY / $KEEPR_QA_DB set by the
        // runner (CI / fixtures) flow through automatically.
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
      });

      const durationMs = Date.now() - started;

      if (run.error) {
        return {
          stage: STAGE,
          status: 'fail',
          durationMs,
          detail: `Failed to launch db-assert: ${run.error.message}`,
          deviations: [],
          actual: emptyActual(),
        };
      }

      const parsed = extractJsonLine(run.stdout || '');
      if (!parsed || parsed.stage !== STAGE) {
        const stderrTail = (run.stderr || '').split(/\r?\n/).slice(-5).join('\n');
        return {
          stage: STAGE,
          status: 'fail',
          durationMs,
          detail:
            `db-assert produced no parseable SetDiffResult (exit ${run.status ?? 'null'}). ` +
            `stderr: ${stderrTail}`,
          deviations: [],
          actual: emptyActual(),
        };
      }

      // Trust the child's verdict; stamp our own duration and guarantee shape.
      const actual = (parsed.actual as SetDiffResult['actual']) ?? emptyActual();
      return {
        stage: STAGE,
        status: parsed.status === 'pass' ? 'pass' : 'fail',
        durationMs,
        detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
        deviations: (parsed.deviations as CountDeviation[]) ?? [],
        actual: {
          corpus: actual.corpus ?? 0,
          filterOff: actual.filterOff ?? [],
          filterOn: actual.filterOn ?? [],
          ghosts: actual.ghosts ?? [],
        },
      };
    },
  };
}

export default createDbSetDiffAsserter;
