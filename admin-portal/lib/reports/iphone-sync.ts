/**
 * iPhone Sync Performance — pure derivation (BACKLOG-3441)
 *
 * No Supabase import, no React. Everything here is a pure function of the rows
 * so it can be tested against the real `sync_outcomes` shape without a network
 * or a renderer.
 *
 * Written so BACKLOG-3440's additions (run-start rows, progress samples, end
 * reasons) drop in additively: unknown phase names render under their raw name
 * rather than disappearing, and every field this module reads is optional.
 */

// ─── Constants ───────────────────────────────────────────────────

/**
 * The `outcome` value a run carries while it is still going.
 *
 * BACKLOG-3440 writes a row when a sync STARTS and refreshes it on a heartbeat
 * every two minutes, so `sync_outcomes` now holds runs that have not finished.
 * On such a row:
 *
 *   - `elapsed_ms` is time spent SO FAR, not a duration
 *   - the extraction counts are absent, because nothing has been stored yet
 *   - `backup_bytes` and any min/GB derived from it describe a transfer that is
 *     still happening
 *
 * Every aggregate below assumes a row is a finished run, so
 * {@link buildIphoneSyncReport} removes these rows before deriving anything.
 * Left in, they would land hardest on the flag this page exists for: a healthy
 * first sync past the 30-minute mark has burned the time and stored nothing
 * yet, which is exactly the shape of {@link isStalled}.
 */
export const IN_PROGRESS_OUTCOME = 'running';

/**
 * A run is "stalled" when it burned this long and extracted nothing.
 *
 * Deliberately outcome-agnostic ACROSS TERMINAL OUTCOMES: a run that reports
 * `complete` and produces no messages is just as broken as one that reports
 * `cancelled`, and this catches that the day it happens without a code change.
 *
 * It is not a judgement about runs still in flight, and it must never be handed
 * one — {@link IN_PROGRESS_OUTCOME} says why, and
 * {@link buildIphoneSyncReport} is where they are removed.
 */
export const STALL_THRESHOLD_MINUTES = 30;

/** 1 GB in this report means 1 GiB — the unit the OS reports device usage in. */
export const BYTES_PER_GB = 1024 * 1024 * 1024;

const MS_PER_MINUTE = 60_000;

/** 1 MB here is 1 MiB, consistent with {@link BYTES_PER_GB}. */
export const BYTES_PER_MB = 1024 * 1024;

/** The phase whose own duration the transfer rate is measured over. */
export const TRANSFER_PHASE = 'backup:transferring';

// ─── Row / lookup types ──────────────────────────────────────────

/** One entry of `sync_outcomes.phases` (jsonb array of `{phase, elapsed_ms}`). */
export interface SyncPhaseSample {
  phase: string;
  elapsed_ms: number;
}

/**
 * A `sync_outcomes` row as this report reads it.
 *
 * Every column except `id`, `outcome` and `created_at` is nullable in the
 * table, and the report must render when they are null — most failing runs
 * never get far enough to populate them.
 */
export interface SyncOutcomeRow {
  id: string;
  user_id: string | null;
  created_at: string;
  source?: string | null;
  outcome: string;
  elapsed_ms: number | null;
  phases: unknown;
  prior_backup?: string | null;
  incremental?: boolean | null;
  was_encrypted?: boolean | null;
  device_model?: string | null;
  device_ios_version?: string | null;
  device_used_bytes?: number | null;
  backup_bytes?: number | null;
  backup_bytes_unmeasured?: boolean | null;
  messages_extracted?: number | null;
  conversations_extracted?: number | null;
  contacts_extracted?: number | null;
  app_version?: string | null;
  platform?: string | null;
  is_packaged?: boolean | null;

  // BACKLOG-3440's run-evidence columns. `started_at` is written by a shipped
  // build (21 of 24 rows on 2026-09-19); the other five are on ZERO rows and
  // ship in 2.38.1, so everything below renders them only when present.
  started_at?: string | null;
  bytes_transferred?: number | null;
  bytes_last_increased_at?: string | null;
  last_phase?: string | null;
  reason_code?: string | null;
  ended_by?: string | null;
}

export interface ReportUser {
  id: string;
  email: string | null;
  display_name: string | null;
}

// ─── View-model types ────────────────────────────────────────────

export type OutcomeTone = 'good' | 'critical' | 'warning' | 'neutral';

export interface PhaseRow {
  /** Raw phase key as stored. */
  key: string;
  /** Human label; unknown keys fall through as themselves. */
  label: string;
  elapsedMs: number;
  durationLabel: string;
  /** Width relative to the longest phase of this run, 0–100. */
  widthPct: number;
  /** Share of this run's measured phase time, 0–100. */
  sharePct: number;
  /** True for the last phase the run reached. */
  isLast: boolean;
}

/**
 * Whether the run was a first sync or an incremental one.
 *
 * `unknown` is not a failure to read the column — it is the column being NULL,
 * which is what a run that ended before the backup mode was known looks like
 * (most cancels in the first minute). The table renders it "not recorded".
 */
export type SyncType = 'first' | 'incremental' | 'unknown';

export interface SyncRun {
  id: string;
  /**
   * Raw `created_at`. The SORT KEY and the day-bucket key.
   *
   * `whenUtc` is a DISPLAY string and must never be sorted on, and this must
   * never be compared lexicographically — Postgres trims a whole-second
   * timestamp's fractional part, so "…:43Z" < "…:43.803Z" is false. Use
   * `Date.parse`.
   */
  createdAtIso: string;
  whenUtc: string;
  userLabel: string;
  outcome: string;
  outcomeTone: OutcomeTone;

  elapsedMs: number | null;
  durationLabel: string;
  /** e.g. "181.7" — null when elapsed_ms is null. */
  minutes: number | null;

  deviceUsedGb: number | null;
  backupGb: number | null;
  backupUnmeasured: boolean;

  messagesExtracted: number | null;
  conversationsExtracted: number | null;
  contactsExtracted: number | null;

  /** Whole-run minutes per GB of device-reported usage. Null when either side is missing. */
  minPerGb: number | null;
  minPerGbLabel: string;

  deviceLabel: string;
  platform: string;
  appVersion: string;
  isDevBuild: boolean;

  /** Own duration of the `backup:transferring` phase, or null when absent. */
  transferMs: number | null;
  /**
   * Transfer rate in MB/s. Null when nothing measured a numerator — which is
   * 20 of the 24 rows on record today, and is NOT the same as zero.
   */
  rateMbPerSec: number | null;
  rateLabel: string;

  syncType: SyncType;
  syncTypeLabel: string;

  phases: PhaseRow[];
  /** Label of the last phase reached, or null when no phases were recorded. */
  lastPhaseLabel: string | null;

  // BACKLOG-3440 evidence, passed through unchanged and rendered only when
  // present. Five of the six are on zero rows until 2.38.1 reaches users.
  startedAtIso: string | null;
  bytesTransferred: number | null;
  bytesLastIncreasedAtIso: string | null;
  lastPhaseRaw: string | null;
  reasonCode: string | null;
  endedBy: string | null;

  stalled: boolean;
}

export interface Baseline {
  /** Median min/GB across completed runs. Null when no completed run has both numbers. */
  medianMinPerGb: number | null;
  /** How many completed runs contributed. */
  sampleSize: number;
  /** Lowest and highest min/GB among those runs — the honest spread. */
  spread: { min: number; max: number } | null;
}

export interface IphoneSyncReportModel {
  /** Finished runs only. A run still in flight is not counted anywhere here. */
  totalRuns: number;
  counts: { complete: number; cancelled: number; error: number; other: number };
  /** Runs meeting the stall rule, longest first. */
  stalled: SyncRun[];
  /** Every finished run, newest first. */
  runs: SyncRun[];
  baseline: Baseline;
}

// ─── Formatting ──────────────────────────────────────────────────

const EM_DASH = '—';

/** Fixed UTC rendering — never `toLocaleString`, which varies by server locale. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return EM_DASH;
  if (ms > 0 && ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatGb(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return EM_DASH;
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM_DASH;
  return n.toLocaleString('en-US');
}

/** One decimal, e.g. "181.7". */
export function formatMinutes(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EM_DASH;
  return (ms / MS_PER_MINUTE).toFixed(1);
}

/**
 * The secondary "N min" line under a run's duration. A 2.2-second run must not
 * read as "0.0 min" — that says the run took no time, which is a different
 * claim from "it took under a tenth of a minute".
 */
export function formatMinutesLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return EM_DASH;
  const minutes = ms / MS_PER_MINUTE;
  if (minutes > 0 && minutes < 0.05) return '<0.1 min';
  return `${minutes.toFixed(1)} min`;
}

// ─── Phase vocabulary ────────────────────────────────────────────

/**
 * Human labels for the phases the desktop app emits today.
 *
 * A phase key not in this map renders under its own name — so a phase added by
 * BACKLOG-3440 shows up immediately instead of silently disappearing.
 */
const PHASE_LABELS: Record<string, string> = {
  backup: 'Starting backup',
  'backup:waiting-for-device': 'Waiting for device',
  'backup:transferring': 'Transferring backup from device',
  'parsing-contacts': 'Parsing contacts',
  'parsing-messages': 'Parsing messages',
  resolving: 'Resolving contacts',
  cleanup: 'Cleanup',
  'storing:messages': 'Storing messages',
  'storing:contacts': 'Storing contacts',
  'storing:attachments': 'Storing attachments',
};

export function phaseLabel(key: string): string {
  return PHASE_LABELS[key] ?? key;
}

/**
 * Read `phases` defensively.
 *
 * Accepts the array-of-samples form the column holds today. Anything else —
 * null, `[]`, a malformed entry — yields an empty list rather than throwing,
 * because a broken run is exactly when this report is being read.
 */
export function parsePhases(raw: unknown): SyncPhaseSample[] {
  if (!Array.isArray(raw)) return [];
  const out: SyncPhaseSample[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { phase?: unknown; elapsed_ms?: unknown };
    if (typeof candidate.phase !== 'string') continue;
    if (typeof candidate.elapsed_ms !== 'number' || !Number.isFinite(candidate.elapsed_ms)) continue;
    out.push({ phase: candidate.phase, elapsed_ms: candidate.elapsed_ms });
  }
  return out;
}

// ─── Derivation ──────────────────────────────────────────────────

export function outcomeTone(outcome: string): OutcomeTone {
  if (outcome === 'complete') return 'good';
  if (outcome === 'error') return 'critical';
  if (outcome === 'cancelled') return 'warning';
  return 'neutral';
}

/** True when the run produced no messages at all. */
export function extractedNothing(row: Pick<SyncOutcomeRow, 'messages_extracted'>): boolean {
  return row.messages_extracted == null || row.messages_extracted === 0;
}

/** Ran at least STALL_THRESHOLD_MINUTES and extracted nothing. */
export function isStalled(row: Pick<SyncOutcomeRow, 'elapsed_ms' | 'messages_extracted'>): boolean {
  if (row.elapsed_ms == null) return false;
  if (row.elapsed_ms < STALL_THRESHOLD_MINUTES * MS_PER_MINUTE) return false;
  return extractedNothing(row);
}

export function minutesPerGb(
  row: Pick<SyncOutcomeRow, 'elapsed_ms' | 'device_used_bytes'>
): number | null {
  const bytes = row.device_used_bytes;
  if (row.elapsed_ms == null || bytes == null || bytes <= 0) return null;
  return row.elapsed_ms / MS_PER_MINUTE / (bytes / BYTES_PER_GB);
}

/**
 * One decimal, but never a rounded-down "0.0 min/GB" — a run that finished in
 * under a tenth of a minute per GB reads as `<0.1`, not as zero.
 */
export function formatMinPerGb(value: number | null): string {
  if (value == null) return EM_DASH;
  if (value > 0 && value < 0.05) return '<0.1 min/GB';
  return `${value.toFixed(1)} min/GB`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function userLabelFor(userId: string | null, users: Map<string, ReportUser>): string {
  if (!userId) return 'Unknown user';
  const user = users.get(userId);
  if (!user) return 'Unknown user';
  return user.display_name || user.email || 'Unknown user';
}

function buildPhaseRows(samples: SyncPhaseSample[]): PhaseRow[] {
  if (samples.length === 0) return [];
  const longest = Math.max(...samples.map((s) => s.elapsed_ms), 1);
  const total = samples.reduce((sum, s) => sum + s.elapsed_ms, 0) || 1;
  return samples.map((s, i) => ({
    key: s.phase,
    label: phaseLabel(s.phase),
    elapsedMs: s.elapsed_ms,
    durationLabel: formatDuration(s.elapsed_ms),
    widthPct: Math.max((s.elapsed_ms / longest) * 100, 0.6),
    sharePct: (s.elapsed_ms / total) * 100,
    isLast: i === samples.length - 1,
  }));
}

/** Own duration of the transferring phase, or null when the run never got there. */
export function transferMsOf(samples: SyncPhaseSample[]): number | null {
  const sample = samples.find((s) => s.phase === TRANSFER_PHASE);
  if (!sample || !Number.isFinite(sample.elapsed_ms) || sample.elapsed_ms <= 0) return null;
  return sample.elapsed_ms;
}

/**
 * Transfer rate in MB/s.
 *
 * NUMERATOR: `backup_bytes` when it is above zero, else `bytes_transferred`
 * when that is above zero (PM ruling on Q2 — from 2.38.1 the byte counter
 * gives cancelled and stalled runs a rate too). Zero is not a measurement, so
 * both are tested `> 0` rather than `!= null`: a run that wrote no backup has
 * NO rate, and rendering it as 0.0 MB/s would claim a measured stall.
 *
 * DENOMINATOR: the transferring phase's OWN duration when that phase exists,
 * else whole-run elapsed. `phases[].elapsed_ms` is a per-phase duration, not a
 * cumulative elapsed — traced through `syncTimeline.closeOpenPhase` to
 * `syncOutcomeSupabase.ts:125`, and confirmed against the data (the phase sum
 * is under `elapsed_ms` on every row that has phases).
 *
 * Both fallback branches have ZERO real rows on record, so each is exercised
 * by a DERIVED fixture row — see `DERIVED_ROWS` in the fixture.
 */
export function transferRateMbPerSec(input: {
  backupBytes: number | null | undefined;
  bytesTransferred: number | null | undefined;
  transferMs: number | null;
  elapsedMs: number | null;
}): number | null {
  const backup = input.backupBytes;
  const moved = input.bytesTransferred;
  const numerator = backup != null && backup > 0 ? backup : moved != null && moved > 0 ? moved : null;
  if (numerator == null) return null;

  const ms =
    input.transferMs != null && input.transferMs > 0
      ? input.transferMs
      : input.elapsedMs != null && input.elapsedMs > 0
        ? input.elapsedMs
        : null;
  if (ms == null) return null;

  return numerator / BYTES_PER_MB / (ms / 1000);
}

/** "21.1 MB/s", one decimal. Null renders as an em dash, never as 0.0. */
export function formatRate(value: number | null): string {
  if (value == null) return EM_DASH;
  if (value > 0 && value < 0.05) return '<0.1 MB/s';
  return `${value.toFixed(1)} MB/s`;
}

export function syncTypeOf(incremental: boolean | null | undefined): SyncType {
  if (incremental === false) return 'first';
  if (incremental === true) return 'incremental';
  return 'unknown';
}

export const SYNC_TYPE_LABELS: Record<SyncType, string> = {
  first: 'first',
  incremental: 'incremental',
  unknown: 'not recorded',
};

export function buildRun(row: SyncOutcomeRow, users: Map<string, ReportUser>): SyncRun {
  const samples = parsePhases(row.phases);
  const phases = buildPhaseRows(samples);
  const minPerGb = minutesPerGb(row);
  const transferMs = transferMsOf(samples);
  const rateMbPerSec = transferRateMbPerSec({
    backupBytes: row.backup_bytes,
    bytesTransferred: row.bytes_transferred,
    transferMs,
    elapsedMs: row.elapsed_ms,
  });
  const syncType = syncTypeOf(row.incremental);
  const deviceParts = [row.device_model, row.device_ios_version ? `iOS ${row.device_ios_version}` : null]
    .filter(Boolean)
    .join(' · ');

  return {
    id: row.id,
    createdAtIso: row.created_at,
    whenUtc: formatUtc(row.created_at),
    userLabel: userLabelFor(row.user_id, users),
    outcome: row.outcome,
    outcomeTone: outcomeTone(row.outcome),

    elapsedMs: row.elapsed_ms,
    durationLabel: formatDuration(row.elapsed_ms),
    minutes: row.elapsed_ms == null ? null : row.elapsed_ms / MS_PER_MINUTE,

    deviceUsedGb: row.device_used_bytes == null ? null : row.device_used_bytes / BYTES_PER_GB,
    backupGb: row.backup_bytes == null ? null : row.backup_bytes / BYTES_PER_GB,
    backupUnmeasured: row.backup_bytes_unmeasured === true,

    messagesExtracted: row.messages_extracted ?? null,
    conversationsExtracted: row.conversations_extracted ?? null,
    contactsExtracted: row.contacts_extracted ?? null,

    minPerGb,
    minPerGbLabel: formatMinPerGb(minPerGb),

    deviceLabel: deviceParts || 'Unknown device',
    platform: row.platform ?? 'unknown',
    appVersion: row.app_version ?? 'unknown',
    isDevBuild: row.is_packaged === false,

    transferMs,
    rateMbPerSec,
    rateLabel: formatRate(rateMbPerSec),

    syncType,
    syncTypeLabel: SYNC_TYPE_LABELS[syncType],

    phases,
    lastPhaseLabel: phases.length > 0 ? phases[phases.length - 1].label : null,

    startedAtIso: row.started_at ?? null,
    bytesTransferred: row.bytes_transferred ?? null,
    bytesLastIncreasedAtIso: row.bytes_last_increased_at ?? null,
    lastPhaseRaw: row.last_phase ?? null,
    reasonCode: row.reason_code ?? null,
    endedBy: row.ended_by ?? null,

    stalled: isStalled(row),
  };
}

export function buildBaseline(runs: SyncRun[]): Baseline {
  const values = runs
    .filter((r) => r.outcome === 'complete' && r.minPerGb != null)
    .map((r) => r.minPerGb as number);
  return {
    medianMinPerGb: median(values),
    sampleSize: values.length,
    spread:
      values.length > 0
        ? { min: Math.min(...values), max: Math.max(...values) }
        : null,
  };
}

/**
 * How this run's min/GB compares to the median of completed runs.
 * Null when either number is missing — never a silent 1.0.
 */
export function ratioToBaseline(run: SyncRun, baseline: Baseline): number | null {
  if (run.minPerGb == null || baseline.medianMinPerGb == null || baseline.medianMinPerGb <= 0) {
    return null;
  }
  return run.minPerGb / baseline.medianMinPerGb;
}

/** The phase that consumed the most time, or null when no phases were recorded. */
export function longestPhase(run: SyncRun): PhaseRow | null {
  if (run.phases.length === 0) return null;
  return run.phases.reduce((worst, p) => (p.elapsedMs > worst.elapsedMs ? p : worst));
}

/** True for a run that has not finished — see {@link IN_PROGRESS_OUTCOME}. */
export function isInProgress(row: Pick<SyncOutcomeRow, 'outcome'>): boolean {
  return row.outcome === IN_PROGRESS_OUTCOME;
}

/**
 * Build the whole view model.
 *
 * `rows` is expected newest-first (that is how the query orders them) but the
 * stalled band re-sorts by duration, so the caller's order only decides the
 * order of the full run list.
 *
 * RUNS STILL IN FLIGHT ARE DROPPED FIRST, and nothing below sees them. Every
 * aggregate here reads a row as a finished run: the outcome counts, the
 * duration on each card, the min/GB baseline and — the one that matters — the
 * "burned 30 minutes and extracted nothing" flag, which a healthy first sync
 * past half an hour matches exactly while it is still working. The rule is
 * stated once, here, rather than repeated inside each aggregate, so a new
 * aggregate added later cannot forget it.
 *
 * The test is `excludes runs still in flight from every aggregate` in
 * `__tests__/iphone-sync.test.ts`; deleting this filter reds it.
 */
export function buildIphoneSyncReport(
  rows: SyncOutcomeRow[],
  users: ReportUser[]
): IphoneSyncReportModel {
  const userMap = new Map(users.map((u) => [u.id, u]));
  const finished = rows.filter((row) => !isInProgress(row));
  const runs = finished.map((row) => buildRun(row, userMap));

  const counts = { complete: 0, cancelled: 0, error: 0, other: 0 };
  for (const run of runs) {
    if (run.outcome === 'complete') counts.complete += 1;
    else if (run.outcome === 'cancelled') counts.cancelled += 1;
    else if (run.outcome === 'error') counts.error += 1;
    else counts.other += 1;
  }

  const stalled = runs
    .filter((r) => r.stalled)
    .sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));

  return {
    totalRuns: runs.length,
    counts,
    stalled,
    runs,
    baseline: buildBaseline(runs),
  };
}
