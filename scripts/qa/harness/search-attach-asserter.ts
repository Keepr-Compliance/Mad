/**
 * QA Harness — SEARCH + ATTACH determinism asserter (BACKLOG-1853 / QA-H6).
 *
 * Spawns the plain-node MEASUREMENT shell (./search-attach-measure.js) — which
 * opens the app's OWN encrypted DB via the app's OWN cipher module + key and
 * MEASURES search / thread / attach / ghost sets — then applies committed
 * expectations (./search-expectations, derived from H1's canonical checklist)
 * and H1's SHARED MULTISET diff (./diff) to produce the exact-count verdict.
 *
 * WHY the split (mirrors H3, BACKLOG-1850): the set-identity rule is a MULTISET
 * and lives ONCE in H1's diff.ts. The Electron/native measurement is isolated in
 * the shell; this adapter runs under bare ts-node and evaluates in-process.
 *
 * SKIP-CLEAN CONTRACT: with no KEEPR_QA_DB_KEY (and no --live), this returns a
 * `skipped` result with an actionable provisioning hint — it NEVER spawns a
 * child that could hang on a keychain prompt (the H3 round-4 hang fix).
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import type { CountDeviation, EmailSetMember } from './types';
import { diffMembers } from './diff';
import {
  toMembers,
  expectedForContact,
  expectedForSubjectToken,
  expectedSubjectFamilies,
  type ParsedCanonicalList,
} from './search-expectations';

/** Sentinel prefix search-attach-measure.js stamps on its single JSON stdout line. */
export const SENTINEL = '__QA_SEARCHATTACH_JSON__ ';

// ---------------------------------------------------------------------------
// Measurement shapes (what the shell emits)
// ---------------------------------------------------------------------------

export interface MeasuredQuery {
  id: string;
  kind: string;
  query: string;
  role: string | null;
  normalized: EmailSetMember[];
  rawWhitespace?: EmailSetMember[];
  normalizedWhitespace?: EmailSetMember[];
  freetext?: EmailSetMember[];
  nonBccRoles?: EmailSetMember[];
}

export interface Measurement {
  stage?: string;
  corpus?: number;
  queries?: MeasuredQuery[];
  roleCounts?: Record<string, EmailSetMember[]>;
  threads?: { threadCount: number; groups: Record<string, EmailSetMember[]> };
  linked?: {
    transactionId: string | null;
    directCount?: number;
    threadRowCount?: number;
    effectiveCount?: number;
    effectiveMembers?: EmailSetMember[];
    threadExpansions?: { threadId: string; members: EmailSetMember[] }[];
  };
  ghosts?: { tombstoneCount: number; resurrections: EmailSetMember[] };
  error?: string;
}

export type CellStatus = 'pass' | 'fail' | 'skip' | 'info';

export interface SearchAttachCell {
  id: string;
  kind: string;
  status: CellStatus;
  detail: string;
  deviations?: CountDeviation[];
}

export type ResultStatus = 'pass' | 'fail' | 'skipped';

export interface SearchAttachResult {
  stage: 'search-attach';
  status: ResultStatus;
  durationMs: number;
  detail: string;
  cells: SearchAttachCell[];
}

export interface SearchExpectationBundle {
  parsed: ParsedCanonicalList;
  /** Raw scenario JSON (with the searchQueries block + expectedCounts). */
  scenario: {
    expectedCounts?: { filterOff?: number };
    searchQueries?: { queries?: Array<Record<string, unknown>> };
  };
}

// ---------------------------------------------------------------------------
// Pure evaluators (unit-testable without spawning)
// ---------------------------------------------------------------------------

/** Diff a single measured set vs its expected set → deviations (exact count + membership). */
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

/** Evaluate one measured query against its committed expectation. */
export function evaluateQueryCell(
  mq: MeasuredQuery,
  bundle: SearchExpectationBundle,
): SearchAttachCell {
  const { parsed } = bundle;
  const deviations: CountDeviation[] = [];

  const whitespaceRobust = (): void => {
    // Leading/trailing whitespace must not change the normalized result.
    if (mq.normalizedWhitespace) {
      deviations.push(
        ...evaluateMembers(`${mq.id}:whitespace-robust`, mq.normalized, mq.normalizedWhitespace),
      );
    }
  };

  if (mq.kind === 'contact' || mq.kind === 'participant') {
    const expected = toMembers(expectedForContact(parsed, mq.query));
    deviations.push(...evaluateMembers(mq.id, expected, mq.normalized));
    whitespaceRobust();
    return finishCell(mq, deviations, `${mq.normalized.length}/${expected.length} exact`);
  }

  if (mq.kind === 'subject') {
    const expected = toMembers(expectedForSubjectToken(parsed, mq.query));
    deviations.push(...evaluateMembers(mq.id, expected, mq.normalized));
    whitespaceRobust();
    return finishCell(mq, deviations, `${mq.normalized.length}/${expected.length} exact (subject)`);
  }

  if (mq.kind === 'freetext') {
    // Free-text scans subject|sender|body → not exactly committed-derivable.
    // Gate: the subject-confined expected subset MUST be present (lower bound);
    // membership beyond it is a stable value, not an exact gate.
    const lower = toMembers(expectedForSubjectToken(parsed, mq.query));
    const { missing } = diffMembers(lower, mq.normalized);
    if (missing.length > 0) {
      deviations.push({
        cell: `${mq.id}:subject-lower-bound`,
        expected: lower.length,
        got: mq.normalized.length,
        missingMembers: missing,
      });
    }
    whitespaceRobust();
    return finishCell(
      mq,
      deviations,
      `${mq.normalized.length} result(s) ⊇ ${lower.length} subject-confined (lower bound)`,
    );
  }

  if (mq.kind === 'bcc') {
    const bcc = mq.normalized;
    if (bcc.length === 0) {
      return {
        id: mq.id,
        kind: mq.kind,
        status: 'info',
        detail: 'no BCC participant for this address in corpus — non-leak invariant vacuously holds',
      };
    }
    // Emails reachable ONLY as BCC (not From/To/Cc).
    const nonBcc = mq.nonBccRoles ?? [];
    const { missing: bccOnly } = diffMembers(bcc, nonBcc); // in bcc, not in from/to/cc
    const freetext = mq.freetext ?? [];
    // Non-leak: no BCC-only email may be returned by free-text (sender-only) search.
    const leaked = intersectMembers(bccOnly, freetext);
    if (leaked.length > 0) {
      deviations.push({
        cell: `${mq.id}:bcc-non-leak`,
        expected: 0,
        got: leaked.length,
        extraMembers: leaked,
      });
    }
    return finishCell(
      mq,
      deviations,
      `${bcc.length} bcc participant(s), ${bccOnly.length} bcc-only, ${leaked.length} leaked to free-text`,
    );
  }

  return { id: mq.id, kind: mq.kind, status: 'info', detail: `unknown query kind '${mq.kind}' — skipped` };
}

function finishCell(mq: MeasuredQuery, deviations: CountDeviation[], detail: string): SearchAttachCell {
  return {
    id: mq.id,
    kind: mq.kind,
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail,
    deviations: deviations.length ? deviations : undefined,
  };
}

/** Members present in BOTH sets (by multiset key). */
export function intersectMembers(a: EmailSetMember[], b: EmailSetMember[]): EmailSetMember[] {
  const keyOf = (m: EmailSetMember): string => `${m.subject.trim().replace(/\s+/g, ' ')} ${m.shiftedDate.trim()}`;
  const bKeys = new Set(b.map(keyOf));
  return a.filter((m) => bKeys.has(keyOf(m)));
}

/** Thread-grouping cell: each committed reply chain must map to ONE thread_id. */
export function evaluateThreadsCell(m: Measurement, bundle: SearchExpectationBundle): SearchAttachCell {
  const groups = m.threads?.groups ?? {};
  const families = expectedSubjectFamilies(bundle.parsed);
  const keyOf = (mm: EmailSetMember): string => `${mm.subject.trim().replace(/\s+/g, ' ')} ${mm.shiftedDate.trim()}`;
  // Map each member key → set of thread ids it appears in.
  const keyToThreads = new Map<string, Set<string>>();
  for (const [tid, members] of Object.entries(groups)) {
    for (const mem of members) {
      const k = keyOf(mem);
      const set = keyToThreads.get(k) ?? new Set<string>();
      set.add(tid);
      keyToThreads.set(k, set);
    }
  }
  const deviations: CountDeviation[] = [];
  let checked = 0;
  for (const fam of families) {
    const memberKeys = fam.members.map((e) => keyOf({ subject: e.subject, shiftedDate: e.shiftedDate }));
    // The set of thread ids that contain ALL members of this family.
    let common: Set<string> | null = null;
    let anyMissing = false;
    for (const k of memberKeys) {
      const tids = keyToThreads.get(k);
      if (!tids) { anyMissing = true; break; }
      if (common === null) {
        common = new Set<string>(tids);
      } else {
        const prev: Set<string> = common;
        const kept: string[] = [...prev].filter((t) => tids.has(t));
        common = new Set<string>(kept);
      }
    }
    if (anyMissing) continue; // family member not measured (e.g. partial corpus) — skip
    checked += 1;
    if (!common || common.size === 0) {
      deviations.push({
        cell: `thread:${fam.family}`,
        expected: 1,
        got: 0,
        missingMembers: fam.members.map((e) => ({ subject: e.subject, shiftedDate: e.shiftedDate })),
      });
    }
  }
  const detail = `${checked} reply-chain(s) checked, ${m.threads?.threadCount ?? 0} thread group(s)`;
  return {
    id: 'thread-grouping',
    kind: 'thread',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail,
    deviations: deviations.length ? deviations : undefined,
  };
}

/** Whole-thread attach guarantee (read-only): expansion + single-link exactness. */
export function evaluateLinkedCell(m: Measurement): SearchAttachCell {
  const linked = m.linked;
  if (!linked || !linked.transactionId) {
    return { id: 'attach-expansion', kind: 'attach', status: 'info', detail: 'no transaction resolved — attach expansion skipped' };
  }
  const deviations: CountDeviation[] = [];
  const expansions = linked.threadExpansions ?? [];
  // Every whole-thread link must expand to ≥1 member (an empty expansion is a dangling link).
  const empties = expansions.filter((e) => e.members.length === 0);
  if (empties.length > 0) {
    deviations.push({ cell: 'attach:empty-thread-links', expected: 0, got: empties.length });
  }
  const detail =
    `${linked.effectiveCount ?? 0} effective link(s) · ` +
    `${linked.directCount ?? 0} direct · ${linked.threadRowCount ?? 0} whole-thread`;
  return {
    id: 'attach-expansion',
    kind: 'attach',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail,
    deviations: deviations.length ? deviations : undefined,
  };
}

/** Ghost/stale-search gate (BACKLOG-1764): 0 resurrections. */
export function evaluateGhostsCell(m: Measurement): SearchAttachCell {
  const g = m.ghosts ?? { tombstoneCount: 0, resurrections: [] };
  const deviations: CountDeviation[] = [];
  if (g.resurrections.length !== 0) {
    deviations.push({ cell: 'ghosts', expected: 0, got: g.resurrections.length, extraMembers: g.resurrections });
  }
  return {
    id: 'ghost-scan',
    kind: 'ghost',
    status: deviations.length === 0 ? 'pass' : 'fail',
    detail: `${g.tombstoneCount} tombstone(s) · ${g.resurrections.length} resurrection(s)`,
    deviations: deviations.length ? deviations : undefined,
  };
}

/** Assemble all cells from a valid measurement. */
export function evaluateMeasurement(m: Measurement, bundle: SearchExpectationBundle): SearchAttachCell[] {
  const cells: SearchAttachCell[] = [];
  for (const mq of m.queries ?? []) cells.push(evaluateQueryCell(mq, bundle));
  cells.push(evaluateThreadsCell(m, bundle));
  cells.push(evaluateLinkedCell(m));
  cells.push(evaluateGhostsCell(m));
  return cells;
}

// ---------------------------------------------------------------------------
// Measurement channel recovery (file first, then sentinel) — mirrors H3
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

function skippedResult(durationMs: number, detail: string): SearchAttachResult {
  return { stage: 'search-attach', status: 'skipped', durationMs, detail, cells: [] };
}

function failResult(durationMs: number, detail: string): SearchAttachResult {
  return { stage: 'search-attach', status: 'fail', durationMs, detail, cells: [] };
}

/** Fast, actionable launch failure — or null to proceed. Mirrors H3. */
export function launchFailure(
  run: SpawnOutcome,
  outFile: string,
  m: Measurement | null,
  durationMs: number,
): SearchAttachResult | null {
  if (run.error) {
    const timedOut = run.error.code === 'ETIMEDOUT';
    return failResult(
      durationMs,
      timedOut
        ? 'search-attach-measure timed out after 25s — the DB is likely locked (is the Keepr app open? close it) or unusually large.'
        : `Failed to launch search-attach-measure: ${run.error.message}`,
    );
  }
  if (!m || (m.stage !== 'search-attach-measure' && !m.error)) {
    const killed = run.signal !== null && run.signal !== undefined;
    return failResult(
      durationMs,
      killed
        ? `search-attach-measure was killed by ${run.signal} with no measurement (DB locked or too large?).`
        : `search-attach-measure produced no measurement at ${outFile} (exit ${run.status ?? 'null'}). If this mentions ` +
            'a NODE_MODULE_VERSION mismatch, rebuild the cipher for Node: `npm rebuild better-sqlite3-multiple-ciphers`.',
    );
  }
  if (m.error) {
    return failResult(durationMs, `search-attach-measure error: ${m.error}`);
  }
  return null;
}

export interface AsserterContext {
  scenarioPath: string;
  repoRoot: string;
  live: boolean;
  dryRun?: boolean;
}

/**
 * Run the live search/attach measurement + verdict. Skips cleanly (never hangs)
 * when not live or when the DB key is not provisioned.
 */
export function runSearchAttachAssert(
  ctx: AsserterContext,
  bundle: SearchExpectationBundle,
): SearchAttachResult {
  const started = Date.now();

  if (!ctx.live || ctx.dryRun) {
    return skippedResult(
      Date.now() - started,
      'skipped — not live (run with --live + KEEPR_QA_DB_KEY to open the encrypted DB).',
    );
  }
  if (!process.env.KEEPR_QA_DB_KEY) {
    return skippedResult(
      Date.now() - started,
      `skipped — no DB key in the environment.\n    ${PROVISION_HINT}`,
    );
  }

  const script = path.join(ctx.repoRoot, 'scripts', 'qa', 'harness', 'search-attach-measure.js');
  const outFile = path.join(os.tmpdir(), `qa-searchattach-${process.pid}-${Date.now()}.json`);

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

  const failure = launchFailure(run, outFile, m, durationMs);
  if (failure) return failure;
  const meas = m as Measurement;

  const cells = evaluateMeasurement(meas, bundle);
  const failed = cells.filter((c) => c.status === 'fail');
  const detail =
    `${cells.length} cell(s) · ${failed.length} failed · corpus ${meas.corpus ?? '?'} · ` +
    `${meas.ghosts?.resurrections.length ?? 0} ghost(s)`;
  return {
    stage: 'search-attach',
    status: failed.length === 0 ? 'pass' : 'fail',
    durationMs,
    detail,
    cells,
  };
}
