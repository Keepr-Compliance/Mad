/**
 * Email Sync Timing — the run model (BACKLOG-4130).
 *
 * Built from sync_outcomes rows with source 'email-precache', written by the
 * desktop app's buildEmailPrecacheOutcomeRow: elapsed_ms, run_kind
 * (cache | re-cache | force) and source_metrics with named counts only
 * (providers, checked, written, inserted, dbMs, build, windowMonths, backfill).
 *
 * The question it answers: how long does an email sync take, by how much mail
 * it had to fetch. Percentiles are over COMPLETED runs only — a cancelled or
 * failed run's duration is not a sync time — and every cell states its N.
 *
 * Null-tolerant: a row without source_metrics, or a non-number count, reads as
 * "not recorded", never as zero.
 *
 * Pure: no Supabase, no React.
 */

import { median, percentileNearestRank } from './percentiles';

export const EP_SOURCE = 'email-precache';
/** Columns this report reads beyond the shared ones. */
export const EP_EXTRA_COLUMNS = ['run_kind', 'source_metrics'] as const;
/**
 * This report's own cap, passed per query. The shared RUN_LIMIT (200) is left
 * alone: it is asserted by the iPhone report's tests and used by both sync
 * reports. Email syncs run on every login and every sync, so 200 would cover
 * only the newest few days.
 */
export const EP_RUN_LIMIT = 2000;

export interface EpSyncOutcomeRow {
  id: string;
  user_id: string | null;
  created_at: string;
  outcome: string;
  elapsed_ms: number | null;
  run_kind?: string | null;
  source_metrics?: unknown;
}

export type EpRunKind = 'cache' | 're-cache' | 'force';

export const EP_RUN_KINDS: { kind: EpRunKind; label: string; countLabel: string }[] = [
  { kind: 'cache', label: 'First sync', countLabel: 'emails fetched (whole window)' },
  { kind: 're-cache', label: 'Incremental sync', countLabel: 'new messages fetched' },
  { kind: 'force', label: 'Forced re-sync', countLabel: 'emails fetched (whole window)' },
];

export interface EpBucket {
  key: string;
  label: string;
  /** Inclusive lower bound; null for the "not recorded" bucket. */
  min: number | null;
  /** Inclusive upper bound; null = no upper bound. */
  max: number | null;
}

export const EP_BUCKETS: EpBucket[] = [
  { key: '0', label: '0', min: 0, max: 0 },
  { key: '1-99', label: '1–99', min: 1, max: 99 },
  { key: '100-999', label: '100–999', min: 100, max: 999 },
  { key: '1k-9999', label: '1,000–9,999', min: 1000, max: 9999 },
  { key: '10k+', label: '10,000+', min: 10000, max: null },
  { key: 'unknown', label: 'Not recorded', min: null, max: null },
];

export interface EpCell {
  /** Completed runs in this cell — the sample every number below is over. */
  n: number;
  minMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  maxMs: number | null;
}

export interface EpKindSummary {
  kind: EpRunKind;
  label: string;
  countLabel: string;
  total: number;
  complete: number;
  error: number;
  cancelled: number;
  /** Incremental runs that also fetched a widened window's older mail. */
  backfilled: number;
  cells: Record<string, EpCell>;
}

export interface EpReportModel {
  /** Rows read (all outcomes, all kinds). */
  totalRuns: number;
  /** Rows whose run_kind is not one of the three (older or malformed). */
  unknownKind: number;
  kinds: EpKindSummary[];
}

function metricsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** A finite number >= 0, or null ("not recorded"). */
export function readCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function bucketFor(checked: number | null): string {
  if (checked === null) return 'unknown';
  for (const b of EP_BUCKETS) {
    if (b.min === null) continue;
    if (checked >= b.min && (b.max === null || checked <= b.max)) return b.key;
  }
  return 'unknown';
}

function cellOf(durations: number[]): EpCell {
  if (durations.length === 0) return { n: 0, minMs: null, medianMs: null, p90Ms: null, maxMs: null };
  return {
    n: durations.length,
    minMs: Math.min(...durations),
    medianMs: median(durations),
    p90Ms: percentileNearestRank(durations, 90),
    maxMs: Math.max(...durations),
  };
}

export function buildEmailPrecacheReport(rows: EpSyncOutcomeRow[]): EpReportModel {
  let unknownKind = 0;
  const kinds = EP_RUN_KINDS.map(({ kind, label, countLabel }) => {
    const ofKind = rows.filter((r) => r.run_kind === kind);
    const byBucket = new Map<string, number[]>(EP_BUCKETS.map((b) => [b.key, []]));
    let backfilled = 0;
    for (const r of ofKind) {
      const m = metricsOf(r.source_metrics);
      if (m.backfill === true) backfilled += 1;
      if (r.outcome !== 'complete') continue;
      const ms = readCount(r.elapsed_ms);
      if (ms === null) continue;
      byBucket.get(bucketFor(readCount(m.checked)))!.push(ms);
    }
    const cells: Record<string, EpCell> = {};
    for (const b of EP_BUCKETS) cells[b.key] = cellOf(byBucket.get(b.key)!);
    return {
      kind,
      label,
      countLabel,
      total: ofKind.length,
      complete: ofKind.filter((r) => r.outcome === 'complete').length,
      error: ofKind.filter((r) => r.outcome === 'error').length,
      cancelled: ofKind.filter((r) => r.outcome === 'cancelled').length,
      backfilled,
      cells,
    };
  });
  for (const r of rows) if (!EP_RUN_KINDS.some((k) => k.kind === r.run_kind)) unknownKind += 1;
  return { totalRuns: rows.length, unknownKind, kinds };
}
