/**
 * QA Harness — DbSetDiffAsserter adapter (BACKLOG-1850 / QA-H3).
 *
 * Implements H1's `DbSetDiffAsserter` contract (BACKLOG-1848, ./types.ts). It
 * spawns the Electron-MAIN measurement shell (./db-assert.js) — which opens the
 * app's OWN encrypted DB via the app's OWN cipher module + keychain key and
 * MEASURES the filter-OFF / filter-ON / linked sets — then applies H1's SHARED
 * MULTISET diff (./diff.ts) against the scenario's expected sets to produce the
 * exact-count verdict.
 *
 * WHY the split (SR review C1 + A1): the set-identity rule is a MULTISET
 * (distinct emails legitimately share a (subject, shiftedDate) key — canonical
 * rows 20/21). Maintaining a second implementation of that rule drifts; so the
 * diff/evaluation lives ONLY in H1's diff.ts, and this adapter reuses it. The
 * Electron shell contributes ONLY the DB measurement.
 *
 * WHY Electron: the DB key is only reachable via Electron `safeStorage`
 * (macOS Keychain), and `better-sqlite3-multiple-ciphers` is built against
 * Electron's ABI. This adapter runs under bare ts-node (the runner), so it
 * shells out to Electron for the measurement and evaluates in-process.
 *
 * In non-live / dry-run mode it returns a `stub` StageResult so `qa:ceremony`
 * stays a safe wiring smoke test that touches no keychain, DB, or app.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type {
  CeremonyContext,
  CountDeviation,
  DbSetDiffAsserter,
  EmailSetMember,
  ExpectedSets,
  SetDiffResult,
} from './types';
import { evaluateSetDiff, type ActualSets } from './diff';

const STAGE = 'assert-db' as const;

/** A linked-row member as measured by the Electron shell. */
interface LinkedMember extends EmailSetMember {
  linkSource: string | null;
}

/** The raw measurement emitted by db-assert.js --json. */
interface Measurement {
  stage?: string;
  corpus?: number;
  filterOff?: EmailSetMember[];
  filterOn?: EmailSetMember[];
  linked?: LinkedMember[] | null;
  transactionId?: string | null;
  error?: string;
}

function emptyActual(): SetDiffResult['actual'] {
  return { corpus: 0, filterOff: [], filterOn: [], ghosts: [] };
}

/** Locate the Electron binary the app was built with. */
function resolveElectronBin(repoRoot: string): string | null {
  const candidates = [
    path.join(repoRoot, 'node_modules', '.bin', 'electron'),
    path.join(repoRoot, 'node_modules', '.bin', 'electron.cmd'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Extract the last stdout line that parses as JSON (Electron logs noise too). */
function extractJsonLine(stdout: string): Measurement | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Measurement;
    } catch {
      /* keep scanning upward */
    }
  }
  return null;
}

/**
 * The mechanical ghost window = the canonical set's own inclusive [min,max]
 * shifted-date span. Derived from the manifest (via `expected.filterOff`), NOT
 * a hardcoded constant. This intentionally widens past the scenario's
 * `auditWindow` (which is narrow for tx1) so the legitimately-linked out-of-
 * window rows are not false-flagged; the app's junction query IS date-bounded
 * while H3's derivation omits the window (reconciliation deferred to
 * BACKLOG-1887 / FU-1). Returns null when there is no canonical set to bound.
 */
function canonicalSpan(expected: ExpectedSets): { start: string; end: string } | null {
  const dates = expected.filterOff
    .map((m) => m.shiftedDate)
    .filter((d): d is string => Boolean(d))
    .sort();
  if (dates.length === 0) return null;
  return { start: dates[0], end: dates[dates.length - 1] };
}

/** Linked members whose shiftedDate falls OUTSIDE the inclusive window. */
function findGhosts(
  linked: LinkedMember[],
  window: { start: string; end: string },
): EmailSetMember[] {
  return linked
    .filter((m) => !m.shiftedDate || m.shiftedDate < window.start || m.shiftedDate > window.end)
    .map((m) => ({ subject: m.subject, shiftedDate: m.shiftedDate }));
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

      const run = spawnSync(
        electronBin,
        [script, '--scenario', ctx.scenarioPath, '--json'],
        {
          cwd: ctx.repoRoot,
          encoding: 'utf8',
          // Child inherits env, so $KEEPR_QA_DB_KEY / $KEEPR_QA_DB set by the
          // runner (CI / fixtures) flow through automatically.
          env: process.env,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
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

      const m = extractJsonLine(run.stdout || '');
      if (!m || (m.stage !== 'assert-db-measure' && !m.error)) {
        const stderrTail = (run.stderr || '').split(/\r?\n/).slice(-5).join('\n');
        return {
          stage: STAGE,
          status: 'fail',
          durationMs,
          detail: `db-assert produced no parseable measurement (exit ${run.status ?? 'null'}). stderr: ${stderrTail}`,
          deviations: [],
          actual: emptyActual(),
        };
      }
      if (m.error) {
        return {
          stage: STAGE,
          status: 'fail',
          durationMs,
          detail: `db-assert measurement error: ${m.error}`,
          deviations: [],
          actual: emptyActual(),
        };
      }

      const filterOff = m.filterOff ?? [];
      const filterOn = m.filterOn ?? [];
      const linked = m.linked ?? null;

      // Mechanical ghost scan (only when a transaction's links were resolved).
      const window = canonicalSpan(expected);
      const ghosts: EmailSetMember[] =
        linked && window ? findGhosts(linked, window) : [];

      const actual: ActualSets = {
        corpus: m.corpus ?? 0,
        filterOff,
        filterOn,
        ghosts,
      };

      // H1's shared MULTISET diff produces the exact-count deviations (C1 fix).
      const deviations: CountDeviation[] = evaluateSetDiff(expected, actual);

      // link_source integrity is an H3-specific gate not covered by H1's
      // evaluateSetDiff: every resolved link must be `auto`.
      const nonAuto = (linked ?? []).filter((l) => l.linkSource !== 'auto');
      if (nonAuto.length > 0) {
        deviations.push({
          cell: 'link_source',
          expected: 0,
          got: nonAuto.length,
          extraMembers: nonAuto.map((l) => ({ subject: l.subject, shiftedDate: l.shiftedDate })),
        });
      }

      const linkNote = linked
        ? `link/ghost checked vs txn ${m.transactionId ?? '?'}`
        : 'no transaction resolved — link/ghost checks skipped';
      const detail =
        `${filterOff.length}/${expected.counts.filterOff} OFF · ` +
        `${filterOn.length}/${expected.counts.filterOn} ON · ` +
        `${deviations.length} deviation(s) · ${linkNote}`;

      return {
        stage: STAGE,
        status: deviations.length === 0 ? 'pass' : 'fail',
        durationMs,
        detail,
        deviations,
        actual,
      };
    },
  };
}

export default createDbSetDiffAsserter;
