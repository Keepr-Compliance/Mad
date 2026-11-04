/**
 * Baseline 0 over LOCAL mail — BACKLOG-4120.
 *
 * Runs the old rules (`analyzeEmail` + `groupByProperty`) over the user's
 * cached `emails` rows, mirroring `_patternOnlyExtraction`
 * (transactionService.ts) field for field. It does NOT call
 * scanAndExtractTransactions, any provider fetch, the hybrid/LLM extractor, or
 * isAutoDetectAllowed, and it writes nothing: the result lives in memory.
 *
 * Window: `computeEmailCacheSinceDate(windowMonths)` with windowMonths taken
 * from the request (SR R2), never from the cloud preference.
 *
 * Paging: keyset `(sent_at, id) > (?, ?)` pages on idx_emails_user_sent, one
 * yield to the event loop between pages (SR R5/R7). NULL sent_at rows are
 * counted and left out.
 *
 * Privacy: the PUBLIC summary (`toPublicRunSummary`) and every progress event
 * carry ids and counts only. Addresses stay in the in-memory result for the
 * cleanup pass.
 */
import crypto from "crypto";
import transactionExtractorService, { type AnalysisResult } from "../transactionExtractorService";
import { computeEmailCacheSinceDate } from "../../utils/preferenceHelper";
import {
  countNullSentAt,
  emailKeysetPage,
  type LearnEmailRow,
} from "../db/learnModeDbService";
import { LEARN_RULES } from "./learnRules";
import { addressKey } from "./dealMatcher";

export interface LearnDetection {
  /** "d1", "d2", ... stable within one run. */
  id: string;
  /** groupByProperty's key. Stays in main; never in the public summary. */
  address: string;
  addressKey: string | null;
  firstMs: number;
  lastMs: number;
  emailCount: number;
  /**
   * Local `emails.id` of every message in the group, oldest first. Main
   * memory only (for the preview channel's membership check); never in the
   * public summary and never persisted (C12: nothing durable keys on emails.id).
   */
  emailIds: string[];
  /** From the group's first typed email, as generateTransactionSummary does. */
  side: "buyer" | "seller" | null;
}

export interface LearnRunResult {
  runId: string;
  ruleVersion: number;
  windowMonths: number;
  sinceIso: string;
  rowsScanned: number;
  nullSentAt: number;
  realEstateCount: number;
  pages: number;
  /** First / last scanned sent_at (ms); null when nothing was scanned. */
  firstMs: number | null;
  lastMs: number | null;
  detections: LearnDetection[];
}

export interface LearnRunProgress {
  runId: string;
  pagesDone: number;
  rowsScanned: number;
}

export interface PublicRunSummary {
  runId: string;
  ruleVersion: number;
  windowMonths: number;
  rowsScanned: number;
  nullSentAt: number;
  realEstateCount: number;
  earliestDay: string | null;
  latestDay: string | null;
  detectionCount: number;
  detectionIds: string[];
}

export interface RunOptions {
  /** Yield to the event loop between pages. Injected for C8. */
  yieldFn?: () => Promise<void>;
  onProgress?: (p: LearnRunProgress) => void;
  /** Hard stop on pages; exceeded = error (a cursor that never ends). */
  maxPages?: number;
  nowMs?: number;
  pageSize?: number;
}

export class LearnRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearnRunError";
  }
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function validateWindowMonths(windowMonths: unknown): number {
  if (
    typeof windowMonths !== "number" ||
    !Number.isInteger(windowMonths) ||
    windowMonths < LEARN_RULES.windowMonthsMin ||
    windowMonths > LEARN_RULES.windowMonthsMax
  ) {
    throw new LearnRunError("windowMonths out of range");
  }
  return windowMonths;
}

/** Field mapping of _patternOnlyExtraction for a local row (no snippet column). */
export function toExtractorEmail(row: LearnEmailRow): {
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  bodyPlain?: string;
  snippet?: string;
  date: string;
} {
  return {
    subject: row.subject || undefined,
    from: row.sender || undefined,
    to: row.recipients || undefined,
    body: row.body_html ?? undefined,
    bodyPlain: row.body_plain ?? undefined,
    snippet: undefined,
    date: row.sent_at,
  };
}

function dateMs(d: string | Date): number {
  return (d instanceof Date ? d : new Date(d)).getTime();
}

function toDay(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

export async function runBaseline0(
  userId: string,
  windowMonthsInput: unknown,
  options: RunOptions = {},
): Promise<LearnRunResult> {
  const windowMonths = validateWindowMonths(windowMonthsInput);
  const yieldFn = options.yieldFn ?? defaultYield;
  const pageSize = options.pageSize ?? LEARN_RULES.scanPageSize;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  const sinceIso = computeEmailCacheSinceDate(windowMonths, options.nowMs ?? Date.now()).toISOString();
  const runId = crypto.randomUUID();

  let cursor = { sentAt: "", id: "" };
  let rowsScanned = 0;
  let pages = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const realEstate: AnalysisResult[] = [];
  // batchAnalyze maps 1:1 in order and groupByProperty keeps the same objects,
  // so each analysis result can be traced back to its local row.
  const emailIdOf = new Map<AnalysisResult, string>();

  for (;;) {
    const rows = emailKeysetPage(userId, sinceIso, cursor, pageSize);
    if (rows.length === 0) break;
    pages += 1;
    if (pages > maxPages) throw new LearnRunError("page limit exceeded");

    const last = rows[rows.length - 1];
    if (last.sent_at === cursor.sentAt && last.id === cursor.id) {
      throw new LearnRunError("keyset cursor did not advance");
    }
    cursor = { sentAt: last.sent_at, id: last.id };
    rowsScanned += rows.length;

    const analyzed = transactionExtractorService.batchAnalyze(rows.map(toExtractorEmail));
    analyzed.forEach((a, i) => emailIdOf.set(a, rows[i].id));
    for (const a of analyzed) {
      const ms = dateMs(a.date);
      if (Number.isFinite(ms)) {
        if (firstMs === null || ms < firstMs) firstMs = ms;
        if (lastMs === null || ms > lastMs) lastMs = ms;
      }
      if (a.isRealEstateRelated) realEstate.push(a);
    }

    options.onProgress?.({ runId, pagesDone: pages, rowsScanned });
    await yieldFn();
  }

  const grouped = transactionExtractorService.groupByProperty(realEstate);
  const detections: LearnDetection[] = Object.entries(grouped).map(([address, group], i) => {
    const times = group.map((g) => dateMs(g.date)).filter(Number.isFinite);
    const type = group.map((g) => g.transactionType).find(Boolean) ?? null;
    return {
      id: `d${i + 1}`,
      address,
      addressKey: addressKey(address),
      firstMs: times.length ? Math.min(...times) : Number.NaN,
      lastMs: times.length ? Math.max(...times) : Number.NaN,
      emailCount: group.length,
      emailIds: group.map((g) => emailIdOf.get(g)).filter((id): id is string => typeof id === "string"),
      side: type ? (LEARN_RULES.sideByDetectedType[type] ?? null) : null,
    };
  });

  return {
    runId,
    ruleVersion: LEARN_RULES.version,
    windowMonths,
    sinceIso,
    rowsScanned,
    nullSentAt: countNullSentAt(userId),
    realEstateCount: realEstate.length,
    pages,
    firstMs,
    lastMs,
    detections,
  };
}

/** What may leave main: ids and counts only. */
export function toPublicRunSummary(r: LearnRunResult): PublicRunSummary {
  return {
    runId: r.runId,
    ruleVersion: r.ruleVersion,
    windowMonths: r.windowMonths,
    rowsScanned: r.rowsScanned,
    nullSentAt: r.nullSentAt,
    realEstateCount: r.realEstateCount,
    earliestDay: toDay(r.firstMs),
    latestDay: toDay(r.lastMs),
    detectionCount: r.detections.length,
    detectionIds: r.detections.map((d) => d.id),
  };
}

// ---- last run, in memory only (R6: no runs table) --------------------------

const lastRuns = new Map<string, LearnRunResult>();

export function setLastRun(userId: string, result: LearnRunResult): void {
  lastRuns.set(userId, result);
}

export function getLastRun(userId: string): LearnRunResult | null {
  return lastRuns.get(userId) ?? null;
}

export function clearLastRun(userId: string): void {
  lastRuns.delete(userId);
}
