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
 * release containing the fix: tag v2.33.0, commit 61e0d4df8, committed
 * 2026-08-31T01:20:25-06:00 = 2026-08-31T07:20:25Z. A 'manual' row created
 * before this instant is not provably hand-entered. This is a lower bound: a
 * user who upgraded later keeps auto-detected 'manual' rows past it.
 */
export const AUTO_DETECT_PROVENANCE_CUTOFF_MS = Date.UTC(2026, 7, 31, 7, 20, 25);

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
   * A 'manual' row created before the auto-detect provenance fix shipped
   * (see AUTO_DETECT_PROVENANCE_CUTOFF_MS). It may be the detector's own old
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
    buckets: { manual: 0, auto: 0, hybrid: 0, rejected: 0 },
    labelsWithoutLocalMail: 0,
  };
  for (const row of rows) {
    const bucket = bucketOf(row);
    key.buckets[bucket] += 1;
    const created = createdAtMs(row.created_at);
    const keyed: KeyedTransaction = {
      ...row,
      legacyManual: bucket === "manual" && created !== null && created < AUTO_DETECT_PROVENANCE_CUTOFF_MS,
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
