/**
 * BACKLOG-3892 S5 — "Get older texts": fill one deal's iPhone start gap from the backup
 * kept on this computer, with no phone connected. Offered, never automatic (founder
 * f1ce5cce). The UI that starts it is S6.
 *
 * WHAT IT READS
 *  - Only the deal's people: its contacts' handles and (current phone) its linked
 *    chats, through a one-deal ChatFloorPlan whose settings floor is the ceiling, so a
 *    chat with none of the deal's people is never read.
 *  - Only the missing range: [floor, ceiling). floor = the deal floor (audit start − 24 h)
 *    but never before the phone's oldest text (the new-phone cap, W3b); ceiling = where
 *    the deal's coverage on that phone starts today. Dated rows only (a floored sync has
 *    already read the undated ones).
 *
 * AT REST (BACKLOG-3816)
 *  - The kept chain is never unsealed and its marker never written: BackupAtRest.beginRead
 *    claims the phone and buildParseCopy decrypts what is read into a parse copy (the
 *    sync's own temp area: swept at quit and at launch). sms.db first; then only the
 *    attachment files of the texts that were read. The phone's lock is held only while
 *    copying; a sync that starts stops the copy at the next file.
 *  - The parse copy is cleared on every end (stored, cancelled, refused, thrown).
 *
 * STORED
 *  - persistSyncResult with no coverage context (last_sync_at never moves), its own
 *    session id (a cancel rolls back) and the existing guid dedupe (a re-run stores
 *    nothing twice). Contacts are never stored from an old backup.
 *  - Coverage only after a stored run with no failed read: recordIphoneBackfillCoverage.
 *  - A locked deal (BACKLOG-3910) is refused before anything is read.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import log from "electron-log";
import {
  BACKUP_READ_STOPPED,
  BackupAtRestRefusal,
  type BackupAtRest,
  type BackupReadRefusalReason,
  type BackupReadSession,
} from "./atRest/backupAtRest";
import {
  BACKUP_DAMAGED_SENTENCE,
  BACKUP_KEY_MISSING_SENTENCE,
  BACKUP_MISSING_SENTENCE,
  type BackupProblemReason,
} from "./atRest/backupProblem";
import { SMS_DB_FILE_ID } from "./backupDecryptionService";
import { liveDealBackfillRow } from "./db/iphoneCoverageDbService";
import { dealFloorMs } from "./iphoneChatFloorPlan";
import { COVERAGE_TOLERANCE_MS } from "./auditCoverageService";
import { chatParseFloor, type ChatFloorPlan, type FloorParser } from "./iphoneChatFloors";
import {
  getIphoneDealCoverage,
  planIphoneBackfill,
  recordIphoneBackfillCoverage,
  type IphoneBackfillTarget,
} from "./iphoneCoverageService";
import { iOSMessagesParser } from "./iosMessagesParser";
import { dealLockReason } from "./transactionEligibility";
import type { SyncResult } from "./deviceSyncOrchestrator";
import type { PersistResult } from "./iPhoneSyncStorageService";
import type { iOSConversation, iOSMessage } from "../types/iosMessages";
import type {
  BackfillAvailability,
  BackfillPhase,
  BackfillProgress,
  BackfillReason,
  BackfillResult,
} from "../types/iphoneBackfill";

export type { BackfillAvailability, BackfillPhase, BackfillProgress, BackfillReason, BackfillResult };

/** The parser surface the backfill uses (iOSMessagesParser satisfies it). */
export interface BackfillMessagesParser extends FloorParser {
  open(dir: string): void;
  close(): void;
  getConversationsAsync(): Promise<iOSConversation[]>;
  getMessagesAsync(chatId: number, limit?: number, offset?: number, sinceMs?: number, untilMs?: number): Promise<iOSMessage[]>;
  getOldestMessageDateMs(): number | null;
  readonly readFailures: number;
}

export interface BackfillDeps {
  atRest: () => Pick<BackupAtRest, "beginRead" | "endRead" | "buildParseCopy" | "chainDir">;
  copies: { newParseCopyDir(): string; cleanup(dir: string): Promise<boolean> };
  newParser: () => BackfillMessagesParser;
  persist: (
    userId: string,
    result: SyncResult,
    backupPath: string,
    onProgress: ((p: { percent: number }) => void) | undefined,
    sessionId: string,
    cancel: { cancelled: boolean },
  ) => Promise<PersistResult>;
  autoLink: (userId: string) => Promise<unknown>;
  /** Other work that may not overlap (a sync, its persistence, a texts force re-import); null = none. */
  otherWork: () => string | null;
  reportProblem: (reason: BackupProblemReason) => void;
}

const SENTENCE_FOR: Partial<Record<BackfillReason, string>> = {
  missing: BACKUP_MISSING_SENTENCE,
  damaged: BACKUP_DAMAGED_SENTENCE,
  "key-missing": BACKUP_KEY_MISSING_SENTENCE,
};

/** Reasons that are a problem with the backup itself (one Sentry event each). */
const PROBLEM_REASONS: ReadonlySet<BackfillReason> = new Set<BackfillReason>([
  "missing",
  "apple-encrypted",
  "key-unavailable",
  "damaged",
  "key-missing",
  "disk-space",
  "unreadable",
]);

const DISK_CODES: ReadonlySet<string> = new Set(["ENOSPC", "EDQUOT"]);

function withMessage<T extends { reason?: BackfillReason; message?: string }>(r: T): T {
  const message = r.reason ? SENTENCE_FOR[r.reason] : undefined;
  return message ? { ...r, message } : r;
}

/** The attachment files (Manifest fileIDs) the given texts reference. */
export function attachmentFileIds(messages: readonly iOSMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const a of m.attachments ?? []) {
      const rel = a.filename ? iOSMessagesParser.toMediaDomainRelativePath(a.filename) : null;
      if (rel) ids.add(iOSMessagesParser.computeBackupFileHash("MediaDomain", rel));
    }
  }
  return ids;
}

/**
 * The deal's chats and the range to read on one parsed sms.db. Exported for the
 * controls: a chat with none of the deal's people gets the ceiling as its floor and is
 * never read; a chat whose people cannot be read (null) is a read failure.
 */
export function backfillChatPlan(target: Pick<IphoneBackfillTarget, "handleKeys" | "chatIds">, floorMs: number, ceilingMs: number): ChatFloorPlan {
  return {
    settingsFloorMs: ceilingMs,
    handleFloors: new Map(target.handleKeys.map((k) => [k, floorMs])),
    linkedChatFloors: new Map(target.chatIds.map((c) => [c, floorMs])),
  };
}

interface Running {
  transactionId: string;
  abort: AbortController;
  persistCancel: { cancelled: boolean };
  session: BackupReadSession | null;
}

export class IphoneBackfillService {
  private running: Running | null = null;

  constructor(private readonly deps: BackfillDeps) {}

  /** The running backfill's deal, or null. */
  runningFor(): string | null {
    return this.running?.transactionId ?? null;
  }

  /**
   * Stop the running backfill (the user's Cancel, or a sync that is starting): the copy
   * stops at the next file, the read stops at the next chat, persistence rolls back.
   */
  cancel(): boolean {
    const r = this.running;
    if (!r) return false;
    r.abort.abort();
    r.persistCancel.cancelled = true;
    if (r.session) Atomics.store(r.session.stop, 0, 1);
    return true;
  }

  /** Whether this deal can be backfilled now, and from which phone. Never throws. */
  availability(userId: string, transactionId: string): BackfillAvailability {
    try {
      // Other work first: it needs no database read.
      if (this.running) return { available: false, reason: "busy", busyWith: this.running.transactionId };
      if (this.deps.otherWork()) return { available: false, reason: "busy" };
      const pick = this.pickTarget(userId, transactionId);
      if ("reason" in pick) return withMessage({ available: false, reason: pick.reason });
      const t = pick.target;
      return {
        available: true,
        udid: t.udid,
        floorMs: t.floorMs,
        ceilingMs: t.ceilingMs,
        cappedByPhone: t.cappedByPhone,
        coveredSinceAfterMs: t.coveredSinceAfterMs,
      };
    } catch (error) {
      log.warn("[IphoneBackfill] availability check failed", { error: error instanceof Error ? error.message : String(error) });
      return { available: false, reason: "error" };
    }
  }

  /** The first phone (newest last sync first) that can fill the gap and whose backup is here. */
  private pickTarget(userId: string, transactionId: string): { target: IphoneBackfillTarget } | { reason: BackfillReason } {
    const deal = liveDealBackfillRow(userId, transactionId);
    if (!deal) return { reason: "no-deal" };
    // BACKLOG-3910: a locked deal (with the broker, or sealed) gets nothing new.
    if (dealLockReason(deal.submission_status)) return { reason: "locked" };
    const floor = dealFloorMs(deal);
    if (floor === null) return { reason: "no-deal" };
    const plan = planIphoneBackfill(userId, transactionId, floor);
    if (plan.coveredSinceMs === null) return { reason: "no-phone" };
    // The same test as the start warning (auditCoverageService: since - start > 24 h, with
    // start = floor + 24 h): offered exactly when the warning shows.
    if (plan.coveredSinceMs - (floor + COVERAGE_TOLERANCE_MS) <= COVERAGE_TOLERANCE_MS) return { reason: "no-gap" };
    if (plan.targets.length === 0) return { reason: "nothing-older" };
    for (const target of plan.targets) {
      if (this.keptChainPresent(target.udid)) return { target };
    }
    return { reason: "missing" };
  }

  private keptChainPresent(udid: string): boolean {
    try {
      return fs.existsSync(path.join(this.deps.atRest().chainDir(udid), "Manifest.db"));
    } catch {
      return false;
    }
  }

  /** Run the backfill for one deal. One at a time. Never throws. */
  async backfill(userId: string, transactionId: string, onProgress?: (p: BackfillProgress) => void): Promise<BackfillResult> {
    if (this.running) return { success: false, reason: "busy", messagesStored: 0, coverageRecorded: false };
    const run: Running = {
      transactionId,
      abort: new AbortController(),
      persistCancel: { cancelled: false },
      session: null,
    };
    this.running = run;
    const progress = (phase: BackfillPhase, percent: number): void => {
      try {
        onProgress?.({ transactionId, phase, percent: Math.max(0, Math.min(100, Math.round(percent))) });
      } catch {
        // a progress listener never changes the run
      }
    };
    let copyDir: string | null = null;
    let parser: BackfillMessagesParser | null = null;
    try {
      if (this.deps.otherWork()) return this.fail("busy");
      const pick = this.pickTarget(userId, transactionId);
      if ("reason" in pick) return this.fail(pick.reason);
      const target = pick.target;

      // 1. Copy sms.db only, holding the phone.
      progress("copying", 0);
      const copy = this.deps.copies.newParseCopyDir();
      copyDir = copy;
      const first = await this.copy(run, target.udid, copy, new Set([SMS_DB_FILE_ID]));
      if (first) return this.fail(first);

      // 2. Read the deal's chats in [floor, ceiling).
      progress("reading", 10);
      parser = this.deps.newParser();
      parser.open(copy);
      const oldest = parser.getOldestMessageDateMs();
      const floorMs = oldest !== null && oldest > target.floorMs ? oldest : target.floorMs;
      const plan = backfillChatPlan(target, floorMs, target.ceilingMs);
      const conversations: iOSConversation[] = [];
      let skippedReads = 0;
      if (floorMs < target.ceilingMs) {
        const all = await parser.getConversationsAsync();
        for (let i = 0; i < all.length; i++) {
          if (run.abort.signal.aborted) return this.fail("cancelled");
          const conv = all[i];
          const chatFloor = chatParseFloor(parser, plan, conv);
          if (chatFloor === null) {
            // Its people could not be read: it may be a deal chat. Not read; no coverage.
            skippedReads++;
            continue;
          }
          if (chatFloor >= target.ceilingMs) continue; // none of the deal's people
          conv.messages = await parser.getMessagesAsync(conv.chatId, undefined, undefined, chatFloor, target.ceilingMs);
          if (conv.messages.length > 0) conversations.push(conv);
          if (i % 20 === 0) progress("reading", 10 + (i / all.length) * 30);
        }
      }
      const readFailures = parser.readFailures + skippedReads;
      parser.close();
      parser = null;
      if (run.abort.signal.aborted) return this.fail("cancelled");
      const messages = conversations.flatMap((c) => c.messages);

      // 3. Copy only the attachments those texts reference.
      const attachments = attachmentFileIds(messages);
      if (attachments.size > 0) {
        progress("copying", 40);
        const second = await this.copy(run, target.udid, copy, attachments);
        if (second) return this.fail(second);
      }

      // 4. Store (rollback on cancel; guid dedupe).
      progress("saving", 50);
      let stored = 0;
      if (messages.length > 0) {
        const result: SyncResult = {
          success: true,
          messages,
          contacts: [],
          conversations,
          error: null,
          duration: 0,
          backupPath: copy,
          sessionId: crypto.randomUUID(),
          chatReadFailures: readFailures,
        };
        const persisted = await this.deps.persist(
          userId,
          result,
          copy,
          (p) => progress("saving", 50 + p.percent * 0.4),
          result.sessionId!,
          run.persistCancel,
        );
        if (!persisted.success) {
          if (run.persistCancel.cancelled) return this.fail("cancelled");
          return { success: false, reason: "error", messagesStored: 0, coverageRecorded: false, ...(persisted.error ? { message: persisted.error } : {}) };
        }
        stored = persisted.messagesStored;
      }
      if (run.abort.signal.aborted) return this.fail("cancelled");

      // 5. Coverage: only for a run with no failed read.
      let coverageRecorded = false;
      if (readFailures === 0) {
        const skip = recordIphoneBackfillCoverage(userId, { ...target, floorMs }, oldest);
        coverageRecorded = skip === null;
        if (skip) log.info("[IphoneBackfill] coverage not recorded", { reason: skip });
      } else {
        log.warn("[IphoneBackfill] chat reads failed; coverage not advanced", { readFailures });
      }

      // 6. Link the new texts as a sync does (a locked deal is never linked to).
      if (stored > 0) {
        progress("linking", 90);
        await this.deps.autoLink(userId).catch((error: unknown) => {
          log.warn("[IphoneBackfill] auto-link after backfill failed", { error: error instanceof Error ? error.message : String(error) });
        });
      }
      progress("linking", 100);
      const after = getIphoneDealCoverage(userId, transactionId);
      return {
        success: true,
        messagesStored: stored,
        coverageRecorded,
        ...(after ? { coveredSinceAfter: after.coveredSince } : {}),
        cappedByPhone: floorMs > target.floorMs || target.cappedByPhone,
      };
    } catch (error) {
      log.error("[IphoneBackfill] backfill failed", { error: error instanceof Error ? error.message : String(error) });
      return this.fail(this.reasonFor(error));
    } finally {
      try {
        parser?.close();
      } catch {
        // closing a parser never fails the run
      }
      if (run.session) {
        this.deps.atRest().endRead(run.session);
        run.session = null;
      }
      if (copyDir) await this.deps.copies.cleanup(copyDir).catch(() => false);
      this.running = null;
    }
  }

  /** Copy `only` from the kept chain into `dir`, holding the phone for the copy only. */
  private async copy(run: Running, udid: string, dir: string, only: ReadonlySet<string>): Promise<BackfillReason | null> {
    if (run.abort.signal.aborted) return "cancelled";
    const atRest = this.deps.atRest();
    const start = await atRest.beginRead(udid);
    if (!start.ok) return start.reason satisfies BackupReadRefusalReason;
    run.session = start.session;
    try {
      // The user's Cancel may have come while the phone was being claimed.
      if (run.abort.signal.aborted) return "cancelled";
      await atRest.buildParseCopy(udid, dir, { only, stop: start.session.stop });
      return null;
    } finally {
      atRest.endRead(start.session);
      run.session = null;
    }
  }

  private reasonFor(error: unknown): BackfillReason {
    if (error instanceof BackupAtRestRefusal) {
      if (error.reason === "cancelled" || error.message === BACKUP_READ_STOPPED) return "cancelled";
      if (error.problem) return error.problem;
      if (error.reason === "busy") return "busy";
      return error.reason;
    }
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (typeof code === "string" && DISK_CODES.has(code)) return "disk-space";
    return "error";
  }

  private fail(reason: BackfillReason): BackfillResult {
    if (PROBLEM_REASONS.has(reason)) this.deps.reportProblem(reason as BackupProblemReason);
    return withMessage({ success: false, reason, messagesStored: 0, coverageRecorded: false });
  }
}
