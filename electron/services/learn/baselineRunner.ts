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
  listDealContactEmails,
  type LearnEmailRow,
} from "../db/learnModeDbService";
import { LEARN_RULES } from "./learnRules";
import { addressKey } from "./dealMatcher";
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../../utils/senderFilter/bundledRules";
import {
  buildKeepSets,
  decide,
  isSignalLive,
  matchesExactAddress,
  storedFilterRow,
  type KeepRuleId,
  type KeepSets,
} from "../../utils/senderFilter/senderFilter";

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
  /**
   * The subset of `emailIds` whose From address is an exact sender seed
   * (BACKLOG-4175). Main memory only, like `emailIds`. Nothing is dropped
   * from the run: baseline 0 sees every row.
   */
  seedEmailIds: string[];
  /**
   * The subset of `emailIds` a LIVE sender signal suppresses on the Learn
   * questions surface (BACKLOG-4175). A detection is hidden from the cleanup
   * pass when this covers every message; a mixed detection's preview leaves
   * these out. Main memory only.
   */
  hiddenEmailIds: string[];
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
  /**
   * Sender rules version used for `seedEmailIds`, and whether the seed signal
   * is live for Learn questions (hides all-seed detections) or measure-only.
   */
  senderRulesVersion: number;
  seedHidesQuestions: boolean;
  /**
   * BACKLOG-4175: the same run with every message the sender filter would
   * suppress (measure or live) left out before grouping — once with the full
   * precedence, once without the contact keep rules K1 and K3. Detections are
   * built from the unfiltered run; these exist for the loss metrics only.
   */
  filtered: { full: FilteredDetection[]; minusContactKeeps: FilteredDetection[] };
  /** BACKLOG-4175: per-row sender filter counts over the scanned rows (aggregates only). */
  senderStats: SenderRunStats;
}

/** A detection of a filtered run: what the loss metrics compare on. */
export interface FilteredDetection {
  address: string;
  firstMs: number;
  lastMs: number;
}

export type ProviderBucket = "gmail" | "outlook" | "unknown";

export interface SenderRunStats {
  /** Messages a keep rule saved from a suppress signal, per keep rule. */
  keptBy: Record<KeepRuleId, number>;
  /** Exact-address matches that a keep rule would otherwise have kept. */
  keepConflicts: number;
  /** Scanned rows per provider with stored bulk headers / labels. */
  coverage: Record<ProviderBucket, { rows: number; headers: number; labels: number }>;
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
  /** Sender rules (BACKLOG-4175). Defaults to the bundled set. */
  senderRules?: SenderRuleSet;
  /** Keep sets (K1/K3). Defaults to the contacts on the user's non-rejected deals. */
  keepSets?: KeepSets;
}

function providerOf(source: string | null): ProviderBucket {
  return source === "gmail" || source === "outlook" ? source : "unknown";
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
  const senderRules = options.senderRules ?? BUNDLED_SENDER_RULES;
  const seedEvaluated = senderRules.modes.seedAddress.learnQuestions !== "off";
  const seedIds = new Set<string>();
  const keep = options.keepSets ?? buildKeepSets(listDealContactEmails(userId), senderRules);
  const hiddenIds = new Set<string>();
  const suppressedFull = new Set<string>();
  const suppressedMinus = new Set<string>();
  const stats: SenderRunStats = {
    keptBy: { K1: 0, K2: 0, K3: 0 },
    keepConflicts: 0,
    coverage: {
      gmail: { rows: 0, headers: 0, labels: 0 },
      outlook: { rows: 0, headers: 0, labels: 0 },
      unknown: { rows: 0, headers: 0, labels: 0 },
    },
  };

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
    for (const row of rows) {
      if (seedEvaluated && matchesExactAddress(row.sender, senderRules)) seedIds.add(row.id);
      const fr = storedFilterRow(row);
      const full = decide(fr, senderRules, "learnQuestions", keep);
      if (full.outcome === "suppress") {
        suppressedFull.add(row.id);
        if (full.live) hiddenIds.add(row.id);
        if (full.keepConflict) stats.keepConflicts += 1;
      } else if (full.outcome === "keep") {
        stats.keptBy[full.rule as KeepRuleId] += 1;
      }
      if (decide(fr, senderRules, "learnQuestions", keep, { withoutContactKeeps: true }).outcome === "suppress") {
        suppressedMinus.add(row.id);
      }
      const cov = stats.coverage[providerOf(row.source)];
      cov.rows += 1;
      if (row.bulk_mail_headers !== null) cov.headers += 1;
      if (row.labels !== null) cov.labels += 1;
    }

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
    const emailIds = group.map((g) => emailIdOf.get(g)).filter((id): id is string => typeof id === "string");
    return {
      id: `d${i + 1}`,
      address,
      addressKey: addressKey(address),
      firstMs: times.length ? Math.min(...times) : Number.NaN,
      lastMs: times.length ? Math.max(...times) : Number.NaN,
      emailCount: group.length,
      emailIds,
      seedEmailIds: emailIds.filter((id) => seedIds.has(id)),
      hiddenEmailIds: emailIds.filter((id) => hiddenIds.has(id)),
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
    senderRulesVersion: senderRules.version,
    seedHidesQuestions: isSignalLive(senderRules, "seedAddress", "learnQuestions"),
    filtered: {
      full: filteredDetections(realEstate.filter((a) => !suppressedFull.has(emailIdOf.get(a) ?? ""))),
      minusContactKeeps: filteredDetections(realEstate.filter((a) => !suppressedMinus.has(emailIdOf.get(a) ?? ""))),
    },
    senderStats: stats,
  };
}

function filteredDetections(results: AnalysisResult[]): FilteredDetection[] {
  return Object.entries(transactionExtractorService.groupByProperty(results)).map(([address, group]) => {
    const times = group.map((g) => dateMs(g.date)).filter(Number.isFinite);
    return {
      address,
      firstMs: times.length ? Math.min(...times) : Number.NaN,
      lastMs: times.length ? Math.max(...times) : Number.NaN,
    };
  });
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
