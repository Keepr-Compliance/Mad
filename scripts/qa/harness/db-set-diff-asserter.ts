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
export interface Measurement {
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

/** Shape of the fields we read off a Node spawnSync result. */
export interface SpawnOutcome {
  error?: { code?: string; message: string } | null;
  signal?: NodeJS.Signals | null;
  status?: number | null;
}

const PROVISION_HINT =
  'Provision the DB key once (one-time macOS Keychain "Always Allow"; the key stays ' +
  'in your shell env, never on disk):\n' +
  '      eval "$(npm run --silent qa:db-key -- --print-export)"\n' +
  '    then re-run this command.';

function failResult(durationMs: number, detail: string): SetDiffResult {
  return { stage: STAGE, status: 'fail', durationMs, detail, deviations: [], actual: emptyActual() };
}

/**
 * Map a db-assert spawn result + parsed measurement to a fast, ACTIONABLE
 * failure — or `null` to proceed with a valid measurement. This is the
 * live-validation DEFECT fix: a keychain prompt that never returns must surface
 * a clean `{error}` (with a provisioning hint), NEVER a 120s ETIMEDOUT hang.
 */
export function launchFailure(
  run: SpawnOutcome,
  outFile: string,
  m: Measurement | null,
  durationMs: number,
): SetDiffResult | null {
  if (run.error) {
    const timedOut = run.error.code === 'ETIMEDOUT';
    return failResult(
      durationMs,
      timedOut
        ? 'db-assert timed out after 25s — the DB is likely locked (is the Keepr app open? close it) or unusually large.'
        : `Failed to launch db-assert: ${run.error.message}`,
    );
  }
  if (!m || (m.stage !== 'assert-db-measure' && !m.error)) {
    const killed = run.signal != null;
    return failResult(
      durationMs,
      killed
        ? `db-assert was killed by ${run.signal} with no measurement (DB locked or too large?).`
        : `db-assert produced no measurement at ${outFile} (exit ${run.status ?? 'null'}). If this mentions ` +
            'a NODE_MODULE_VERSION mismatch, rebuild the cipher for Node: `npm rebuild better-sqlite3-multiple-ciphers`.',
    );
  }
  if (m.error) {
    return failResult(durationMs, `db-assert error: ${m.error}`);
  }
  return null;
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

      const script = path.join(ctx.repoRoot, 'scripts', 'qa', 'harness', 'db-assert.js');

      // The DB key lives in the macOS Keychain; reading it needs a foreground
      // `safeStorage` prompt that a spawned child CANNOT reliably present (the
      // round-4 hang). So the ceremony path requires the key in the environment,
      // provisioned ONCE via `npm run qa:db-key` (foreground → one prompt).
      if (!process.env.KEEPR_QA_DB_KEY) {
        return failResult(
          Date.now() - started,
          `No DB key in the environment.\n    ${PROVISION_HINT}`,
        );
      }

      // Robust channel: db-assert writes its measurement to this temp file (and
      // a sentinel stdout line as fallback); we read the file first.
      const outFile = path.join(os.tmpdir(), `qa-dbassert-${process.pid}-${Date.now()}.json`);

      // Run db-assert under PLAIN NODE (this same interpreter). With a key it
      // needs no Electron/keychain, and it loads the node-ABI cipher module from
      // `npm install` — so it exits in <1s with no GUI Electron to hang on.
      const run = spawnSync(
        process.execPath,
        [script, '--scenario', ctx.scenarioPath, '--json', '--out', outFile],
        {
          cwd: ctx.repoRoot,
          encoding: 'utf8',
          env: process.env,
          stdio: 'ignore',
          // Bounded so a stuck child (e.g. a locked DB) fails FAST with an
          // actionable {error} rather than any long hang.
          timeout: 25_000,
          killSignal: 'SIGKILL',
        },
      );
      const durationMs = Date.now() - started;

      const m = readMeasurement(outFile, run.stdout || '');
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {
        /* best-effort cleanup */
      }

      const failure = launchFailure(run, outFile, m, durationMs);
      if (failure) return failure;
      const meas = m as Measurement; // valid measurement past the guard

      const filterOff = meas.filterOff ?? [];
      const filterOn = meas.filterOn ?? [];
      const linked = meas.linked ?? null;

      // Mechanical ghost scan (only when a transaction's links were resolved).
      const window = canonicalSpan(expected);
      const ghosts: EmailSetMember[] =
        linked && window ? findGhosts(linked, window) : [];

      const actual: ActualSets = {
        corpus: meas.corpus ?? 0,
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
        ? `link/ghost checked vs txn ${meas.transactionId ?? '?'}`
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
