/**
 * Google Messages Sync Performance — the run model (BACKLOG-3671 P2).
 *
 * Built from sync_outcomes rows with source 'google-messages'. Their
 * per-stage numbers are in `source_metrics` (written by the desktop app's
 * buildRcsSourceMetrics — counts, ms, codes only). EVERY read here is
 * null-tolerant: a row without source_metrics (an older build, a dropped
 * write, a migration not yet applied), a non-object, a missing stage or a
 * non-number all read as "not recorded" — never as zero.
 *
 * Pure: no Supabase, no React. The page and its tests share it.
 */

import { formatCount, formatDuration, formatUtc, IN_PROGRESS_OUTCOME, outcomeTone, userLabelFor } from './iphone-sync';
import type { OutcomeTone, ReportUser, SyncOutcomeRow } from './iphone-sync';
import { gmReasonLine } from './gm-failure-lines';

export const GM_SOURCE = 'google-messages';
/** Columns this report reads beyond the shared ones (BACKLOG-3671 P2 migration). */
export const GM_EXTRA_COLUMNS = ['source_metrics', 'run_kind', 'extension_version', 'chrome_version'] as const;

export interface GmSyncOutcomeRow extends SyncOutcomeRow {
  source_metrics?: unknown;
  run_kind?: string | null;
  extension_version?: string | null;
  chrome_version?: string | null;
}

export const GM_RUN_KIND_LABELS: Record<string, string> = {
  sync: 'sync',
  retry: 'try again',
  older: 'older texts',
  transaction: 'transaction',
};
export const GM_RUN_KIND_OPTIONS = Object.entries(GM_RUN_KIND_LABELS).map(([value, label]) => ({ value, label }));

export interface GmStage {
  ms: number | null;
}
export interface GmFinding extends GmStage {
  chatsFound: number | null;
  chatsInRange: number | null;
  chatsSkippedHidden: number | null;
  chatsSkippedDisabled: number | null;
}
export interface GmReading extends GmStage {
  chatsRead: number | null;
  chatsSkipped: number | null;
  chatsFailed: number | null;
  chatsAlreadySaved: number | null;
  messagesRead: number | null;
  photosRead: number | null;
  bytesRead: number | null;
  perChatP50Ms: number | null;
  perChatP90Ms: number | null;
  perChatSlowestMs: number | null;
  /** Chats opened and finished with (any result): the per-chat times' sample. ≥ chatsRead. */
  chatsOpened: number | null;
  /** Live A/B (extension 0.3.79+): the run's step totals (ms); null on older rows. */
  detailsMs: number | null;
  historyMs: number | null;
  settleMs: number | null;
  commitMs: number | null;
  photoReadMs: number | null;
  photoUploadMs: number | null;
  photoReadMaxMs: number | null;
  photoUploadMaxMs: number | null;
}
export interface GmSaving extends GmStage {
  messagesSaved: number | null;
  messagesNew: number | null;
  photosSaved: number | null;
  bytesSaved: number | null;
}

export interface GmSyncRun {
  id: string;
  createdAtIso: string;
  whenUtc: string;
  userLabel: string;
  outcome: string;
  outcomeTone: OutcomeTone;
  elapsedMs: number | null;
  durationLabel: string;
  /** Always false: the stall rule is the iPhone transfer's (charts read it). */
  stalled: boolean;
  platform: string;
  appVersion: string;
  extensionVersion: string;
  chromeVersion: string;
  isDevBuild: boolean;
  /** '' when not recorded. */
  runKind: string;
  runKindLabel: string;
  /** Chats read (else the chats saved / found). */
  chats: number | null;
  /** Messages saved (else read). */
  messages: number | null;
  /** Time the Messages tab was hidden, as a % of the run. */
  hiddenPct: number | null;
  /** The hidden time itself (ms) and how many times it was hidden. */
  hiddenMs: number | null;
  hiddenSpells: number | null;
  perChatP90Ms: number | null;
  reasonCode: string | null;
  reasonLine: string | null;
  finding: GmFinding;
  reading: GmReading;
  saving: GmSaving;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
function text(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function parseGmMetrics(raw: unknown): { finding: GmFinding; reading: GmReading; saving: GmSaving; end: Record<string, unknown>; runKind: string | null } {
  const m = obj(raw);
  const f = obj(m.finding);
  const r = obj(m.reading);
  const s = obj(m.saving);
  return {
    runKind: text(m.run_kind),
    end: obj(m.end),
    finding: {
      ms: num(f.ms),
      chatsFound: num(f.chats_found),
      chatsInRange: num(f.chats_in_range),
      chatsSkippedHidden: num(f.chats_skipped_hidden),
      chatsSkippedDisabled: num(f.chats_skipped_disabled),
    },
    reading: {
      ms: num(r.ms),
      chatsRead: num(r.chats_read),
      chatsSkipped: num(r.chats_skipped),
      chatsFailed: num(r.chats_failed),
      chatsAlreadySaved: num(r.chats_already_saved),
      messagesRead: num(r.messages_read),
      photosRead: num(r.photos_read),
      bytesRead: num(r.bytes_read),
      perChatP50Ms: num(r.per_chat_p50_ms),
      perChatP90Ms: num(r.per_chat_p90_ms),
      perChatSlowestMs: num(r.per_chat_slowest_ms),
      // per_chat_count: the same number under its first name (rows before the rename).
      chatsOpened: num(r.chats_opened) ?? num(r.per_chat_count),
      detailsMs: num(r.details_ms),
      historyMs: num(r.history_ms),
      settleMs: num(r.settle_ms),
      commitMs: num(r.commit_ms),
      photoReadMs: num(r.photo_read_ms),
      photoUploadMs: num(r.photo_upload_ms),
      photoReadMaxMs: num(r.photo_read_max_ms),
      photoUploadMaxMs: num(r.photo_upload_max_ms),
    },
    saving: {
      ms: num(s.ms),
      messagesSaved: num(s.messages_saved),
      messagesNew: num(s.messages_new),
      photosSaved: num(s.photos_saved),
      bytesSaved: num(s.bytes_saved),
    },
  };
}

export function buildGmRun(row: GmSyncOutcomeRow, users: Map<string, ReportUser>): GmSyncRun {
  const m = parseGmMetrics(row.source_metrics);
  const runKind = text(row.run_kind) ?? m.runKind ?? '';
  const hiddenMs = num(m.end.hidden_ms);
  const elapsed = num(row.elapsed_ms);
  const reasonCode = text(row.reason_code) ?? text(m.end.reason_code);
  return {
    id: row.id,
    createdAtIso: row.created_at,
    whenUtc: formatUtc(row.created_at),
    userLabel: userLabelFor(row.user_id, users),
    outcome: row.outcome,
    outcomeTone: outcomeTone(row.outcome),
    elapsedMs: elapsed,
    durationLabel: formatDuration(elapsed),
    stalled: false,
    platform: row.platform ?? 'unknown',
    appVersion: row.app_version ?? 'unknown',
    extensionVersion: text(row.extension_version) ?? '—',
    chromeVersion: text(row.chrome_version) ?? '—',
    isDevBuild: row.is_packaged === false,
    runKind,
    runKindLabel: runKind ? (GM_RUN_KIND_LABELS[runKind] ?? runKind) : 'not recorded',
    chats: m.reading.chatsRead ?? m.finding.chatsInRange,
    messages: m.saving.messagesSaved ?? m.reading.messagesRead,
    hiddenPct: hiddenMs !== null && elapsed !== null && elapsed > 0 ? Math.min(100, Math.round((hiddenMs / elapsed) * 100)) : null,
    hiddenMs,
    hiddenSpells: num(m.end.hidden_spells),
    perChatP90Ms: m.reading.perChatP90Ms,
    reasonCode: row.outcome === 'complete' ? null : reasonCode,
    reasonLine: row.outcome === 'complete' ? null : gmReasonLine(reasonCode),
    finding: m.finding,
    reading: m.reading,
    saving: m.saving,
  };
}

export interface GmFailureBreakdownRow {
  code: string;
  line: string;
  runs: number;
}

export interface GmSyncReportModel {
  runs: GmSyncRun[];
  failures: GmFailureBreakdownRow[];
}

/** Finished runs only (a running row is not a result yet). */
export function buildGoogleMessagesSyncReport(rows: GmSyncOutcomeRow[], users: ReportUser[]): GmSyncReportModel {
  const userMap = new Map(users.map((u) => [u.id, u]));
  const runs = rows.filter((r) => r.outcome !== IN_PROGRESS_OUTCOME).map((r) => buildGmRun(r, userMap));
  return { runs, failures: failureBreakdown(runs) };
}

/** Failed / stopped runs by reason code, most first; the short line the user saw. */
export function failureBreakdown(runs: GmSyncRun[]): GmFailureBreakdownRow[] {
  const by = new Map<string, number>();
  for (const r of runs) {
    if (r.outcome === 'complete') continue;
    const code = r.reasonCode ?? 'not_recorded';
    by.set(code, (by.get(code) ?? 0) + 1);
  }
  return [...by.entries()]
    .map(([code, n]) => ({ code, line: code === 'not_recorded' ? 'Not recorded' : (gmReasonLine(code) as string), runs: n }))
    .sort((a, b) => b.runs - a.runs || a.code.localeCompare(b.code));
}

// ─── Filters and sorting (the same shape as the iPhone report's) ──

export interface GmFilters {
  types: string[];
  outcomes: string[];
  platforms: string[];
  search: string;
}
export const GM_EMPTY_FILTERS: GmFilters = { types: [], outcomes: [], platforms: [], search: '' };

export function applyGmFilters(runs: GmSyncRun[], filters: GmFilters): GmSyncRun[] {
  const needle = filters.search.trim().toLowerCase();
  return runs.filter((run) => {
    if (filters.types.length > 0 && !filters.types.includes(run.runKind)) return false;
    if (filters.outcomes.length > 0 && !filters.outcomes.includes(run.outcome)) return false;
    if (filters.platforms.length > 0 && !filters.platforms.includes(run.platform)) return false;
    if (needle.length > 0 && !run.userLabel.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export type GmSortKey = 'when' | 'user' | 'version' | 'outcome' | 'duration' | 'chats' | 'messages' | 'hidden' | 'p90' | 'failure';

export const GM_SORT_SPECS: Record<GmSortKey, { label: string; numeric: boolean; value: (r: GmSyncRun) => number | string | null }> = {
  when: { label: 'When', numeric: true, value: (r) => Date.parse(r.createdAtIso) },
  user: { label: 'User', numeric: false, value: (r) => r.userLabel },
  version: { label: 'Version', numeric: false, value: (r) => r.appVersion },
  outcome: { label: 'Outcome', numeric: false, value: (r) => r.outcome },
  duration: { label: 'Duration', numeric: true, value: (r) => r.elapsedMs },
  chats: { label: 'Chats', numeric: true, value: (r) => r.chats },
  messages: { label: 'Messages', numeric: true, value: (r) => r.messages },
  hidden: { label: 'Hidden %', numeric: true, value: (r) => r.hiddenPct },
  p90: { label: 'p90 per chat', numeric: true, value: (r) => r.perChatP90Ms },
  failure: { label: 'Failure code', numeric: false, value: (r) => r.reasonCode },
};

/** Nulls last in both directions; ties newest first (as the iPhone report). */
export function sortGmRuns(runs: GmSyncRun[], key: GmSortKey, direction: 'asc' | 'desc'): GmSyncRun[] {
  const spec = GM_SORT_SPECS[key];
  const sign = direction === 'asc' ? 1 : -1;
  return [...runs].sort((a, b) => {
    const av = spec.value(a);
    const bv = spec.value(b);
    const aNull = av == null || (typeof av === 'number' && Number.isNaN(av));
    const bNull = bv == null || (typeof bv === 'number' && Number.isNaN(bv));
    if (aNull && bNull) return Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso);
    if (aNull) return 1;
    if (bNull) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return cmp !== 0 ? cmp * sign : Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso);
  });
}

// ─── Labels ──────────────────────────────────────────────────────

export function msLabel(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms);
}
/** A step time an older run did not record. */
export function recordedMsLabel(ms: number | null): string {
  return ms === null ? 'not recorded' : msLabel(ms);
}
export function countLabel(n: number | null): string {
  return n === null ? '—' : formatCount(n);
}
/** Bytes → "12.3 MB" (MiB, as the iPhone report's MB). */
export function mbLabel(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
