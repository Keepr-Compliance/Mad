/**
 * Answer key for Learn mode scoring — BACKLOG-4120 (SR 1ec75158 changes 1-3).
 *
 * Positives = hand-entered transactions only: detection_source 'manual' and
 * neither status nor detection_status 'rejected'. auto / hybrid rows were
 * made by the baseline-0 detector itself, so they are never positives (that
 * would score the detector against its own output). A 'rejected' row of any
 * source is a known negative.
 *
 * Pure: takes rows, returns the classified key.
 */
import type { AnswerKeyRow } from "../db/learnModeDbService";
import { LEARN_RULES } from "./learnRules";
import { overlapsWindow } from "./dealMatcher";

/**
 * Auto-detected deals were stored as detection_source 'manual' until
 * BACKLOG-2737 (commit 8f235e22c, "writer declares an exhaustive column
 * policy"): before it, createTransactionSync wrote a fixed 13-column INSERT
 * with no detection_* columns, so the schema default 'manual' won. First
 * DESKTOP release containing the fix (a companion tag, v1.1.0-companion,
 * also contains it): tag v2.33.0, commit 61e0d4df8, committed
 * 2026-08-31T01:20:25-06:00 = 2026-08-31T07:20:25Z. A 'manual' row created
 * before this instant is not provably hand-entered. This is a lower bound: a
 * user who upgraded later keeps auto-detected 'manual' rows past it.
 */
export const AUTO_DETECT_PROVENANCE_CUTOFF_MS = Date.UTC(2026, 7, 31, 7, 20, 25);

/**
 * The cutoff for ONE user (SR 45eea66c, carried to PR2): the later of the
 * global cutoff and the creation time of the user's earliest stored
 * auto/hybrid row. A stored 'auto' or 'hybrid' value proves the fix was
 * installed on this machine by then, so a 'manual' row created after it is
 * hand-entered; one created before it may be the detector's own old output.
 *
 * The raw detection_source column is read, not the bucket: a REJECTED auto
 * row still proves the fix was installed.
 *
 * With no auto/hybrid row there is no such proof, the global cutoff applies,
 * and the legacy count is a MINIMUM (a user who upgraded later keeps
 * auto-detected 'manual' rows past it).
 */
export function legacyCutoffFor(rows: AnswerKeyRow[]): { cutoffMs: number; isMinimum: boolean } {
  let firstAuto: number | null = null;
  for (const row of rows) {
    if (row.detection_source !== "auto" && row.detection_source !== "hybrid") continue;
    const created = createdAtMs(row.created_at);
    if (created !== null && (firstAuto === null || created < firstAuto)) firstAuto = created;
  }
  if (firstAuto === null) return { cutoffMs: AUTO_DETECT_PROVENANCE_CUTOFF_MS, isMinimum: true };
  return { cutoffMs: Math.max(AUTO_DETECT_PROVENANCE_CUTOFF_MS, firstAuto), isMinimum: false };
}

/** created_at as ms: SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) or ISO. Null = unknown. */
export function createdAtMs(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(createdAt);
  const ms = Date.parse(hasZone ? createdAt : `${createdAt.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export type AnswerKeyBucket = "manual" | "auto" | "hybrid" | "rejected";

export interface KeyedTransaction extends AnswerKeyRow {
  bucket: AnswerKeyBucket;
  /** buyer / seller, or null when transaction_type does not map (skipped). */
  side: "buyer" | "seller" | null;
  /** closed / active / pending, or null when status does not map. */
  outcome: "closed" | "active" | "pending" | null;
  /**
   * A 'manual' row created before this user's cutoff (legacyCutoffFor). It may be the detector's own old
   * output, so scores are reported with and without it.
   */
  legacyManual: boolean;
}

export interface AnswerKey {
  positives: KeyedTransaction[];
  negatives: KeyedTransaction[];
  /** auto / hybrid rows that are not rejected: neither positive nor negative. */
  neutral: KeyedTransaction[];
  /** Positives that are legacyManual (a subset of `positives`). */
  legacyManualPositives: number;
  /** The cutoff used for this user (see legacyCutoffFor). */
  legacyCutoffMs: number;
  /** True when no auto/hybrid row proved the upgrade time: the legacy count is a minimum. */
  legacyCutoffIsMinimum: boolean;
  /** Rows per bucket, before the window filter. */
  buckets: Record<AnswerKeyBucket, number>;
  /** Positives and negatives left out because they do not overlap the scanned window. */
  labelsWithoutLocalMail: number;
}

export function bucketOf(row: AnswerKeyRow): AnswerKeyBucket {
  if (row.status === "rejected" || row.detection_status === "rejected") return "rejected";
  if (row.detection_source === "auto") return "auto";
  if (row.detection_source === "hybrid") return "hybrid";
  return "manual";
}

export function sideOf(transactionType: string | null): "buyer" | "seller" | null {
  if (!transactionType) return null;
  return LEARN_RULES.sideByTransactionType[transactionType] ?? null;
}

export function outcomeOf(status: string | null): "closed" | "active" | "pending" | null {
  if (!status) return null;
  return LEARN_RULES.outcomeByStatus[status] ?? null;
}

/**
 * Classify rows. `scanned` is the first..last scanned email time (ms); a
 * labelled row whose window does not overlap it is left out and counted.
 * `scanned` null (no mail scanned) leaves every label out.
 */
export function buildAnswerKey(
  rows: AnswerKeyRow[],
  scanned: { firstMs: number; lastMs: number } | null,
): AnswerKey {
  const key: AnswerKey = {
    positives: [],
    negatives: [],
    neutral: [],
    legacyManualPositives: 0,
    legacyCutoffMs: AUTO_DETECT_PROVENANCE_CUTOFF_MS,
    legacyCutoffIsMinimum: true,
    buckets: { manual: 0, auto: 0, hybrid: 0, rejected: 0 },
    labelsWithoutLocalMail: 0,
  };
  const cutoff = legacyCutoffFor(rows);
  key.legacyCutoffMs = cutoff.cutoffMs;
  key.legacyCutoffIsMinimum = cutoff.isMinimum;
  for (const row of rows) {
    const bucket = bucketOf(row);
    key.buckets[bucket] += 1;
    const created = createdAtMs(row.created_at);
    const keyed: KeyedTransaction = {
      ...row,
      legacyManual: bucket === "manual" && created !== null && created < cutoff.cutoffMs,
      bucket,
      side: sideOf(row.transaction_type),
      outcome: outcomeOf(row.status),
    };
    if (bucket === "auto" || bucket === "hybrid") {
      key.neutral.push(keyed);
      continue;
    }
    const inWindow =
      scanned !== null && overlapsWindow(scanned.firstMs, scanned.lastMs, row.started_at, row.closed_at);
    if (!inWindow) {
      key.labelsWithoutLocalMail += 1;
      continue;
    }
    if (bucket === "manual") {
      key.positives.push(keyed);
      if (keyed.legacyManual) key.legacyManualPositives += 1;
    } else key.negatives.push(keyed);
  }
  return key;
}
