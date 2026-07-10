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
import * as os from 'os';

/** Sentinel prefix db-assert.js stamps on its single JSON stdout line. */
export const SENTINEL = '__QA_DBASSERT_JSON__ ';
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

/**
 * Locate the Electron binary the app was built with. `$QA_ELECTRON_BIN` wins
 * (CI / machines where electron isn't under node_modules/.bin), then the
 * project's dev electron.
 */
function resolveElectronBin(repoRoot: string): string | null {
  const candidates = [
    process.env.QA_ELECTRON_BIN,
    path.join(repoRoot, 'node_modules', '.bin', 'electron'),
    path.join(repoRoot, 'node_modules', '.bin', 'electron.cmd'),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Recover the measurement from the child. Precedence:
 *   1. the `--out` temp file (robust — immune to stdout pollution), then
 *   2. the sentinel-prefixed stdout line (fallback if the file is missing).
 */
export function readMeasurement(outFile: string, stdout: string): Measurement | null {
  try {
    if (fs.existsSync(outFile)) {
      const raw = fs.readFileSync(outFile, 'utf8').trim();
      if (raw) return JSON.parse(raw) as Measurement;
    }
  } catch {
    /* fall through to stdout */
  }
  for (const line of (stdout || '').split(/\r?\n/)) {
    const idx = line.indexOf(SENTINEL);
    if (idx === -1) continue;
    try {
      return JSON.parse(line.slice(idx + SENTINEL.length)) as Measurement;
    } catch {
      /* keep scanning */
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

      // Robust channel: the child writes its measurement to this temp file AND
      // prints a sentinel-prefixed stdout line; we read the file first.
      const outFile = path.join(
        os.tmpdir(),
        `qa-dbassert-${process.pid}-${Date.now()}.json`,
      );
      // When an explicit key is available ($KEEPR_QA_DB_KEY / CI / fixtures),
      // run db-assert in NODE mode (ELECTRON_RUN_AS_NODE): no keychain, no GUI
      // Electron, clean prompt-free exit. Without a key we must boot Electron
      // MAIN so `safeStorage` can read the keychain.
      const nodeMode = Boolean(process.env.KEEPR_QA_DB_KEY);
      const childEnv = nodeMode
        ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        : process.env;
      const run = spawnSync(
        electronBin,
        [script, '--scenario', ctx.scenarioPath, '--json', '--out', outFile],
        {
          cwd: ctx.repoRoot,
          encoding: 'utf8',
          env: childEnv,
          // IMPORTANT: ignore ALL child stdio. An Electron MAIN process spawns
          // GPU/renderer helpers that inherit the stdout/stderr fds; if we piped
          // them, spawnSync would block on EOF until every helper exits — an
          // intermittent hang (a likely cause of the run-2 crash symptom). Both
          // the measurement AND any error flow through the `--out` temp file
          // (db-assert traps uncaught errors and writes `{error}` there too).
          stdio: 'ignore',
          timeout: 120_000,
          killSignal: 'SIGKILL',
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

      const m = readMeasurement(outFile, run.stdout || '');
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {
        /* best-effort cleanup */
      }

      if (!m || (m.stage !== 'assert-db-measure' && !m.error)) {
        const why = run.signal
          ? `killed by ${run.signal} (timeout?)`
          : `exit ${run.status ?? 'null'}`;
        return {
          stage: STAGE,
          status: 'fail',
          durationMs,
          detail: `db-assert produced no measurement at ${outFile} (${why}). Check the Electron binary + DB key.`,
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
