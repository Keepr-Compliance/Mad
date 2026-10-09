/**
 * RCS import IPC — BACKLOG-3619 (proof of concept).
 *
 * Owns the one {@link RcsExtensionBridge} instance and wires it to the real
 * storage. `rcs-import:get-status` reports the bridge's state. (The manual
 * import session and its Import panel are gone: BACKLOG-3662.)
 *
 * BACKLOG-3620 — Sync jobs:
 * - `rcs-import:start-job`  { transactionId } — creates the job and opens
 *   Messages for Web with `#keepr-job=<jobId>` in the default browser.
 * - `rcs-import:cancel-job` { jobId }
 * - `rcs-import:get-job`
 * - push `rcs-import:job-progress` on every job change.
 * When the job finishes, Keepr brings its own window forward (no `keepr://`).
 */

import * as fs from "fs";
import { setGoogleMessagesDiagnosticsProvider, type GoogleMessagesDiagnostics } from "../services/supportTicketService";
import * as path from "path";

import { spawn } from "child_process";
import { app, clipboard, ipcMain, shell } from "electron";

import { hostWindows } from "../capabilities/windowsProvider";
import { dbTransaction } from "../services/db/core/dbConnection";
import databaseService from "../services/databaseService";
import logService from "../services/logService";
import { RcsExtensionBridge } from "../services/rcsExtensionBridge";
import { sealBufferToFile } from "../services/atRest/attachmentWriter";
import type { RcsJobSnapshot } from "../services/rcsImportJob";
import { rcsImageFilename, type RcsMediaDeps } from "../services/rcsImportMedia";
import { rcsChatHash, rcsExternalId, storeCacheChatSync, type RcsCacheChatDeps } from "../services/rcsImportStore";
import {
  RcsCacheStaging,
  type CacheCommitResult,
  type CacheLimits,
  type RcsCommitWriter,
  type StagedChatMeta,
} from "../services/rcsCacheStaging";
import { loadStoredImportFilters, resolveImportPlanForUser } from "../services/importPlanInputs";
import { resolveLookbackMonths } from "../services/macOSMessagesImportService/importHelpers";
import { clearRcsCacheRun, getRcsCacheRun, recordRcsCacheRun } from "../services/db/rcsCacheRunsDbService";
import { clearAllPendingFullRead, clearPendingFullRead, listPendingFullRead } from "../services/db/rcsPendingFullSyncDbService";
import { RCS_EXCLUSIONS_MAX } from "../services/rcsExclusions";
import {
  chatDoneInFailedRun,
  clearChatCoverage,
  clearChatReads,
  clearFailedRun,
  getChatRead,
  getFailedRun,
  recordChatRead,
  setFailedRun,
  dealChatStarts,
  dealStartForChat,
  getChatCoverage,
  latestConversationIds,
  recordChatCoverage,
} from "../services/db/rcsChatCoverageDbService";
import { RCS_DEAL_CHATS_MAX } from "../services/rcsImportJob";
import { forgetSourceCoverage, getSourceCoverage, recordSourceCoverage } from "../services/auditCoverageService";
import {
  CHROME_EXTENSIONS_ADDRESS,
  chromeCandidates,
  extensionSourceDir,
  extensionTargetDir,
  launchChrome,
  prepareExtensionFolderShared,
  refreshExtensionFolderIfOlder,
  folderExtensionVersion,
  isOlderVersion,
  type DeliveryFs,
} from "../services/rcsExtensionDelivery";
import {
  backfillCoverageFrom,
  cacheRunCoverage,
  cacheRunReadNothing,
  chatFloorDecision,
  effectiveChatCoverageMs,
  pickDealChats,
  cacheWindow,
  type CacheEndSnapshot,
  consentIsCurrent,
  cacheSavedFromCommit,
  consentToRecordOnSync,
  RCS_CONSENT_VERSION,
  cancelOnSessionChange,
  decideCacheStart,
  handleCacheJobEnded,
  shouldFocusKeeprOnJobEnd,
  shouldPersistHello,
} from "../services/rcsCacheService";
import { onSessionChanged } from "../services/authEvents";
import { autoLinkNewMessagesForUser } from "../services/autoLinkService";
import sessionService from "../services/sessionService";
import {
  clearGoogleMessagesWebData,
  clearUnlinkedOldChats,
  RCS_AUTO_DELETE_DAYS,
  runSharedForceClear,
  runWithWritesPaused,
  type RcsClearResult,
  type SharedForceClearResult,
} from "../services/rcsClearService";
import { bringAppToFrontForLink, bringAppToFrontOrFlash } from "../utils/bringAppToFront";
import { wrapHandler } from "../utils/wrapHandler";
import { checkDiskSpaceForOperation } from "../services/diagnostics/diskSpaceDiagnostics";
import { scrubRcsText } from "../utils/redactSensitive";
import { RCS_SENTRY_TAGS } from "../services/rcsSentryScrub";
import { getMainWindow } from "../windowRegistry";
import { ValidationError } from "../utils/validation";
import { RCS_MEDIA_DEFAULTS, clearPendingMediaRead, getRcsMediaOptions, hasPendingMediaRead, recordRcsMediaSeen, setRcsMediaOptions } from "../services/db/rcsMediaDbService";
import { NOT_PAIRED_MESSAGE, RcsPairingAuth, type LinkState } from "../services/rcsPairingAuth";
import { loadPairProtocol } from "../services/rcsPairProtocol";
import { rcsPairingStore } from "../services/db/rcsPairingDbService";
import { RcsSyncOutcomeTracker, cleanReasonCode } from "../services/rcsSyncOutcome";
import { focusForBrowser, RCS_OPEN_LINK_SCREEN_CHANNEL, linkCodeFromClipboard, clearLinkCodeFromClipboard, linkCodeAutoFillOn } from "../services/rcsLinkFocus";
import {
  recordSyncOutcomeSettled,
  recordSyncRunMetrics,
  recordSyncRunProgressWhileRunning,
  recordSyncRunStart,
} from "../services/syncOutcomeSupabase";
import type {
  RcsClearTextsResult,
  RcsExtensionStateResult,
  RcsImportJobResult,
  RcsImportStatusResult,
} from "../types/ipc/window-api-rcs-import";

const LOG_TAG = "RcsImport";
/** BACKLOG-3668 L3: RCS handler errors are tagged for the Sentry scrub and logged scrubbed. */
const RCS_HANDLER_OPTIONS = { module: LOG_TAG, sentryTags: { ...RCS_SENTRY_TAGS }, scrubLogText: (err: unknown) => scrubRcsText(err) };
export const RCS_JOB_PROGRESS_CHANNEL = "rcs-import:job-progress";
export const RCS_MESSAGES_WEB_URL = "https://messages.google.com/web/conversations";
/** Keepr's "Open Google Messages" on its link screen: the extension's link window, in the open Messages tab. */
export const RCS_LINK_HASH = "keepr-link";
/**
 * The Keepr extension's Chrome Web Store listing (storyboard A02 "Add to
 * Chrome"). Only used once the extension is published (the renderer's
 * EXTENSION_PUBLISHED); held here so the renderer never names a URL to open.
 */
export const RCS_EXTENSION_STORE_URL = "https://chromewebstore.google.com/detail/keepr-for-google-messages";
/** BACKLOG-3657: Google Messages for Web texts were cleared; open views refetch. */
export const RCS_DATA_CLEARED_CHANNEL = "rcs-import:data-cleared";
/** BACKLOG-3658 (SR S1): a cache Sync was saved and auto-linked; open views refetch. */
export const RCS_DATA_CHANGED_CHANNEL = "rcs-import:data-changed";
/** SR B1: refusal while a finished cache Sync is still being saved. */
export const RCS_SAVING_MESSAGE = "Keepr is still saving the last Sync. Try again in a moment.";

const deps: RcsCacheChatDeps = {
  batchInsertMessages: (rows, batchSize) => databaseService.batchInsertMessages(rows, batchSize),
  getMessageIdMap: (userId) => databaseService.getMessageIdMap(userId),
  insertReactionRows: (rows) => databaseService.insertReactionRows(rows),
  // BACKLOG-3630: the content guard (same sent_at + direction + body).
  findContentDuplicates: (userId, rows) => databaseService.findRcsContentDuplicates(userId, rows),
  // BACKLOG-3665: a legacy chat removal moves onto the gmweb2 thread.
  // BACKLOG-3670: people found in texts (local only; names never logged).
  recordPeople: (userId, chatHash, rows, lastMessageAt) =>
    databaseService.recordRcsChatPeople(userId, chatHash, rows, lastMessageAt),
  // Live (founder): a group's name, in the table search and thread cards read.
  recordThreadName: (userId, threadId, name) => databaseService.recordRcsThreadName(userId, threadId, name),
};

/** Exported for the BACKLOG-3816 writer controls. */
export const mediaDeps: RcsMediaDeps = {
  attachmentsDir: () => path.join(app.getPath("userData"), "message-attachments"),
  getMessageIdMap: (userId) => databaseService.getMessageIdMap(userId),
  getExistingAttachmentRecords: () => databaseService.getExistingAttachmentRecords(),
  insertAttachment: (params) => databaseService.insertAttachment(params),
  markMessageHasAttachments: (messageId) => databaseService.markMessageHasAttachments(messageId),
  dbTransaction: (fn) => dbTransaction(fn as () => never),
  fileExists: async (filePath) => {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  // BACKLOG-3816: RCS images are stored as KEPRENC ciphertext.
  writeSealed: async (filePath, data) => {
    await sealBufferToFile(filePath, data);
  },
  mkdir: async (dir) => {
    await fs.promises.mkdir(dir, { recursive: true });
  },
};

// ---------------------------------------------------------------------------
// BACKLOG-3658: the cache Sync's staging (atomic, limit-aware import)
// ---------------------------------------------------------------------------

let staging: RcsCacheStaging | null = null;

/** Lazily: the database is opened after sign-in, long after this module loads. */
function cacheStaging(): RcsCacheStaging {
  if (staging) return staging;
  staging = new RcsCacheStaging(databaseService.rcsStagingDbOps(), {
    stagingRoot: path.join(app.getPath("userData"), "rcs-cache-staging"),
    attachmentsDir: mediaDeps.attachmentsDir(),
    mkdir: async (dir) => {
      await fs.promises.mkdir(dir, { recursive: true });
    },
    writeSealed: mediaDeps.writeSealed,
    exists: mediaDeps.fileExists,
    // Moves staged CIPHERTEXT into message-attachments (rename; copy across volumes).
    move: async (from, to) => {
      try {
        await fs.promises.rename(from, to);
      } catch {
        // Another volume (or a locked file): copy, then drop the staged one.
        await fs.promises.copyFile(from, to);
        await fs.promises.unlink(from).catch(() => undefined);
      }
    },
    unlink: async (filePath) => {
      await fs.promises.unlink(filePath).catch(() => undefined);
    },
    removeDir: async (dir) => {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
    listDir: async (dir) => fs.promises.readdir(dir).catch(() => [] as string[]),
  });
  return staging;
}

/**
 * SR B1: a finished cache Sync is saved (commit + auto-link) AFTER its job
 * slot is free. Until that is done Keepr is busy: no new cache or
 * transaction Sync, no Force re-import — none of them may sweep the staging
 * or write the same content-addressed files meanwhile.
 */
let cacheEndsInFlight = 0;
/**
 * SR optional: a commit or auto-link that never settles must not leave Keepr
 * busy for good. After this long the busy flag is released, the job's staging
 * is abandoned, and the hang is logged.
 */
export const RCS_CACHE_SAVE_TIMEOUT_MS = 10 * 60 * 1000;
export function cacheSaveInFlight(): boolean {
  return cacheEndsInFlight > 0 || (staging?.isCommitting ?? false);
}

/** The commit writes through the cache job's existing writers. */
/** The cache commit's writer (exported for the real-SQL commit test). */
export const commitWriter: RcsCommitWriter = {
  storeChat: (chat, userId, people) => {
    const r = storeCacheChatSync(chat, userId, deps, people);
    // Saved (in the commit's transaction): a chat switched back on is no longer pending.
    clearPendingFullRead(userId, chat.conversationId, rcsChatHash(people.numbers));
    return r;
  },
  getMessageIdMap: (userId) => databaseService.getMessageIdMap(userId),
  getExistingAttachmentRecords: () => databaseService.getExistingAttachmentRecords(),
  insertAttachment: (params) => databaseService.insertAttachment(params),
  markMessageHasAttachments: (messageId) => databaseService.markMessageHasAttachments(messageId),
  externalId: rcsExternalId,
  imageFilename: rcsImageFilename,
};

/**
 * SR (2026-10-02): what one cache job learned per chat (by chat hash):
 *  - chatFloors: a deal chat's own floor (the commit keeps messages back to it);
 *  - readFloors: the floor a chat was asked to read down to this run (widened,
 *    a pending full read, or a full read at the settings floor);
 *  - reached: chats the page read down to their floor (/chat reachedFloor).
 */
export interface CacheChatsRead {
  readFloors: Map<string, number>;
  reached: Set<string>;
}
interface CacheChatsState extends CacheChatsRead {
  /** 3671 P3: the failed run's start, when this run is "Try again". */
  tryAgainSince: string | null;
  mediaPending: boolean;
  settingsFloorMs: number;
  fullRead: boolean;
  devOverride: boolean;
  pendingIds: Set<string>;
  sourceCoveredSince: string | null;
  chatFloors: Map<string, number>;
  widened: Set<string>;
  maxWidenDays: number;
}
const cacheChatsByJob = new Map<string, CacheChatsState>();

/** A cache job starts: its per-chat state (exported for the real-SQL widening test). Returns the commit's chat floors. */
export function trackCacheChats(
  jobId: string,
  init: {
    settingsFloorMs: number;
    fullRead: boolean;
    devOverride: boolean;
    pendingIds: readonly string[];
    sourceCoveredSince: string | null;
    tryAgainSince?: string | null;
    mediaPending?: boolean;
  },
): Map<string, number> {
  const chatFloors = new Map<string, number>();
  cacheChatsByJob.set(jobId, {
    tryAgainSince: init.tryAgainSince ?? null,
    mediaPending: init.mediaPending === true,
    settingsFloorMs: init.settingsFloorMs,
    fullRead: init.fullRead,
    devOverride: init.devOverride,
    pendingIds: new Set(init.pendingIds),
    sourceCoveredSince: init.sourceCoveredSince,
    chatFloors,
    readFloors: new Map(),
    reached: new Set(),
    widened: new Set(),
    maxWidenDays: 0,
  });
  return chatFloors;
}

/** The job is over: its per-chat state, once (for the commit). */
export function takeCacheChats(jobId: string): (CacheChatsRead & { widened: number; maxWidenDays: number }) | undefined {
  const st = cacheChatsByJob.get(jobId);
  cacheChatsByJob.delete(jobId);
  return st ? { readFloors: st.readFloors, reached: st.reached, widened: st.widened.size, maxWidenDays: st.maxWidenDays } : undefined;
}

/**
 * /match (cache): this chat's own floor when a live deal reaches past the
 * settings floor and the chat is not read back to it yet; null otherwise.
 * Never throws (a failed read = the settings floor).
 */
export function cacheChatFloorFor(jobId: string, userId: string, conversationId: string, numbers: string[]): number | null {
  const st = cacheChatsByJob.get(jobId);
  if (!st || st.devOverride || numbers.length === 0) return null;
  const hash = rcsChatHash(numbers);
  if (st.fullRead || st.pendingIds.has(conversationId)) st.readFloors.set(hash, st.settingsFloorMs);
  try {
    const d = chatFloorDecision({
      nowMs: Date.now(),
      settingsFloorMs: st.settingsFloorMs,
      dealStartMs: dealStartForChat(userId, hash, numbers),
      coveredSinceMs: effectiveChatCoverageMs(getChatCoverage(userId, [hash]).get(hash), st.sourceCoveredSince),
    });
    if (d.floorMs === null) return null;
    st.chatFloors.set(hash, d.floorMs);
    if (!d.widen) return null;
    st.readFloors.set(hash, d.floorMs);
    st.widened.add(hash);
    st.maxWidenDays = Math.max(st.maxWidenDays, d.widenDays);
    return d.floorMs;
  } catch (err) {
    void logService.warn("[RcsCache] Deal floor for a chat failed (settings floor kept): " + scrubRcsText(err), LOG_TAG);
    return null;
  }
}

/** /chat (cache): the page read this chat down to its floor. */
export function noteCacheChatRead(jobId: string, numbers: readonly string[], reachedFloor: boolean | undefined, nowMs: number = Date.now()): void {
  const st = cacheChatsByJob.get(jobId);
  if (!st || numbers.length === 0) return;
  const hash = rcsChatHash(numbers);
  if (reachedFloor === true) st.reached.add(hash);
  // 3671 P3: kept with the staging (a crash-cut run is saved from it later).
  cacheStaging().noteChat(jobId, {
    chatHash: hash,
    chatFloorMs: st.chatFloors.get(hash) ?? null,
    readFloorMs: st.readFloors.get(hash) ?? null,
    reachedFloor: reachedFloor === true,
    readAt: new Date(nowMs).toISOString(),
  });
}

/**
 * 3671 P3 "Try again" (SR): after a failed run, a chat that run already
 * finished (read at or after its start, down to its own floor) is skipped —
 * unless it must be read in full anyway (switched back on, a media read).
 */
export function cacheChatSkipFor(jobId: string, userId: string, conversationId: string, numbers: string[]): boolean {
  const st = cacheChatsByJob.get(jobId);
  if (!st || !st.tryAgainSince || st.devOverride || st.mediaPending || numbers.length === 0) return false;
  if (st.pendingIds.has(conversationId)) return false;
  try {
    const hash = rcsChatHash(numbers);
    if (st.widened.has(hash)) return false;
    return chatDoneInFailedRun(getChatRead(userId, hash), st.tryAgainSince);
  } catch {
    return false;
  }
}

/** The limits each cache job was started with (frozen at start; used by its commit). */
const cacheLimitsByJob = new Map<string, CacheLimits>();
/** BACKLOG-3663: each cache job's read — did it start at the floor, and where is the floor. */
const cacheReadByJob = new Map<string, { fullRead: boolean; floorISO: string; mediaPending?: boolean }>();

/** P3b: each cache job's options, frozen at start (contacts-only flag, auto-delete). */
const cacheOptionsByJob = new Map<string, {
  contactsOnly: boolean;
  autoDeleteDays: number | null;
  /** SR M: frozen per job — keep photos / videos of chats with no transaction contact. */
  photosAllChats: boolean;
  videosAllChats: boolean;
}>();

/** SR M: are this chat's photos / videos kept? A transaction contact, or the "all chats" toggle. */
export function mediaKeptFor(
  options: { photosAllChats: boolean; videosAllChats: boolean } | undefined,
  hasContact: boolean,
): { photos: boolean; videos: boolean } {
  return {
    photos: hasContact || (options?.photosAllChats ?? RCS_MEDIA_DEFAULTS.photosAllChats),
    videos: hasContact || (options?.videosAllChats ?? RCS_MEDIA_DEFAULTS.videosAllChats),
  };
}

/** P3b: the attachments folder rules shared by the clears. */
function clearFiles() {
  return {
    attachmentsRoot: mediaDeps.attachmentsDir(),
    resolve: (p: string) => (path.isAbsolute(p) ? p : path.join(app.getPath("userData"), p)),
    deleteFile: (abs: string) => {
      try {
        fs.unlinkSync(abs);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * BACKLOG-3658 P3b — the optional auto-delete of old chats linked to
 * nothing. DORMANT (founder, 2026-10-04): its switch is removed from
 * Settings "for now", so the purge never runs, whatever value is stored.
 * The code stays (unreachable) for when the switch comes back: turn this on
 * together with the Settings row.
 */
export const RCS_AUTO_DELETE_ENABLED = false;

/** The purge's cutoff for a Sync, or null when it must not run (dormant, or off). */
export function autoDeleteCutoff(autoDeleteDays: number | null | undefined, nowMs: number): string | null {
  if (!RCS_AUTO_DELETE_ENABLED || !autoDeleteDays) return null;
  return new Date(nowMs - autoDeleteDays * 24 * 60 * 60 * 1000).toISOString();
}

/** P3b: after the auto-link, the optional auto-delete (dormant: see RCS_AUTO_DELETE_ENABLED). */
async function afterCacheLinked(jobId: string, userId: string): Promise<void> {
  const options = cacheOptionsByJob.get(jobId);
  cacheOptionsByJob.delete(jobId);
  const cutoff = autoDeleteCutoff(options?.autoDeleteDays, Date.now());
  if (!cutoff) return;
  clearUnlinkedOldChats(userId, cutoff, databaseService.rcsAutoDeleteDbOps(), clearFiles(), (m) => void logService.info(m, LOG_TAG));
}

/**
 * What a cache commit records INSIDE its own transaction (exported for the
 * real-SQL commit test): the coverage, the pending media read done (SR M), the
 * run. A failed or discarded commit records none of it.
 */
export function cacheCommitInsideTransaction(
  userId: string,
  read: { fullRead: boolean; floorISO: string; mediaPending?: boolean } | undefined,
  reached: boolean,
  notSettledChats: number,
  listStop: string | null,
): void {
  const nowISO = new Date().toISOString();
  // The SOURCE row: every chat down to the settings floor (a widened deal
  // chat never raises it: read.floorISO is the settings floor). 3671 P3:
  // only a COMPLETE run gets here (the last transaction of its commit).
  recordSourceCoverage(userId, "google_messages", reached && read ? read.floorISO : null, nowISO);
  // A complete run: the next one is no longer "Try again".
  clearFailedRun(userId);
  // SR M: the media read asked for by a toggle is done once this commit saves.
  if (read?.mediaPending) clearPendingMediaRead(userId);
  if (read) {
    recordRcsCacheRun(userId, {
      floorISO: read.floorISO,
      fullRead: read.fullRead,
      listStop,
      reachedFloor: reached,
      notSettledChats,
      finishedAt: nowISO,
    });
  }
}

/**
 * 3671 P3: what each saved chat records, INSIDE its own transaction: its
 * coverage (only when it reached its own floor) and when it was read.
 */
export function cacheChatCommitted(userId: string, chat: { chatHash: string; meta: StagedChatMeta | null }): boolean {
  const m = chat.meta;
  if (!m) return false;
  let covered = false;
  // Inside the chat's own transaction (a nested one is a savepoint).
  dbTransaction(() => {
    if (m.reachedFloor && typeof m.readFloorMs === "number") {
      recordChatCoverage(userId, chat.chatHash, new Date(m.readFloorMs).toISOString());
      covered = true;
    }
    recordChatRead(userId, chat.chatHash, m.readAt, m.reachedFloor);
  });
  return covered;
}

/**
 * 3671 P3: commit a job's staging chat by chat. `complete` (a fully finished
 * run) also records the run (source coverage, run record); otherwise (a
 * failed run, or one a crash cut short) only the finished chats are saved
 * and the next run is "Try again".
 */
export async function commitCacheStaging(
  jobId: string,
  userId: string,
  limits: CacheLimits,
  read: { fullRead: boolean; floorISO: string; mediaPending?: boolean } | undefined,
  run: { complete: boolean; startedAt: string; snapshot?: CacheEndSnapshot },
): Promise<CacheCommitResult> {
  const coverage = read && run.snapshot && run.complete ? cacheRunCoverage(read.fullRead, run.snapshot) : { reached: false, notSettledChats: 0 };
  // Live: a run that read nothing records nothing (no coverage, no last-sync
  // time, no run record; a pending media read / failed run stays as it was).
  const readNothing = !!run.snapshot && cacheRunReadNothing(run.snapshot);
  // Live (founder): counts only — how many chats recorded their coverage.
  let coverageRecorded = 0;
  const r = await cacheStaging().commit(jobId, userId, limits, commitWriter, {
    // SR: a chat switched to Don't sync since it was read is not saved.
    chatExcluded: (u, hash, conversationId) => databaseService.checkRcsExclusion(u, hash, conversationId),
    perChat: (chat) => {
      if (cacheChatCommitted(userId, chat)) coverageRecorded += 1;
    },
    runDone: () => {
      if (readNothing) {
        void logService.warn("[RcsCache] The Sync read no messages (every chat empty): nothing recorded", LOG_TAG);
        return;
      }
      cacheCommitInsideTransaction(userId, read, coverage.reached, coverage.notSettledChats, run.snapshot?.listStop ?? null);
    },
    log: (m) => void logService.warn(m, LOG_TAG),
  }, { complete: run.complete });
  // Not complete (failed, crash-cut, a chat that failed, or stopped by the save
  // timeout): the next run is "Try again" — it skips the chats this one finished.
  if (!run.complete || (r.chatsFailed ?? 0) > 0 || r.stopped || r.runRecordFailed) setFailedRun(userId, run.startedAt);
  void logService.info(`[RcsCache] chat coverage recorded: ${coverageRecorded}`, LOG_TAG);
  return r;
}

async function commitCacheJob(jobId: string, userId: string, snapshot?: CacheEndSnapshot): Promise<void> {
  const limits = cacheLimitsByJob.get(jobId);
  cacheLimitsByJob.delete(jobId);
  const read = cacheReadByJob.get(jobId);
  cacheReadByJob.delete(jobId);
  if (!limits) {
    // Never started here (should not happen): keep nothing rather than guess.
    await cacheStaging().discard(jobId);
    throw new Error("No limits recorded for this Sync");
  }
  // BACKLOG-3663 / 3671 P3: chat by chat; the source coverage and the run
  // record only for a fully finished run (L2: not-settled chats are counted).
  const chats = takeCacheChats(jobId);
  const complete = snapshot?.state === "finished";
  const r = await commitCacheStaging(jobId, userId, limits, read, {
    complete,
    startedAt: snapshot?.createdAt ?? new Date().toISOString(),
    snapshot,
  });
  // Telemetry (counts only): how many chats a live deal widened, and by how much.
  if (chats) {
    void logService.info(
      "[RcsCache] Deal widening: dealWidenedChats=" + chats.widened + ", maxWideningDays=" + chats.maxWidenDays,
      LOG_TAG,
    );
  }
  void logService.info(
    `[RcsCache] Cache Sync saved (${complete ? "finished" : "failed: finished chats only"}): ` +
      `${r.chatsFailed ?? 0} chats failed, ${r.chatsExcluded ?? 0} switched off since read${r.stopped ? ", stopped by the save timeout" : ""}; ` +
      `${r.staged} staged, ${r.kept} kept (${r.droppedByDate} older than the months setting; ` +
      `no max-messages cap for this source); ${r.chats} chats, ${r.stored} new, ${r.alreadyPresent} already there; ` +
      `images: ${r.imagesStaged} kept, ${r.imagesStored} new, ${r.imagesAlreadyThere ?? 0} already there, ` +
      `${r.imagesNoMessage ?? 0} with no saved message; reactions ${r.reactionsKept ?? r.reactions} (${r.reactions} new)`,
    LOG_TAG,
  );
  // The done screens (Keepr's and the page's) show what was SAVED.
  if (complete) bridge.recordCacheSaved(jobId, cacheSavedFromCommit(r));
}

/** 3671 P3 (SR): a crash-cut run's staging is saved only for its own user, within this long. */
export const RCS_LEFTOVER_STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 3671 P3 (SR): staging a crash left behind. Saved (its finished chats, as a
 * failed run) ONLY when its user is the signed-in user and it started within
 * 7 days; otherwise discarded. Never throws.
 */
/** SR F3: one recovery at a time (app start, sign-in and Sync start share it). */
let recoveryInFlight: Promise<{ committed: number; discarded: number; kept: number }> | null = null;

/**
 * Live (dev45): a run is LIVE in this process — created here and not yet
 * settled (its limits are held until its commit / discard / abandon), or the
 * bridge's current job while it runs or is being saved. Its staging rows are
 * not a crash's leftover, whatever triggered the recovery.
 */
function liveInThisProcess(jobId: string): boolean {
  if (cacheLimitsByJob.has(jobId)) return true;
  const current = bridge.getJob();
  if (!current || current.jobId !== jobId) return false;
  return current.state === "created" || current.state === "running" || (current.state === "finished" && current.saved === undefined);
}

export function recoverLeftoverStaging(
  signedInUserId: string | null,
  nowMs: number = Date.now(),
): Promise<{ committed: number; discarded: number; kept: number }> {
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = (async () => {
    const out = { committed: 0, discarded: 0, kept: 0 };
    for (const job of cacheStaging().leftoverJobs()) {
      // Live (dev45): never a run of THIS process — only one a crash / quit
      // of an earlier process left behind.
      if (liveInThisProcess(job.jobId)) continue;
      const action = leftoverAction(job, signedInUserId, nowMs);
      // SR F1: nobody signed in (yet): the run is left as it is.
      if (action === "keep") {
        out.kept += 1;
        continue;
      }
      out[await settleLeftoverJob(job, action === "save")] += 1;
    }
    return out;
  })().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

/**
 * SR F3: Sync start — wait for a recovery already running (e.g. the one at
 * app start, maybe before anyone was signed in), then settle for THIS user,
 * before the staging sweep.
 */
export async function recoverLeftoverStagingFor(userId: string): Promise<{ committed: number; discarded: number; kept: number }> {
  if (recoveryInFlight) await recoveryInFlight.catch(() => undefined);
  return recoverLeftoverStaging(userId);
}

/**
 * 3671 P3 (SR, F1): what to do with a run a crash left behind —
 *  - "discard": a DIFFERENT user is signed in, or it started over 7 days ago;
 *  - "keep": nobody is signed in (yet) — untouched until someone is;
 *  - "save": the signed-in user's own run, within 7 days.
 */
export function leftoverAction(
  job: { userId: string; startedAt: string },
  signedInUserId: string | null,
  nowMs: number,
): "save" | "discard" | "keep" {
  const started = Date.parse(job.startedAt);
  const fresh = Number.isFinite(started) && nowMs - started <= RCS_LEFTOVER_STAGING_MAX_AGE_MS && started <= nowMs + 60_000;
  if (!fresh) return "discard";
  if (!signedInUserId) return "keep";
  return job.userId === signedInUserId ? "save" : "discard";
}

/**
 * One leftover run: saved (its finished chats, as a failed run) or
 * discarded. A commit always drops its staging, also when it fails. Never throws.
 */
async function settleLeftoverJob(
  job: { jobId: string; userId: string; startedAt: string; limitsJson: string; readJson: string },
  save: boolean,
): Promise<"committed" | "discarded"> {
  try {
    if (save) {
      const limits = JSON.parse(job.limitsJson) as CacheLimits;
      const read = JSON.parse(job.readJson) as { fullRead: boolean; floorISO: string; mediaPending?: boolean };
      const r = await commitCacheStaging(job.jobId, job.userId, limits, read, { complete: false, startedAt: job.startedAt });
      void logService.info(`[RcsCache] A Sync a crash cut short: ${r.chats} finished chats saved`, LOG_TAG);
      return "committed";
    } else {
      await cacheStaging().discard(job.jobId);
      return "discarded";
    }
  } catch (err) {
    void logService.warn(`[RcsCache] Leftover staging not settled: ${scrubRcsText(err)}`, LOG_TAG);
    return "discarded";
  }
}

async function discardCacheJob(jobId: string): Promise<number> {
  cacheLimitsByJob.delete(jobId);
  cacheChatsByJob.delete(jobId);
  cacheReadByJob.delete(jobId);
  cacheOptionsByJob.delete(jobId);
  return cacheStaging().discard(jobId);
}

function broadcastJob(job: RcsJobSnapshot): void {
  hostWindows.broadcast(RCS_JOB_PROGRESS_CHANNEL, job);
}

// ---------------------------------------------------------------------------
// BACKLOG-3658: the cache job (all recent chats, then the phone auto-link)
// ---------------------------------------------------------------------------

/**
 * The signed-in user, or null — kept in memory (SR P1 optional) and dropped on
 * every session change (sign-in, refresh, sign-out), then read once again.
 */
let cachedUserId: string | null | undefined;

async function currentUserId(): Promise<string | null> {
  if (cachedUserId !== undefined) return cachedUserId;
  try {
    const session = await sessionService.loadSession();
    cachedUserId = session?.user?.id ?? null;
  } catch {
    cachedUserId = null;
  }
  // BACKLOG-3666: a restored session names its user here (a later sign-out revokes the pairing).
  if (cachedUserId) lastSessionUserId = cachedUserId;
  return cachedUserId;
}

// A running Sync belongs to the user who started it: signing out cancels it;
// another user signing in cancels it too (and the bridge re-checks per write).
/** BACKLOG-3666: the user the session last named (a sign-out revokes their pairing). */
let lastSessionUserId: string | null = null;

onSessionChanged((change) => {
  cachedUserId = undefined;
  // Live (dev45): a SIGN-IN (a user the session did not name before), not a
  // token refresh re-saving the same user's session (hourly, mid-Sync).
  const signedIn = change.kind === "saved" && !!change.userId && change.userId !== lastSessionUserId;
  if (cancelOnSessionChange(change, bridge.activeJobUserId(), !!bridge.activeJob())) bridge.cancelJob();
  // BACKLOG-3666: sign-out or a user switch revokes the earlier user's pairing.
  if (lastSessionUserId && (change.kind === "cleared" || change.userId !== lastSessionUserId)) {
    pairingAuth.revoke(lastSessionUserId);
  }
  lastSessionUserId = change.kind === "saved" ? change.userId : null;
  // SR F1: a run a crash cut short is settled once we know who is signed in —
  // on a sign-in only (app start runs it from startRcsExtensionBridge).
  if (signedIn) void recoverLeftoverStaging(change.userId).catch(() => undefined);
});

/** The extension this Keepr ships (<resources>/chrome-extension, or the repo's in development). */
function bundledExtensionDir(): string {
  return extensionSourceDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
}

/** The real file system for rcsExtensionDelivery. */
const deliveryFs: DeliveryFs = {
  exists: async (p) => fs.promises.access(p).then(() => true, () => false),
  readText: (p) => fs.promises.readFile(p, "utf8"),
  copyDir: (from, to) => fs.promises.cp(from, to, { recursive: true, errorOnExist: true }),
  removeDir: (p) => fs.promises.rm(p, { recursive: true, force: true }),
  rename: (from, to) => fs.promises.rename(from, to),
  listDir: (p) => fs.promises.readdir(p),
};

/** The bundled extension's version, read once. */
let bundledVersionCache: Promise<string | null> | null = null;
function bundledExtensionVersion(): Promise<string | null> {
  // Never fails the caller (get-extension-state): unreadable → null (no "update ready").
  if (!bundledVersionCache) {
    try {
      bundledVersionCache = folderExtensionVersion(bundledExtensionDir(), deliveryFs).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }
  return bundledVersionCache;
}

/**
 * What the extension last said (POST /hello). Kept in memory while signed
 * out; written to the signed-in user's rcs_cache_state row when there is one.
 */
const extensionPresence: { version: string | null; seenAt: string | null; pairedAt: string | null } = {
  version: null,
  seenAt: null,
  pairedAt: null,
};

/** Last time an extension report was written, per user and kind (at most once a minute). */
const helloPersistedAt = new Map<string, number>();

async function onHello(hello: { version?: string; paired?: boolean }): Promise<void> {
  const now = new Date().toISOString();
  if (hello.version) {
    // Live (founder): which version the extension reports, when it changes
    // (version only) — so "update ready" can be checked from the log.
    if (hello.version !== extensionPresence.version) {
      void logService.info(`[RcsImport] Extension reports ${hello.version}`, LOG_TAG);
    }
    extensionPresence.version = hello.version;
    extensionPresence.seenAt = now;
  }
  if (hello.paired) extensionPresence.pairedAt = now;
  const userId = await currentUserId();
  if (!userId) return;
  // At most once a minute per user and kind (a paired report is not lost to a
  // version report a second earlier).
  const key = `${userId}:${hello.paired ? "paired" : "version"}`;
  if (!shouldPersistHello(helloPersistedAt.get(key), Date.now())) return;
  helloPersistedAt.set(key, Date.now());
  databaseService.updateRcsCacheState(userId, {
    extension: {
      ...(hello.version ? { version: hello.version, seenAt: now } : {}),
      ...(hello.paired ? { pairedAt: now } : {}),
    },
  });
}

/**
 * Start the cache job for the signed-in user, or say why not (status + body).
 * BACKLOG-3658: the window and limits come from the user's message import
 * settings (months, max messages — the same plan as every other source);
 * `sinceDays` is a DEV-ONLY override, ignored in a packaged build.
 */
let cacheStartInFlight = false;

async function startCacheJob(opts: { sinceDays?: unknown } = {}): Promise<
  { ok: true; job: RcsJobSnapshot } | { ok: false; status: number; error: string; message: string }
> {
  if (cacheSaveInFlight()) return { ok: false, status: 503, error: "busy", message: RCS_SAVING_MESSAGE };
  // Two quick starts must not both pass the checks below (the plan read and
  // the stale-staging sweep await): the second one is refused.
  if (cacheStartInFlight) {
    return { ok: false, status: 409, error: "already_syncing", message: "Keepr is already starting a Sync." };
  }
  cacheStartInFlight = true;
  try {
    return await startCacheJobOnce(opts);
  } finally {
    cacheStartInFlight = false;
  }
}

async function startCacheJobOnce(opts: { sinceDays?: unknown }): Promise<
  { ok: true; job: RcsJobSnapshot } | { ok: false; status: number; error: string; message: string }
> {
  const userId = await currentUserId();
  const state = userId ? databaseService.getRcsCacheState(userId) : null;
  // P3b: Keepr's consent record (a gate only while RCS_CONSENT_REQUIRED).
  const consent = userId ? databaseService.getRcsConsent(userId) : null;
  // BACKLOG-3668 M3: free disk space, before any staging (sufficient on a check error).
  const disk = userId ? await checkDiskSpaceForOperation("rcsCacheSync").catch(() => null) : null;
  const active = bridge.activeJob();
  const decision = decideCacheStart({
    userId,
    consentVersion: consent?.consentVersion,
    activeLabel: active ? active.label ?? "" : null,
    writesPaused: bridge.writesArePaused,
    diskSufficient: disk ? disk.sufficient : undefined,
  });
  if (!("ok" in decision)) return { ok: false, ...decision };
  // BACKLOG-3666: no Sync until the extension is paired with this Keepr.
  if (!pairingAuth.isPaired(decision.userId)) return { ok: false, ...RCS_NOT_PAIRED_ERROR };
  const plan = await resolveImportPlanForUser({ userId: decision.userId, mode: "delta" });
  // L2: no coverage recorded yet → backfill it from the previous run's floor,
  // only when that run was a full read with a normal list stop that reached it.
  let coveredSince = getSourceCoverage(decision.userId).find((c) => c.source === "google_messages")?.coveredSince ?? null;
  if (!coveredSince) {
    const backfill = backfillCoverageFrom(getRcsCacheRun(decision.userId));
    if (backfill) {
      recordSourceCoverage(decision.userId, "google_messages", backfill, new Date().toISOString());
      coveredSince = backfill;
    }
  }
  const window = cacheWindow({
    nowMs: Date.now(),
    lastFinishedAt: state?.lastCacheFinishedAt,
    coveredSince,
    plan,
    sinceDays: opts.sinceDays,
    isPackaged: app.isPackaged,
  });
  // SR M: a media toggle switched ON since the last Sync: read every chat down
  // to the floor, so chats already in Keepr get their media (cleared by the commit).
  const mediaOptions = getRcsMediaOptions(decision.userId);
  const mediaPending = window.devOverrideDays === null && hasPendingMediaRead(decision.userId);
  const floorISO = new Date(window.limits.floorMs).toISOString();
  const since = mediaPending ? floorISO : window.since;
  const pendingIds = listPendingFullRead(decision.userId);
  // SR (2026-10-02): chats on a live deal older than the settings floor, not
  // yet read back to it: must-see for the list scan (never past the oldest
  // deal start). None with the dev window override.
  const devOverride = window.devOverrideDays !== null;
  const deal = devOverride
    ? { ids: [] as string[], floorISO: null as string | null }
    : dealChatsForClaim(decision.userId, window.limits.floorMs, coveredSince);
  // 3671 P3: staging a crash left: its finished chats are saved (same user,
  // within 7 days), the rest discarded. Then only one Sync at a time.
  await recoverLeftoverStagingFor(decision.userId);
  await cacheStaging().discardAll();
  const job = bridge.createCacheJob(decision.userId, {
    since,
    ownNumbers: state?.ownNumber ? [state.ownNumber] : [],
    readingOlder: window.readingOlder || mediaPending,
    // Live (0.3.15): chats switched back on are read to the full floor.
    floorISO: new Date(window.limits.floorMs).toISOString(),
    pendingConversationIds: pendingIds,
    dealConversationIds: deal.ids,
    dealFloorISO: deal.floorISO,
    // Storyboard H03: after a failed Sync the run skips the chats it saved.
    retrying: !!getFailedRun(decision.userId),
  });
  if (!job) return { ok: false, status: 409, error: "already_syncing", message: "Keepr is already syncing." };
  rcsSyncOutcomes.created(job.jobId, getFailedRun(decision.userId) ? "retry" : window.readingOlder ? "older" : "sync");
  const chatFloors = trackCacheChats(job.jobId, {
    settingsFloorMs: window.limits.floorMs,
    fullRead: since === floorISO,
    devOverride,
    pendingIds,
    sourceCoveredSince: coveredSince,
    tryAgainSince: getFailedRun(decision.userId),
    mediaPending,
  });
  // 3671 P3: the job's own record, with its staging (a crash-cut run is saved from it).
  cacheStaging().beginJob(job.jobId, {
    userId: decision.userId,
    startedAt: job.createdAt,
    limitsJson: JSON.stringify(window.limits),
    readJson: JSON.stringify({ fullRead: since === floorISO, mediaPending, floorISO }),
  });
  // No consent screen (RCS_CONSENT_REQUIRED off): the first Sync records
  // consent_at + the version for audit.
  const recordVersion = consentToRecordOnSync(consent?.consentVersion);
  if (recordVersion !== null) databaseService.setRcsConsent(decision.userId, recordVersion, new Date().toISOString());
  cacheLimitsByJob.set(job.jobId, { ...window.limits, chatFloorsMs: chatFloors });
  cacheReadByJob.set(job.jobId, {
    fullRead: since === floorISO,
    mediaPending,
    floorISO: new Date(window.limits.floorMs).toISOString(),
  });
  cacheOptionsByJob.set(job.jobId, {
    contactsOnly: consent?.contactsOnly === true,
    autoDeleteDays: consent?.autoDeleteDays ?? null,
    photosAllChats: mediaOptions.photosAllChats,
    videosAllChats: mediaOptions.videosAllChats,
  });
  if (window.devOverrideDays !== null) {
    void logService.warn(`[RcsCache] DEV window override: ${window.devOverrideDays} days`, LOG_TAG);
  }
  return { ok: true, job };
}

/** The claim's deal chats (conversation ids) and the oldest of their floors. Never throws. */
export function dealChatsForClaim(userId: string, settingsFloorMs: number, sourceCoveredSince: string | null): { ids: string[]; floorISO: string | null } {
  try {
    const picked = pickDealChats({
      nowMs: Date.now(),
      settingsFloorMs,
      starts: dealChatStarts(userId),
      own: getChatCoverage(userId),
      sourceCoveredSince,
      excluded: new Set(databaseService.rcsExclusionHashes(userId)),
      max: RCS_DEAL_CHATS_MAX,
    });
    const convIds = latestConversationIds(userId, picked.map((p) => p.chatHash));
    const ids: string[] = [];
    let floorMs: number | null = null;
    for (const p of picked) {
      const id = convIds.get(p.chatHash);
      if (!id) continue;
      ids.push(id);
      floorMs = floorMs === null ? p.floorMs : Math.min(floorMs, p.floorMs);
    }
    return { ids, floorISO: floorMs === null ? null : new Date(floorMs).toISOString() };
  } catch (err) {
    void logService.warn("[RcsCache] Deal chats not read (settings floor only): " + scrubRcsText(err), LOG_TAG);
    return { ids: [], floorISO: null };
  }
}

/**
 * BACKLOG-3666: pairing. The protocol is the SAME source the extension runs,
 * bundled into the main-process build at build time (rcsPairProtocol, SR S2);
 * never loaded from the extension folder. Loaded on first use.
 */
const pairingAuth = new RcsPairingAuth(loadPairProtocol, rcsPairingStore);

/** C1: what Keepr's link screen says when a typed code is not taken. One line each. */
export const LINK_ENTER_ERRORS: Record<"no_session" | "expired" | "bad_shape" | "bad_code", string> = {
  no_session: "No code is waiting. Click Link in the Keepr extension first.",
  expired: "That code expired. Click Link in the extension for a new one.",
  bad_shape: "Codes have 6 digits.",
  bad_code: "That code didn't work. Check the extension and try again.",
};

/** Jobs are refused until the extension is paired (BACKLOG-3666). */
export const RCS_NOT_PAIRED_ERROR = { status: 409, error: "not_paired", message: NOT_PAIRED_MESSAGE } as const;

/**
 * BACKLOG-3671 P2: every Google Messages Sync in the sync_outcomes corpus
 * (start at claim, guarded heartbeat, terminal after the save, follow-ups
 * to source_metrics only). Fire-and-forget: it never affects a Sync.
 */
export const rcsSyncOutcomes = new RcsSyncOutcomeTracker({
  start: recordSyncRunStart,
  heartbeat: recordSyncRunProgressWhileRunning,
  terminal: recordSyncOutcomeSettled,
  metrics: recordSyncRunMetrics,
});

const bridge = new RcsExtensionBridge({
  telemetry: rcsSyncOutcomes,
  // BACKLOG-3666: one auth gate before routing (signatures required).
  pairing: pairingAuth,
  // P3c: chats switched off with the eye on their row ("Don't sync").
  chatExcluded: (userId, chatHash, conversationId) => databaseService.checkRcsExclusion(userId, chatHash, conversationId),
  listExclusions: (userId) => databaseService.listRcsExclusionConversationIds(userId, RCS_EXCLUSIONS_MAX),
  setExclusion: (userId, conversationId, excluded) => {
    databaseService.setRcsExclusion(userId, conversationId, excluded);
    hostWindows.broadcast(RCS_DATA_CHANGED_CHANNEL, { reason: "exclusions" });
  },
  // P3b: the contacts-only flag (off by default), frozen per job.
  cacheChatAllowed: (jobId, userId, numbers) =>
    cacheOptionsByJob.get(jobId)?.contactsOnly ? databaseService.rcsNumbersMatchLiveContact(userId, numbers) : true,
  // SR M: photos / videos kept — a transaction contact, or the job's "all chats" toggles (same rule as importCacheImage).
  cacheMediaKept: (jobId, userId, numbers) =>
    mediaKeptFor(cacheOptionsByJob.get(jobId), databaseService.rcsNumbersMatchLiveContact(userId, numbers)),
  // SR (2026-10-02): a deal chat's own floor (Keepr computes it; the page never sends one).
  cacheChatFloor: (jobId, userId, conversationId, numbers) => cacheChatFloorFor(jobId, userId, conversationId, numbers),
  // 3671 P3 "Try again": a chat the failed run already finished is skipped.
  cacheChatSkip: (jobId, userId, conversationId, numbers) => cacheChatSkipFor(jobId, userId, conversationId, numbers),
  onMediaCounts: (userId, counts) => {
    try {
      recordRcsMediaSeen(userId, counts.photosSeen, counts.videosSeen);
    } catch {
      /* the estimate is best-effort */
    }
  },
  // BACKLOG-3658: a cache job STAGES; only a finished job commits (atomic).
  importCacheChat: async (chat, userId, people, jobId) => {
    const r = await cacheStaging().stageChat(jobId, userId, chat, people, rcsChatHash(people.numbers));
    noteCacheChatRead(jobId, people.numbers, chat.reachedFloor);
    return r;
  },
  importCacheImage: async (image, userId, chatHash, numbers, jobId) => {
    // SR M: photos for chats with a live transaction contact, or every chat when
    // "Download photos from all chats" is on (frozen for this job).
    if (!mediaKeptFor(cacheOptionsByJob.get(jobId), databaseService.rcsNumbersMatchLiveContact(userId, numbers)).photos) {
      return { stored: false, reason: "not_a_contact" };
    }
    return cacheStaging().stageImage(jobId, image, chatHash);
  },
  currentUserId,
  // C5: "Try again" on the page — only after a failed Sync of the signed-in user.
  onRetryRequested: async () => {
    const r = await retryCacheSync();
    return r.ok ? { ok: true, jobId: r.job.jobId } : { ok: false, status: r.status, error: r.error, message: r.message };
  },
  // C1 (founder): who the browser is linked to — masked by the bridge, signed /status only.
  currentUserEmail: async () => {
    try {
      const session = await sessionService.loadSession();
      return session?.user?.email ?? null;
    } catch {
      return null;
    }
  },
  onHello: (hello) => void onHello(hello),
  onJobEnded: (ended) => {
    // For a support ticket's diagnostics: the state and the code only.
    lastRunEnded = {
      state: ended.snapshot.state,
      reasonCode: ended.snapshot.error?.code ?? null,
      endedAt: new Date().toISOString(),
    };
    // Founder (2026-10-01): a Sync that is done or failed brings Keepr to the
    // front by itself (the page's "Open Keepr" stays as the fallback); a
    // cancel does not. The /focus route's mechanism, incl. the taskbar flash.
    if (shouldFocusKeeprOnJobEnd(ended.snapshot.state)) focusKeeprFromBrowser();
    if (ended.kind !== "cache") return;
    // SR F2: a STOP (cancel) is final at once — the job's record goes now,
    // synchronously, so a quit before the async discard can never let the
    // next start save a stopped run.
    if (ended.snapshot.state === "cancelled") cacheStaging().markStopped(ended.snapshot.jobId);
    // Busy from this moment (synchronously, before the job slot can be reused).
    cacheEndsInFlight += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      cacheEndsInFlight -= 1;
    };
    const jobId = ended.snapshot.jobId;
    const hung = setTimeout(() => {
      if (released) return;
      void logService.error(
        `[RcsCache] Saving the cache Sync did not finish in ${RCS_CACHE_SAVE_TIMEOUT_MS / 60000} minutes: its staging is dropped`,
        LOG_TAG,
      );
      release();
      cacheLimitsByJob.delete(jobId);
      cacheReadByJob.delete(jobId);
      cacheOptionsByJob.delete(jobId);
      void cacheStaging().abandon(jobId).catch(() => undefined);
    }, RCS_CACHE_SAVE_TIMEOUT_MS);
    hung.unref?.();
    void handleCacheJobEnded(ended, {
      saveFinishedAt: (userId, iso) => databaseService.updateRcsCacheState(userId, { lastCacheFinishedAt: iso }),
      saveOwnNumber: (userId, number) => databaseService.updateRcsCacheState(userId, { ownNumber: number }),
      commit: commitCacheJob,
      discard: discardCacheJob,
      autoLink: (userId) => autoLinkNewMessagesForUser(userId),
      afterLink: (userId) => afterCacheLinked(jobId, userId),
      // SR S1: open views refetch only once the texts are saved AND linked.
      onSaved: () => hostWindows.broadcast(RCS_DATA_CHANGED_CHANNEL, { reason: "cache-saved" }),
      now: () => Date.now(),
      log: (m) => void logService.warn(m, LOG_TAG),
      info: (m) => void logService.info(m, LOG_TAG),
    })
      .finally(() => {
        clearTimeout(hung);
        release();
        // Not saved (the commit failed or was dropped): the done screens say
        // so instead of waiting. A no-op once the save was recorded.
        if (ended.snapshot.state === "finished") bridge.recordCacheSaved(jobId, null);
      })
      .catch((err: unknown) => {
        void logService.error(
          `[RcsCache] After the cache Sync: ${scrubRcsText(err)}`,
          LOG_TAG,
        );
      });
  },
  onJobChanged: broadcastJob,
  // (A finished or failed job brings Keepr forward from onJobEnded above.)
  // BACKLOG-3641: "Open Keepr" on the page (POST /focus).
  // Founder Option 1: while a link code is waiting, /focus also opens the
  // Sync Android modal at its link step (the code field focused there).
  onFocusRequested: () =>
    focusForBrowser({
      focus: focusKeeprFromBrowser,
      focusForLink: () => bringAppToFrontForLink(getMainWindow()),
      linkState: () => pairingAuth.linkState(),
      openLinkScreen: () => hostWindows.broadcast(RCS_OPEN_LINK_SCREEN_CHANNEL, {}),
    }),
  logger: {
    info: (m) => void logService.info(m, LOG_TAG),
    warn: (m) => void logService.warn(m, LOG_TAG),
    error: (m) => void logService.error(m, LOG_TAG),
  },
});

/**
 * "Try again" after a failed Google Messages Sync (the page's /cache/retry
 * and Keepr's own button): only when the signed-in user's last Sync failed;
 * the new run skips the chats the failed one saved (tryAgainSince).
 */
export async function retryCacheSync(): Promise<
  { ok: true; job: RcsJobSnapshot } | { ok: false; status: number; error: string; message?: string }
> {
  const userId = await currentUserId();
  if (!userId) return { ok: false, status: 401, error: "signed_out", message: "Sign in to Keepr first." };
  if (!getFailedRun(userId)) return { ok: false, status: 409, error: "nothing_to_retry", message: "There is no failed Sync to try again." };
  const r = await startCacheJob({});
  return r.ok ? { ok: true, job: r.job } : { ok: false, status: r.status, error: r.error, message: r.message };
}

/** Start the loopback bridge. Never throws; a taken port leaves it "unavailable". */
export async function startRcsExtensionBridge(): Promise<void> {
  await bridge.start();
  // 3671 P3: a Sync a crash cut short — its finished chats, for the signed-in user only.
  void currentUserId()
    .then((userId) => recoverLeftoverStaging(userId))
    .catch(() => undefined);
}

export async function stopRcsExtensionBridge(): Promise<void> {
  // Quit: a running cache Sync is not committed — its staging goes.
  const active = bridge.activeJob();
  // SR F2: a quit is a stop — recorded synchronously before anything async.
  if (active && staging) staging.markStopped(active.jobId);
  if (active) bridge.cancelJob(active.jobId);
  // A quit is a stop: the running Sync's staging goes. (3671 P3: staging a
  // crash left is kept for the next start's recovery.)
  if (staging && active) await staging.discard(active.jobId).catch(() => undefined);
  await bridge.stop();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${name} is required`, name);
  }
  return value;
}

function argsObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

/**
 * BACKLOG-3657: clear every Google Messages for Web text of the user (Force
 * re-import). Writes are paused first — new chats/images refused, the running
 * Sync cancelled, writes in progress drained — so nothing lands between the
 * cancel and the delete; they resume afterwards, whatever happens. Open
 * transaction views are told to refetch.
 */
export async function clearGoogleMessagesWebTexts(userId: string): Promise<RcsClearResult> {
  // SR B1: never while a cache Sync is being saved (it is moving files in).
  if (cacheSaveInFlight()) throw new Error(RCS_SAVING_MESSAGE);
  return runWithWritesPaused(bridge, () => {
    // SR (G1): the texts and every cache record go in ONE transaction.
    const result = clearGoogleMessagesWebData(
      userId,
      databaseService.rcsClearDbOps(),
      clearFiles(),
      (m) => void logService.info(m, LOG_TAG),
      () => resetGoogleMessagesCacheRecords(userId),
    );
    hostWindows.broadcast(RCS_DATA_CLEARED_CHANNEL, { messagesDeleted: result.messagesDeleted });
    return result;
  });
}

/**
 * Force re-import: the cache's records go with the texts. Called inside the
 * clear's transaction (a nested transaction is a savepoint: all or nothing).
 */
export function resetGoogleMessagesCacheRecords(userId: string): void {
  dbTransaction(() => {
    // BACKLOG-3658: the next cache Sync starts over and re-learns the own number.
    databaseService.resetRcsCacheState(userId);
    // BACKLOG-3663: and its coverage is gone with the texts (per chat too).
    forgetSourceCoverage(userId, "google_messages");
    clearChatCoverage(userId);
    clearRcsCacheRun(userId);
    clearAllPendingFullRead(userId);
    // 3671 P3 (SR): every staged run and the placed-files journal, the read
    // records and the failed-run marker go too.
    cacheStaging().dropAllRowsForForce();
    clearChatReads(userId);
    clearFailedRun(userId);
  });
}

/**
 * BACKLOG-3657 (founder re-confirmed 2026-10-01): Android's Force re-import is
 * SHARED — from either Android section (Google Messages or the companion) it
 * clears both Android sources: the Google Messages texts (with their images,
 * links, the cache's last sync and coverage) FIRST, then the companion's
 * texts and contacts. iPhone and Mac data are never touched.
 */
export async function clearAllAndroidTexts(userId: string): Promise<SharedForceClearResult & { gmweb?: RcsClearResult }> {
  // Loaded on use: the companion service pulls in its HTTP server and cloud sync.
  const { default: localSyncService } = await import("../services/localSyncService");
  let gmweb: RcsClearResult | undefined;
  const result = await runSharedForceClear({
    clearGmweb: async () => (gmweb = await clearGoogleMessagesWebTexts(userId)),
    clearAndroid: () => localSyncService.clearAndroidData(userId),
  });
  void logService.info(
    `[RcsClear] Android Force re-import: google messages ${result.gmwebCleared ? "cleared" : "not cleared"} (${result.gmwebMessagesDeleted}), ` +
      `companion ${result.androidCleared ? "cleared" : "not cleared"} (${result.messagesDeleted} texts, ${result.contactsDeleted} contacts)`,
    LOG_TAG,
  );
  return { ...result, gmweb };
}

/**
 * BACKLOG-3641: bring Keepr forward because the user asked from the browser
 * ("Open Keepr"). Windows may still refuse the foreground change, so the
 * taskbar button flashes as the fallback, until Keepr gets focus.
 */
/** keepr://link: the link code from the clipboard (Windows, link waiting, exactly the code) — see linkCodeFromClipboard. */
export function rcsLinkCodeForDeepLink(): string | null {
  return linkCodeFromClipboard({
    platform: process.platform,
    linkState: () => pairingAuth.linkState(),
    readClipboard: () => clipboard.readText(),
  });
}

export function focusKeeprFromBrowser(): void {
  bringAppToFrontOrFlash(getMainWindow());
}

/** The last Sync that ended since Keepr started (state + code only; for ticket diagnostics). */
let lastRunEnded: { state: string; reasonCode: string | null; endedAt: string } | null = null;

/** Founder (2026-10-06): the Google Messages section of a support ticket — local state only. */
export function googleMessagesDiagnostics(userId: string | null): GoogleMessagesDiagnostics {
  const state = userId ? databaseService.getRcsCacheState(userId) : null;
  const link: GoogleMessagesDiagnostics["link"] = userId
    ? pairingAuth.isLinkProven(userId) ? "linked" : pairingAuth.isPaired(userId) ? "saved" : "none"
    : "none";
  return {
    extension_version_seen: extensionPresence.version ?? state?.extensionVersion ?? null,
    extension_seen_at: extensionPresence.seenAt ?? state?.extensionSeenAt ?? null,
    link,
    last_cache_finished_at: state?.lastCacheFinishedAt ?? null,
    last_run: lastRunEnded
      ? { state: lastRunEnded.state, reason_code: lastRunEnded.reasonCode === null ? null : cleanReasonCode(lastRunEnded.reasonCode), ended_at: lastRunEnded.endedAt }
      : null,
    failed_run_started_at: userId ? getFailedRun(userId) : null,
  };
}

/** The signed-in user, read synchronously for the ticket (the session's last known user). */
setGoogleMessagesDiagnosticsProvider(() => googleMessagesDiagnostics(lastSessionUserId));

export function registerRcsImportHandlers(): void {
  ipcMain.handle(
    "rcs-import:get-status",
    wrapHandler(async (): Promise<RcsImportStatusResult> => {
      return { success: true, status: bridge.getStatus() };
    }, RCS_HANDLER_OPTIONS),
  );

  ipcMain.handle(
    "rcs-import:cancel-job",
    wrapHandler(async (_event, args: unknown): Promise<RcsImportJobResult> => {
      const jobId = requireString(argsObject(args).jobId, "jobId");
      bridge.cancelJob(jobId);
      return { success: true, job: bridge.getJob() };
    }, RCS_HANDLER_OPTIONS),
  );

  // Founder (2026-10-04): Keepr's own "Try again" for a failed Google
  // Messages Sync (dashboard bubble, Sync flow) — the page's /cache/retry:
  // only after a failed Sync (the chats it saved are skipped); the Messages
  // tab is opened for the job as Sync does.
  ipcMain.handle(
    "rcs-import:retry-cache-job",
    wrapHandler(async (): Promise<RcsImportJobResult> => {
      if (bridge.getStatus().bridge !== "listening") {
        const st = bridge.getStatus();
        return { success: false, error: `Import bridge unavailable${st.reason ? `: ${st.reason}` : ""}.` };
      }
      const r = await retryCacheSync();
      if (!r.ok) return { success: false, error: r.message ?? "Keepr could not start the Sync." };
      await shell.openExternal(`${RCS_MESSAGES_WEB_URL}#keepr-job=${r.job.jobId}`);
      return { success: true, job: r.job };
    }, RCS_HANDLER_OPTIONS),
  );

  // BACKLOG-3658: the cache job (the dashboard's "Sync Android" uses it, P3).
  ipcMain.handle(
    "rcs-import:start-cache-job",
    wrapHandler(async (_event, args: unknown): Promise<RcsImportJobResult> => {
      if (bridge.getStatus().bridge !== "listening") {
        const st = bridge.getStatus();
        return { success: false, error: `Import bridge unavailable${st.reason ? `: ${st.reason}` : ""}.` };
      }
      // DEV ONLY (ignored in a packaged build): { sinceDays } widens the window.
      const started = await startCacheJob({ sinceDays: argsObject(args).sinceDays });
      if (!started.ok) return { success: false, error: started.message };
      await shell.openExternal(`${RCS_MESSAGES_WEB_URL}#keepr-job=${started.job.jobId}`);
      return { success: true, job: started.job };
    }, RCS_HANDLER_OPTIONS),
  );

  // SR (C7 review) F1: the P1 developer shortcut "set-cache-opt-in" (it wrote
  // the current consent with no screen and no version check, in any build)
  // is removed — unused; consent goes only through set-cache-consent.

  // P3b: the consent the user read and accepted (version of the text shown),
  // or withdrawn (version null). An out-of-date version is refused.
  ipcMain.handle(
    "rcs-import:set-cache-consent",
    wrapHandler(async (_event, args: unknown): Promise<{ success: boolean; error?: string }> => {
      const version = argsObject(args).version;
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      if (version !== null && version !== RCS_CONSENT_VERSION) {
        return { success: false, error: "This consent text is out of date. Close and open Sync Android again." };
      }
      databaseService.setRcsConsent(userId, version as number | null, new Date().toISOString());
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  // P3b: cache options. autoDelete: a user setting (off by default; 90 days).
  // contactsOnly: a feature flag, settable only in a development build.
  ipcMain.handle(
    "rcs-import:set-cache-options",
    wrapHandler(async (_event, args: unknown): Promise<{ success: boolean; error?: string }> => {
      const a = argsObject(args);
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      const patch: { autoDeleteDays?: number | null; contactsOnly?: boolean } = {};
      if (typeof a.autoDelete === "boolean") patch.autoDeleteDays = a.autoDelete ? RCS_AUTO_DELETE_DAYS : null;
      if (typeof a.contactsOnly === "boolean" && !app.isPackaged) patch.contactsOnly = a.contactsOnly;
      databaseService.setRcsCacheOptions(userId, patch);
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  // SR M: Settings → Google Messages → "Download photos / videos from all chats".
  ipcMain.handle(
    "rcs-import:set-media-options",
    wrapHandler(async (_event, args: unknown): Promise<{ success: boolean; error?: string }> => {
      const a = argsObject(args);
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      const patch: { photosAllChats?: boolean; videosAllChats?: boolean } = {};
      if (typeof a.photosAllChats === "boolean") patch.photosAllChats = a.photosAllChats;
      if (typeof a.videosAllChats === "boolean") patch.videosAllChats = a.videosAllChats;
      setRcsMediaOptions(userId, patch);
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  // C4 (UX redesign): Keepr no longer makes pairing codes — the extension's
  // popup makes the link code (C1). The old IPCs are gone.

  // C1 (UX redesign): Keepr's "Enter the code from your browser" screen.
  ipcMain.handle(
    "rcs-import:link-state",
    wrapHandler(async (): Promise<{ success: true; link: LinkState; linked: boolean; clipboardFill: boolean }> => {
      const userId = await currentUserId();
      return {
        success: true,
        link: pairingAuth.linkState(),
        linked: userId ? pairingAuth.isLinkProven(userId) : false,
        // Founder: the box fills itself from "Copy code and open Keepr" here
        // (the same rule as the fill) — the link screen says so.
        clipboardFill: linkCodeAutoFillOn(process.platform),
      };
    }, RCS_HANDLER_OPTIONS),
  );

  ipcMain.handle(
    "rcs-import:link-enter-code",
    wrapHandler(async (_event: unknown, args?: unknown): Promise<{ success: true } | { success: false; error: string }> => {
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      const code = args && typeof args === "object" ? (args as { code?: unknown }).code : undefined;
      const r = pairingAuth.linkEnterCode(userId, typeof code === "string" ? code : "");
      if (r.ok) {
        // Founder (Windows): the accepted code leaves the clipboard — only if
        // it still holds that same code (never logged).
        clearLinkCodeFromClipboard({
          platform: process.platform,
          code: typeof code === "string" ? code : "",
          readClipboard: () => clipboard.readText(),
          clearClipboard: () => clipboard.clear(),
        });
        return { success: true };
      }
      return { success: false, error: LINK_ENTER_ERRORS[r.reason] };
    }, RCS_HANDLER_OPTIONS),
  );

  // SR (B1): Keepr's own "Forget link" — one of the only ways a link is deleted
  // (with a signed /link/unlink, a new link, and sign-out / a user switch).
  ipcMain.handle(
    "rcs-import:link-forget",
    wrapHandler(async (): Promise<{ success: true }> => {
      const userId = await currentUserId();
      if (userId) pairingAuth.forgetLink(userId);
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  // Founder (KeeprLinkPrompt): "Open Google Messages" on the link screen —
  // works without a link (Keepr opens the page; no bridge involved).
  ipcMain.handle(
    "rcs-import:open-google-messages",
    wrapHandler(async (): Promise<{ success: true }> => {
      // Live (founder): #keepr-link — the extension moves to the Messages tab
      // already open (closing this new one) and opens its link window. With
      // no extension, a plain Messages tab as before.
      await shell.openExternal(`${RCS_MESSAGES_WEB_URL}#${RCS_LINK_HASH}`);
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  // A02: "Add to Chrome" — the store listing (a fixed URL, nothing from the renderer).
  ipcMain.handle(
    "rcs-import:open-extension-store",
    wrapHandler(async (): Promise<{ success: true }> => {
      await shell.openExternal(RCS_EXTENSION_STORE_URL);
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  ipcMain.handle(
    "rcs-import:link-dismiss-warning",
    wrapHandler(async (): Promise<{ success: true }> => {
      pairingAuth.clearLinkIntrusion();
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  ipcMain.handle(
    "rcs-import:get-extension-state",
    wrapHandler(async (): Promise<RcsExtensionStateResult> => {
      const userId = await currentUserId();
      const state = userId ? databaseService.getRcsCacheState(userId) : null;
      const consent = userId ? databaseService.getRcsConsent(userId) : null;
      const seenVersion = extensionPresence.version ?? state?.extensionVersion ?? null;
      return {
        success: true,
        state: {
          extensionVersion: seenVersion,
          // Live (founder): the extension seen is older than the one this Keepr ships.
          extensionUpdateReady: isOlderVersion(seenVersion, await bundledExtensionVersion()),
          extensionSeenAt: extensionPresence.seenAt ?? state?.extensionSeenAt ?? null,
          pairedAt: extensionPresence.pairedAt ?? state?.pairedAt ?? null,
          optedIn: consentIsCurrent(consent?.consentVersion),
          lastCacheFinishedAt: state?.lastCacheFinishedAt ?? null,
          consentVersion: consent?.consentVersion ?? null,
          consentRequired: RCS_CONSENT_VERSION,
          consentAt: consent?.consentAt ?? null,
          autoDeleteDays: consent?.autoDeleteDays ?? null,
          // The months a cache Sync copies (messageImport.filters; null = All time).
          lookbackMonths: userId ? resolveLookbackMonths(await loadStoredImportFilters(userId)) : undefined,
          media: userId ? getRcsMediaOptions(userId) : undefined,
          // BACKLOG-3666: the extension is paired with this Keepr, for this user.
          // Live (B1): "linked" only when the extension proved it (a signed call) recently.
          extensionPaired: userId ? pairingAuth.isLinkProven(userId) : false,
          // Live (0.3.76): a saved pairing (proof is in memory, empty after a
          // restart) and whether an extension said "no link here" since.
          pairingSaved: userId ? pairingAuth.isPaired(userId) : false,
          linkNotHere: userId ? pairingAuth.linkNotHere(userId) : false,
          // SR (C6 review): the Android Companion's texts exist (Force re-import names it only then).
          companionData: userId ? getSourceCoverage(userId).some((c) => c.source === "android_companion") : false,
          // SR: the pairing code shown was used up by wrong attempts.
        },
      };
    }, RCS_HANDLER_OPTIONS),
  );

  // BACKLOG-3658 P3c: Settings → Google Messages → chats not synced (read-only
  // since 2026-10-02: the page's eye is the only switch). Titles stay in Keepr.
  ipcMain.handle(
    "rcs-import:list-exclusions",
    wrapHandler(async (): Promise<{ success: true; chats: Array<{ id: string; title: string | null; createdAt: string }> } | { success: false; error: string }> => {
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      return { success: true, chats: databaseService.listRcsExclusionsForSettings(userId) };
    }, RCS_HANDLER_OPTIONS),
  );

  // BACKLOG-3659 P3d: Settings → Google Messages → Force re-import (its own,
  // apart from the Android companion's).
  ipcMain.handle(
    "rcs-import:clear-texts",
    wrapHandler(async (): Promise<RcsClearTextsResult> => {
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      // Shared with the companion's Force re-import (clearAllAndroidTexts).
      const r = await clearAllAndroidTexts(userId);
      if (r.error) return { success: false, error: r.error };
      return {
        success: true,
        messagesDeleted: r.gmwebMessagesDeleted,
        linksDeleted: r.gmweb?.linksDeleted ?? 0,
        filesDeleted: r.gmweb?.filesDeleted ?? 0,
        androidMessagesDeleted: r.messagesDeleted,
        contactsDeleted: r.contactsDeleted,
      };
    }, RCS_HANDLER_OPTIONS),
  );

  // BACKLOG-3659: deliver the extension (Release 1: unpacked, from Downloads).
  ipcMain.handle(
    "rcs-import:prepare-extension",
    wrapHandler(async (): Promise<{ success: true; folder: string; version: string } | { success: false; error: string }> => {
      try {
        // Concurrent callers (StrictMode runs the effect twice) share one run.
        const out = await prepareExtensionFolderShared(bundledExtensionDir(), app.getPath("downloads"), deliveryFs);
        return { success: true, ...out };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }, RCS_HANDLER_OPTIONS),
  );

  // Live (founder): at app start (the renderer, while the extension is not in
  // the store), refresh a Downloads copy older than the bundled extension.
  ipcMain.handle(
    "rcs-import:refresh-extension-folder",
    wrapHandler(async (): Promise<{ success: true; refreshed: boolean; bundledVersion: string | null; error?: string }> => {
      const r = await refreshExtensionFolderIfOlder(bundledExtensionDir(), app.getPath("downloads"), deliveryFs);
      if (r.refreshed) void logService.info("[RcsImport] Extension folder refreshed to " + r.bundledVersion, LOG_TAG);
      else if (r.error) void logService.warn("[RcsImport] Extension folder not refreshed (in use)", LOG_TAG);
      return { success: true, ...r };
    }, RCS_HANDLER_OPTIONS),
  );

  ipcMain.handle(
    "rcs-import:show-extension-folder",
    wrapHandler(async (): Promise<{ success: boolean }> => {
      shell.showItemInFolder(path.join(extensionTargetDir(app.getPath("downloads")), "manifest.json"));
      return { success: true };
    }, RCS_HANDLER_OPTIONS),
  );

  // Chrome refuses chrome:// addresses from other apps: copy it, start Chrome.
  ipcMain.handle(
    "rcs-import:open-chrome-for-extension",
    wrapHandler(async (): Promise<{ success: true; copied: boolean; opened: boolean }> => {
      clipboard.writeText(CHROME_EXTENSIONS_ADDRESS);
      const opened = await launchChrome(
        chromeCandidates(process.platform, process.env),
        (p) => fs.promises.access(p).then(() => true, () => false),
        (candidate) =>
          process.platform === "darwin"
            ? spawn("open", ["-a", candidate], { detached: true, stdio: "ignore" })
            : spawn(candidate, [], { detached: true, stdio: "ignore" }),
      );
      return { success: true, copied: true, opened };
    }, RCS_HANDLER_OPTIONS),
  );

  ipcMain.handle(
    "rcs-import:get-job",
    wrapHandler(async (): Promise<RcsImportJobResult> => {
      return { success: true, job: bridge.getJob() };
    }, RCS_HANDLER_OPTIONS),
  );
}

