/**
 * QA Harness — EDGE-CASE MATRIX asserter (BACKLOG-1854 / QA-H7).
 *
 * Spawns the plain-node MEASUREMENT shell (./edge-case-measure.js) — which opens
 * the app's OWN encrypted DB via the app's OWN cipher module + key and MEASURES
 * the idempotence / timezone-boundary / ghost / signature sets — then applies
 * H1's SHARED MULTISET diff (./diff) to produce EXACT-count edge-case cells. It
 * also runs the two LOG cells (telemetry BACKLOG-1843 + redaction BACKLOG-1785)
 * via the pure ./log-scan-core over a resolved main.log or a committed fixture.
 *
 * WHY the split (mirrors H3/H6): the set-identity rule is a MULTISET and lives
 * ONCE in H1's diff.ts. The Electron/native measurement is isolated in the
 * shell; this adapter runs under bare ts-node and evaluates in-process.
 *
 * SKIP-CLEAN CONTRACT (mirrors H6): with no KEEPR_QA_DB_KEY (and no --live) the
 * DB-backed cells return `skip` with an actionable provisioning hint — this
 * adapter NEVER spawns a child that could hang on a keychain prompt. The LOG
 * cells (telemetry + redaction) are fixture-backed and run regardless of --live.
 *
 * CELL STATUS SEMANTICS:
 *   pass     — assertion held.
 *   fail     — an exact-count / invariant deviation (exit 1 in the CLI).
 *   skip     — DB cell not run (no --live / no key) — never a failure.
 *   gated    — a required resource is ABSENT (e.g. no real main.log) — non-fail.
 *   info     — nothing to assert / vacuous invariant (mirrors H6 no-BCC case).
 *   reported — MEASURED a signal but deliberately withholds the gate. The
 *              redaction cell is REPORTED-NOT-GATED until BACKLOG-1785 lands;
 *              its detail ALWAYS carries the numeric leak count. Non-fail (exit 0).
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import type { CountDeviation, EmailSetMember } from './types';
import { diffMembers } from './diff';
// The log scanners are pure JS (no DB, no I/O) — imported for the two log cells.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logScan = require('./log-scan-core') as {
  scanTelemetry: (t: string) => {
    markers: Array<{ id: string; label: string; present: boolean; count: number }>;
    presentCount: number;
    totalMarkers: number;
    allPresent: boolean;
  };
  scanRedaction: (
    t: string,
    opts?: { sampleLimit?: number; allowlist?: string[] },
  ) => { leakCount: number; uniqueLeakCount: number; maskedSamples: string[]; lineNumbers: number[] };
};

/** Sentinel prefix edge-case-measure.js stamps on its single JSON stdout line. */
export const SENTINEL = '__QA_EDGECASE_JSON__ ';

// ---------------------------------------------------------------------------
// Measurement shapes (what the shell emits)
// ---------------------------------------------------------------------------

export interface TimezoneBoundaryProbe {
  subject: string;
  matches: Array<{ subject: string; shiftedDate: string; sentAtRaw: string }>;
}

export interface Measurement {
  stage?: string;
  corpus?: number;
  idempotence?: {
    filterOffRun1: EmailSetMember[];
    filterOffRun2: EmailSetMember[];
    filterOnRun1: EmailSetMember[];
    filterOnRun2: EmailSetMember[];
  };
  timezoneBoundary?: TimezoneBoundaryProbe[];
  ghosts?: { tombstoneCount: number; resurrections: EmailSetMember[] };
  signature?: { probeAddress: string; participant: EmailSetMember[]; freetext: EmailSetMember[] } | null;
  error?: string;
}

export type CellStatus = 'pass' | 'fail' | 'skip' | 'gated' | 'info' | 'reported';

export interface EdgeCaseCell {
  id: string;
  kind: string;
  status: CellStatus;
  detail: string;
  deviations?: CountDeviation[];
}

export type ResultStatus = 'pass' | 'fail' | 'skipped';

export interface EdgeCaseResult {
  stage: 'edge-cases';
  status: ResultStatus;
  durationMs: number;
  detail: string;
  cells: EdgeCaseCell[];
}

/** Raw scenario JSON (edgeCases block read outside H1 zod, like searchQueries). */
export interface EdgeScenario {
  expectedCounts?: { corpus?: number; filterOff?: number; filterOn?: number };
  sourceTimezone?: string;
  edgeCases?: {
    timezoneBoundary?: Array<{ subject: string; expectedShiftedDate: string }>;
    signatureProbeAddress?: string | null;
    signatureProbeIsContact?: boolean;
    logScan?: {
      /** Path(s) to a real main.log (may use ~ / $VAR). First existing wins. */
      logPaths?: string[];
      /** Committed fixture (relative to the scenario file) — the fallback + CI source of truth. */
      telemetryFixture?: string;
      /** Allowlisted address substrings that are not redaction leaks (e.g. noreply@). */
      redactionAllowlist?: string[];
    };
  };
}

export interface EdgeExpectationBundle {
  scenario: EdgeScenario;
  /** Absolute path to the loaded scenario file (for resolving relative fixtures). */
  scenarioPath: string;
}

// ---------------------------------------------------------------------------
// Pure DB-set evaluators (unit-testable without spawning)
// ---------------------------------------------------------------------------

/** Diff two measured sets → deviations (exact count + multiset membership). */
export function evaluateMembers(
  cell: string,
  expected: EmailSetMember[],
  actual: EmailSetMember[],
): CountDeviation[] {
  const { missing, extra } = diffMembers(expected, actual);
  if (actual.length === expected.length && missing.length === 0 && extra.length === 0) {
    return [];
  }
  return [
    {
      cell,
      expected: expected.length,
      got: actual.length,
      missingMembers: missing.length ? missing : undefined,
      extraMembers: extra.length ? extra : undefined,
    },
  ];
}

/**
 * IDEMPOTENCE (set-stability): run1 must equal run2 (identical multiset) for
 * BOTH OFF and ON, AND the counts must equal the manifest. Named
 * `idempotence:set-stability` so the output never overstates coverage — TRUE
 * wipe→reseed→re-ingest idempotence is owned by H4 (BACKLOG-1851).
 */
export function evaluateIdempotenceCell(m: Measurement, bundle: EdgeExpectationBundle): EdgeCaseCell {
  const idem = m.idempotence;
  if (!idem) {
    return { id: 'idempotence:set-stability', kind: 'idempotence', status: 'info', detail: 'no idempotence measurement' };
  }
  const deviations: CountDeviation[] = [];
  // Stability: run1 === run2 (a read cannot mutate; a difference is a real bug).
  deviations.push(...evaluateMembers('idempotence:off-stability', idem.filterOffRun1, idem.filterOffRun2));
  deviations.push(...evaluateMembers('idempotence:on-stability', idem.filterOnRun1, idem.filterOnRun2));
  // Manifest-count equality (the founder seed already IS the post-idempotence state).
  const expOff = bundle.scenario.expectedCounts?.filterOff;
  const expOn = bundle.scenario.expectedCounts?.filterOn;
  if (typeof expOff === 'number' && idem.filterOffRun1.length !== expOff) {
    deviations.push({ cell: 'idempotence:off-count', expected: expOff, got: idem.filterOffRun1.length });
  }
  if (typeof expOn === 'number' && idem.filterOnRun1.length !== expOn) {
    deviations.push({ cell: 'idempotence:on-count', expected: expOn, got: idem.filterOnRun1.length });
  }
  return {
    id: 'idempotence:set-stability',
    kind: 'idempotence',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail:
      `OFF ${idem.filterOffRun1.length}=${idem.filterOffRun2.length} · ON ${idem.filterOnRun1.length}=${idem.filterOnRun2.length} ` +
      `· derived-set replay stable + counts vs manifest (true re-ingest idempotence owned by H4/BACKLOG-1851)`,
    deviations: deviations.length ? deviations : undefined,
  };
}

/**
 * TIMEZONE +1-day boundary (BACKLOG-1887): each declared boundary subject must
 * resolve (via shiftedDateOf in the shell) to its expected LOCAL shifted date —
 * proving the evening UTC row was correctly pulled back one day into the source
 * timezone. A subject with no DB match, or a wrong shifted date, is a deviation.
 */
export function evaluateTimezoneCell(m: Measurement, bundle: EdgeExpectationBundle): EdgeCaseCell {
  const declared = bundle.scenario.edgeCases?.timezoneBoundary ?? [];
  if (declared.length === 0) {
    return { id: 'timezone:evening-boundary', kind: 'timezone', status: 'info', detail: 'no timezone boundary rows declared' };
  }
  const probes = m.timezoneBoundary ?? [];
  const bySubject = new Map(probes.map((p) => [p.subject.trim(), p]));
  const deviations: CountDeviation[] = [];
  let checked = 0;
  for (const d of declared) {
    const probe = bySubject.get(d.subject.trim());
    const dates = (probe?.matches ?? []).map((mm) => mm.shiftedDate);
    if (dates.length === 0) {
      // No DB row for this subject — cannot assert (partial corpus). Skip, not fail.
      continue;
    }
    checked += 1;
    if (!dates.includes(d.expectedShiftedDate)) {
      deviations.push({
        cell: `timezone:${d.subject}`,
        expected: 1,
        got: 0,
        // Report what we saw vs expected via members (subject + the dates found).
        missingMembers: [{ subject: d.subject, shiftedDate: d.expectedShiftedDate }],
        extraMembers: dates.map((dt) => ({ subject: d.subject, shiftedDate: dt })),
      });
    }
  }
  if (checked === 0) {
    return {
      id: 'timezone:evening-boundary',
      kind: 'timezone',
      status: 'skip',
      detail: `${declared.length} boundary row(s) declared but none present in DB — skipped (partial/absent corpus)`,
    };
  }
  return {
    id: 'timezone:evening-boundary',
    kind: 'timezone',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail: `${checked}/${declared.length} evening boundary row(s) land +1-day UTC at the expected local date`,
    deviations: deviations.length ? deviations : undefined,
  };
}

/** GHOST / resurrection gate (BACKLOG-1764): 0 resurrections. */
export function evaluateGhostsCell(m: Measurement): EdgeCaseCell {
  const g = m.ghosts ?? { tombstoneCount: 0, resurrections: [] };
  const deviations: CountDeviation[] = [];
  if (g.resurrections.length !== 0) {
    deviations.push({ cell: 'ghosts', expected: 0, got: g.resurrections.length, extraMembers: g.resurrections });
  }
  return {
    id: 'ghost-resurrection',
    kind: 'ghost',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail: `${g.tombstoneCount} tombstone(s) · ${g.resurrections.length} resurrection(s) (BACKLOG-1764)`,
    deviations: deviations.length ? deviations : undefined,
  };
}

/**
 * SIGNATURE false-positive: an address that appears only in a signature block
 * must NOT surface unrelated mail. Two cases:
 *  - probe IS a transaction contact (signatureProbeIsContact=true): the invariant
 *    is that its participant links are all TX-confined; a free-text-only hit that
 *    is NOT a participant match would be a signature-mention false-positive.
 *  - probe is NOT a contact: participant set MUST be empty (a signature mention
 *    must never create a participant link).
 * When no probe is configured, or the address is absent from the corpus, the
 * invariant is vacuous → `info` (mirrors H6's no-BCC handling).
 */
export function evaluateSignatureCell(m: Measurement, bundle: EdgeExpectationBundle): EdgeCaseCell {
  const probe = m.signature;
  const declaredAddr = bundle.scenario.edgeCases?.signatureProbeAddress;
  if (!declaredAddr || !probe) {
    return { id: 'signature-false-positive', kind: 'signature', status: 'info', detail: 'no signature probe configured — invariant vacuously holds' };
  }
  const isContact = bundle.scenario.edgeCases?.signatureProbeIsContact === true;
  const deviations: CountDeviation[] = [];

  // Free-text hits that are NOT participant matches = body/signature-only reach.
  const { missing: freetextOnly } = diffMembers(probe.freetext, probe.participant); // in freetext, not in participant
  if (!isContact) {
    // Non-contact probe: it must create ZERO participant links.
    if (probe.participant.length !== 0) {
      deviations.push({
        cell: 'signature:non-contact-participant',
        expected: 0,
        got: probe.participant.length,
        extraMembers: probe.participant,
      });
    }
    if (probe.participant.length === 0 && probe.freetext.length === 0) {
      return { id: 'signature-false-positive', kind: 'signature', status: 'info', detail: `probe ${declaredAddr} absent from corpus — invariant vacuously holds` };
    }
  }
  return {
    id: 'signature-false-positive',
    kind: 'signature',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail:
      `probe ${declaredAddr} · ${probe.participant.length} participant link(s) · ` +
      `${freetextOnly.length} free-text-only (signature-reach) hit(s)` +
      (isContact ? ' · contact probe (participant links are TX-confined)' : ' · non-contact probe (participant must be 0)'),
    deviations: deviations.length ? deviations : undefined,
  };
}

// ---------------------------------------------------------------------------
// LOG cells (pure, fixture-backed; run regardless of --live)
// ---------------------------------------------------------------------------

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));
  else if (out === '~') out = os.homedir();
  out = out.replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, name) => process.env[name] ?? '');
  return out;
}

export type LogSource = 'real-log' | 'fixture' | 'none';
export interface ResolvedLog {
  text: string;
  source: LogSource;
  path?: string;
}

function readRealLog(bundle: EdgeExpectationBundle): ResolvedLog | null {
  const cfg = bundle.scenario.edgeCases?.logScan;
  for (const p of cfg?.logPaths ?? []) {
    const abs = expandPath(p);
    try {
      if (fs.existsSync(abs)) return { text: fs.readFileSync(abs, 'utf8'), source: 'real-log', path: abs };
    } catch {
      /* try next */
    }
  }
  return null;
}

function readFixture(bundle: EdgeExpectationBundle): ResolvedLog | null {
  const cfg = bundle.scenario.edgeCases?.logScan;
  if (!cfg?.telemetryFixture) return null;
  const abs = path.resolve(path.dirname(bundle.scenarioPath), cfg.telemetryFixture);
  try {
    if (fs.existsSync(abs)) return { text: fs.readFileSync(abs, 'utf8'), source: 'fixture', path: abs };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Resolve the log text. The two log cells want OPPOSITE precedence:
 *   - `prefer:'fixture'` (telemetry): the committed fixture is the DETERMINISTIC
 *     CI source of truth; a real machine-local log (which may predate the 1843
 *     fix on this base branch) is only a supplementary observation, never the
 *     deterministic assertion. Fixture first, real log fallback.
 *   - `prefer:'real-log'` (redaction): the REAL 1785 leak signal lives in the
 *     actual main.log; fixture only as fallback for CI coverage.
 */
export function resolveLogText(bundle: EdgeExpectationBundle, prefer: 'fixture' | 'real-log' = 'real-log'): ResolvedLog {
  const primary = prefer === 'fixture' ? readFixture(bundle) : readRealLog(bundle);
  if (primary) return primary;
  const fallback = prefer === 'fixture' ? readRealLog(bundle) : readFixture(bundle);
  if (fallback) return fallback;
  return { text: '', source: 'none' };
}

/** Observe the real machine-local log if present (telemetry supplementary signal). */
export function observeRealLog(bundle: EdgeExpectationBundle): ResolvedLog | null {
  return readRealLog(bundle);
}

/**
 * TELEMETRY cell (BACKLOG-1843): the fetch/link/CACHE-HITMISS lines must be
 * present. The committed FIXTURE is the deterministic source of truth (SR review
 * Q2) — a format change in emailSyncService.ts that the fixture didn't track
 * FAILS here. GATED-clean (non-fail) when no fixture AND no real log exist.
 *
 * A machine-local REAL main.log is only a SUPPLEMENTARY observation appended to
 * the detail: on this base branch (which predates the 1843 fix, merged to
 * int/v2.20.1) a real log legitimately lacks the markers, so it must NOT drag
 * the deterministic suite to FAIL. When the 1843 fix rides the next DMG the real
 * log will carry the markers and the observation will read complete.
 */
export function evaluateTelemetryCell(bundle: EdgeExpectationBundle): EdgeCaseCell {
  const fixture = resolveLogText(bundle, 'fixture');
  const real = observeRealLog(bundle);
  const realNote = real
    ? (() => {
        const rs = logScan.scanTelemetry(real.text);
        return ` · real-log observed: ${rs.presentCount}/${rs.totalMarkers} marker(s) [${real.path}]` +
          (rs.allPresent ? '' : ' (pre-1843 build lacks markers — observational, not gating)');
      })()
    : '';

  if (fixture.source === 'none') {
    // No committed fixture: gate on the deterministic assertion. If a real log
    // exists it is still only observed, never a hard fail.
    return {
      id: 'telemetry-packaged-build',
      kind: 'telemetry',
      status: 'gated',
      detail:
        'no committed telemetry fixture — gated (BACKLOG-1843; markers source: electron/services/emailSyncService.ts)' + realNote,
    };
  }
  const scan = logScan.scanTelemetry(fixture.text);
  const missing = scan.markers.filter((mk) => !mk.present);
  const deviations: CountDeviation[] = missing.map((mk) => ({ cell: `telemetry:${mk.id}`, expected: 1, got: 0 }));
  return {
    id: 'telemetry-packaged-build',
    kind: 'telemetry',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail:
      `${scan.presentCount}/${scan.totalMarkers} telemetry marker(s) present [fixture] (BACKLOG-1843)` +
      (missing.length ? ` · missing: ${missing.map((mk) => mk.id).join(', ')}` : '') +
      realNote,
    deviations: deviations.length ? deviations : undefined,
  };
}

/**
 * REDACTION cell (SCOPE ADD 2026-07-10, guards BACKLOG-1785): scan the log for
 * plaintext email addresses / PII. REPORTED-NOT-GATED — it MEASURES and REPORTS
 * the leak count but NEVER fails the ceremony (status `reported`, exit 0). The
 * detail ALWAYS carries the numeric leak count (even 0) so it is greppable and
 * the 1785 signal is unmistakable. Flips to a hard gate once BACKLOG-1785 lands.
 */
export function evaluateRedactionCell(bundle: EdgeExpectationBundle): EdgeCaseCell {
  const resolved = resolveLogText(bundle);
  if (resolved.source === 'none') {
    return {
      id: 'log-redaction',
      kind: 'redaction',
      status: 'gated',
      detail: '0 leaks measured — no log source available; gated (guards BACKLOG-1785; flips to hard gate when 1785 lands)',
    };
  }
  const allowlist = bundle.scenario.edgeCases?.logScan?.redactionAllowlist ?? [];
  const scan = logScan.scanRedaction(resolved.text, { sampleLimit: 5, allowlist });
  const samples = scan.maskedSamples.length ? ` · masked samples: ${scan.maskedSamples.join(', ')}` : '';
  return {
    id: 'log-redaction',
    kind: 'redaction',
    status: 'reported',
    detail:
      `${scan.leakCount} plaintext email leak(s) (${scan.uniqueLeakCount} unique) [${resolved.source}] ` +
      `— REPORTED-NOT-GATED, flips to hard gate when BACKLOG-1785 lands${samples}`,
  };
}

/** Assemble all cells from a valid DB measurement + the fixture-backed log cells. */
export function evaluateMeasurement(m: Measurement, bundle: EdgeExpectationBundle): EdgeCaseCell[] {
  return [
    evaluateIdempotenceCell(m, bundle),
    evaluateTimezoneCell(m, bundle),
    evaluateGhostsCell(m),
    evaluateSignatureCell(m, bundle),
    evaluateTelemetryCell(bundle),
    evaluateRedactionCell(bundle),
  ];
}

/** The two log cells only — evaluable with NO DB (used for the skip-DB path). */
export function evaluateLogOnlyCells(bundle: EdgeExpectationBundle): EdgeCaseCell[] {
  return [evaluateTelemetryCell(bundle), evaluateRedactionCell(bundle)];
}

// ---------------------------------------------------------------------------
// Measurement channel recovery (file first, then sentinel) — mirrors H3/H6
// ---------------------------------------------------------------------------

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

/** Fast, actionable launch failure → a `fail` cell, or null to proceed. Mirrors H3/H6. */
export function launchFailureCell(
  run: SpawnOutcome,
  outFile: string,
  m: Measurement | null,
): EdgeCaseCell | null {
  if (run.error) {
    const timedOut = run.error.code === 'ETIMEDOUT';
    return {
      id: 'edge-case-db', kind: 'db', status: 'fail',
      detail: timedOut
        ? 'edge-case-measure timed out after 25s — the DB is likely locked (is the Keepr app open? close it) or unusually large.'
        : `Failed to launch edge-case-measure: ${run.error.message}`,
    };
  }
  if (!m || (m.stage !== 'edge-case-measure' && !m.error)) {
    const killed = run.signal !== null && run.signal !== undefined;
    return {
      id: 'edge-case-db', kind: 'db', status: 'fail',
      detail: killed
        ? `edge-case-measure was killed by ${run.signal} with no measurement (DB locked or too large?).`
        : `edge-case-measure produced no measurement at ${outFile} (exit ${run.status ?? 'null'}). If this mentions ` +
            'a NODE_MODULE_VERSION mismatch, rebuild the cipher for Node: `npm rebuild better-sqlite3-multiple-ciphers`.',
    };
  }
  if (m.error) {
    return { id: 'edge-case-db', kind: 'db', status: 'fail', detail: `edge-case-measure error: ${m.error}` };
  }
  return null;
}

export interface AsserterContext {
  scenarioPath: string;
  repoRoot: string;
  live: boolean;
  dryRun?: boolean;
}

function summarize(cells: EdgeCaseCell[], durationMs: number): EdgeCaseResult {
  const failed = cells.filter((c) => c.status === 'fail');
  const status: ResultStatus = failed.length > 0 ? 'fail' : 'pass';
  const counts = {
    reported: cells.filter((c) => c.status === 'reported').length,
    gated: cells.filter((c) => c.status === 'gated').length,
    skipped: cells.filter((c) => c.status === 'skip').length,
  };
  return {
    stage: 'edge-cases',
    status,
    durationMs,
    detail:
      `${cells.length} cell(s) · ${failed.length} failed · ${counts.reported} reported · ` +
      `${counts.gated} gated · ${counts.skipped} skipped`,
    cells,
  };
}

/**
 * Run the edge-case matrix. The LOG cells (telemetry + redaction) always run
 * (pure, fixture-backed). The DB cells run only when live + KEEPR_QA_DB_KEY;
 * otherwise they SKIP cleanly (never hang), and the log cells still report.
 */
export function runEdgeCaseAssert(ctx: AsserterContext, bundle: EdgeExpectationBundle): EdgeCaseResult {
  const started = Date.now();
  const logCells = evaluateLogOnlyCells(bundle);

  const dbSkip = (detail: string): EdgeCaseCell[] => [
    { id: 'idempotence:set-stability', kind: 'idempotence', status: 'skip', detail },
    { id: 'timezone:evening-boundary', kind: 'timezone', status: 'skip', detail },
    { id: 'ghost-resurrection', kind: 'ghost', status: 'skip', detail },
    { id: 'signature-false-positive', kind: 'signature', status: 'skip', detail },
  ];

  if (!ctx.live || ctx.dryRun) {
    const cells = [...dbSkip('skipped — not live (run with --live + KEEPR_QA_DB_KEY to open the encrypted DB)'), ...logCells];
    return summarize(cells, Date.now() - started);
  }
  if (!process.env.KEEPR_QA_DB_KEY) {
    const cells = [...dbSkip(`skipped — no DB key in the environment.\n    ${PROVISION_HINT}`), ...logCells];
    return summarize(cells, Date.now() - started);
  }

  const script = path.join(ctx.repoRoot, 'scripts', 'qa', 'harness', 'edge-case-measure.js');
  const outFile = path.join(os.tmpdir(), `qa-edgecase-${process.pid}-${Date.now()}.json`);

  const run = spawnSync(
    process.execPath,
    [script, '--scenario', ctx.scenarioPath, '--json', '--out', outFile],
    { cwd: ctx.repoRoot, encoding: 'utf8', env: process.env, stdio: 'ignore', timeout: 25_000, killSignal: 'SIGKILL' },
  );
  const durationMs = Date.now() - started;

  const m = readMeasurement(outFile, run.stdout || '');
  try {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  } catch {
    /* best-effort cleanup */
  }

  const failCell = launchFailureCell(run, outFile, m);
  if (failCell) {
    return summarize([failCell, ...logCells], durationMs);
  }
  const meas = m as Measurement;
  const dbCells = [
    evaluateIdempotenceCell(meas, bundle),
    evaluateTimezoneCell(meas, bundle),
    evaluateGhostsCell(meas),
    evaluateSignatureCell(meas, bundle),
  ];
  return summarize([...dbCells, ...logCells], durationMs);
}
