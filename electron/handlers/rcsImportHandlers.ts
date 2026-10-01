/**
 * RCS import IPC — BACKLOG-3619 (proof of concept).
 *
 * Owns the one {@link RcsExtensionBridge} instance, wires it to the real
 * storage (`databaseService.batchInsertMessages`, `getMessageIdMap`,
 * `transactionService.linkMessages`), and exposes three channels to the
 * Messages tab's Import panel:
 *
 * - `rcs-import:get-status`
 * - `rcs-import:start-session` { transactionId }
 * - `rcs-import:end-session`   { sessionId }
 *
 * Each stored chat is pushed to every window on `rcs-import:chat-received`.
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
import * as path from "path";

import { app, ipcMain, shell } from "electron";

import { hostWindows } from "../capabilities/windowsProvider";
import { dbTransaction } from "../services/db/core/dbConnection";
import databaseService from "../services/databaseService";
import logService from "../services/logService";
import { RcsExtensionBridge, type RcsChatImportedEvent } from "../services/rcsExtensionBridge";
import { createCommunicationReference } from "../services/messageMatchingService";
import type { RcsJobContact, RcsJobSnapshot } from "../services/rcsImportJob";
import { rcsImageFilename, storeImage, type RcsMediaDeps } from "../services/rcsImportMedia";
import { importChat, rcsChatHash, rcsExternalId, storeCacheChatSync, type RcsImportDeps } from "../services/rcsImportStore";
import { RcsCacheStaging, type CacheLimits, type RcsCommitWriter } from "../services/rcsCacheStaging";
import { resolveImportPlanForUser } from "../services/importPlanInputs";
import {
  cacheWindow,
  cancelOnSessionChange,
  decideCacheStart,
  handleCacheJobEnded,
  shouldPersistHello,
} from "../services/rcsCacheService";
import { onSessionChanged } from "../services/authEvents";
import { autoLinkNewMessagesForUser } from "../services/autoLinkService";
import sessionService from "../services/sessionService";
import { clearGoogleMessagesWebData, runWithWritesPaused, type RcsClearResult } from "../services/rcsClearService";
import transactionService from "../services/transactionService";
import { bringAppToFront, bringAppToFrontOrFlash } from "../utils/bringAppToFront";
import { wrapHandler } from "../utils/wrapHandler";
import { getMainWindow } from "../windowRegistry";
import { ValidationError } from "../utils/validation";
import type {
  RcsExtensionStateResult,
  RcsChatReceivedEvent,
  RcsImportJobResult,
  RcsImportStatusResult,
} from "../types/ipc/window-api-rcs-import";

const LOG_TAG = "RcsImport";
export const RCS_CHAT_RECEIVED_CHANNEL = "rcs-import:chat-received";
export const RCS_JOB_PROGRESS_CHANNEL = "rcs-import:job-progress";
export const RCS_MESSAGES_WEB_URL = "https://messages.google.com/web/conversations";
/** BACKLOG-3661: the start-job refusal while another Sync runs. */
export const RCS_ALREADY_SYNCING_MESSAGE = "Keepr is already syncing";
/** BACKLOG-3657: Google Messages for Web texts were cleared; open views refetch. */
export const RCS_DATA_CLEARED_CHANNEL = "rcs-import:data-cleared";
/** BACKLOG-3658 (SR S1): a cache Sync was saved and auto-linked; open views refetch. */
export const RCS_DATA_CHANGED_CHANNEL = "rcs-import:data-changed";
/** SR B1: refusal while a finished cache Sync is still being saved. */
export const RCS_SAVING_MESSAGE = "Keepr is still saving the last Sync. Try again in a moment.";

const deps: RcsImportDeps = {
  getTransactionUserId: async (transactionId) => {
    const tx = await databaseService.getTransactionById(transactionId);
    return tx ? tx.user_id : null;
  },
  batchInsertMessages: (rows, batchSize) => databaseService.batchInsertMessages(rows, batchSize),
  getMessageIdMap: (userId) => databaseService.getMessageIdMap(userId),
  linkMessages: (ids, transactionId) => transactionService.linkMessages(ids, transactionId),
  insertReactionRows: (rows) => databaseService.insertReactionRows(rows),
  // Reactions: linked like a manual attach, but message_count is left alone.
  linkWithoutCount: async (ids, transactionId, userId) => {
    for (const id of ids) {
      await databaseService.linkMessageToTransaction(id, transactionId);
      await createCommunicationReference(id, transactionId, userId, "manual", 1.0);
    }
  },
  // BACKLOG-3642: never re-link what the user removed from the transaction.
  getRemovals: (transactionId, userId) => databaseService.getRcsRemovals(transactionId, userId),
  // BACKLOG-3630: the content guard (same sent_at + direction + body).
  findContentDuplicates: (userId, rows) => databaseService.findRcsContentDuplicates(userId, rows),
  // BACKLOG-3665: a legacy chat removal moves onto the gmweb2 thread.
  repointLegacyRemoval: (userId, legacy, threadId, transactionId) =>
    databaseService.repointLegacyRcsRemoval(userId, legacy, threadId, transactionId),
};

const mediaDeps: RcsMediaDeps = {
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
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
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
    writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
    exists: mediaDeps.fileExists,
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
const commitWriter: RcsCommitWriter = {
  storeChat: (chat, userId, people) => storeCacheChatSync(chat, userId, deps, people),
  getMessageIdMap: (userId) => databaseService.getMessageIdMap(userId),
  getExistingAttachmentRecords: () => databaseService.getExistingAttachmentRecords(),
  insertAttachment: (params) => databaseService.insertAttachment(params),
  markMessageHasAttachments: (messageId) => databaseService.markMessageHasAttachments(messageId),
  externalId: rcsExternalId,
  imageFilename: rcsImageFilename,
};

/** The limits each cache job was started with (frozen at start; used by its commit). */
const cacheLimitsByJob = new Map<string, CacheLimits>();

async function commitCacheJob(jobId: string, userId: string): Promise<void> {
  const limits = cacheLimitsByJob.get(jobId);
  cacheLimitsByJob.delete(jobId);
  if (!limits) {
    // Never started here (should not happen): keep nothing rather than guess.
    await cacheStaging().discard(jobId);
    throw new Error("No limits recorded for this Sync");
  }
  const r = await cacheStaging().commit(jobId, userId, limits, commitWriter);
  void logService.info(
    `[RcsCache] Cache Sync saved: ${r.staged} staged, ${r.kept} kept (${r.droppedByDate} older than the months setting; ` +
      `no max-messages cap for this source); ${r.chats} chats, ${r.stored} new, ${r.alreadyPresent} already there; ` +
      `images ${r.imagesStored} of ${r.imagesStaged}`,
    LOG_TAG,
  );
}

async function discardCacheJob(jobId: string): Promise<void> {
  cacheLimitsByJob.delete(jobId);
  await cacheStaging().discard(jobId);
}

function broadcastJob(job: RcsJobSnapshot): void {
  hostWindows.broadcast(RCS_JOB_PROGRESS_CHANNEL, job);
}

function broadcastChatImported(event: RcsChatImportedEvent): void {
  const payload: RcsChatReceivedEvent = {
    sessionId: event.sessionId,
    transactionId: event.transactionId,
    conversationTitle: event.conversationTitle,
    ...event.result,
    session: event.session,
  };
  void logService.info(
    `Chat imported: ${event.result.received} received, ${event.result.stored} new, ${event.result.linked} linked, ` +
      `${event.result.removedByUser ?? 0} removed by you not re-linked`,
    LOG_TAG,
  );
  hostWindows.broadcast(RCS_CHAT_RECEIVED_CHANNEL, payload);
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
  return cachedUserId;
}

// A running Sync belongs to the user who started it: signing out cancels it;
// another user signing in cancels it too (and the bridge re-checks per write).
onSessionChanged((change) => {
  cachedUserId = undefined;
  if (cancelOnSessionChange(change, bridge.activeJobUserId(), !!bridge.activeJob())) bridge.cancelJob();
});

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
  const active = bridge.activeJob();
  const decision = decideCacheStart({
    userId,
    optedIn: !!state?.optedInAt,
    activeLabel: active ? active.label ?? "" : null,
    writesPaused: bridge.writesArePaused,
  });
  if (!("ok" in decision)) return { ok: false, ...decision };
  const plan = await resolveImportPlanForUser({ userId: decision.userId, mode: "delta" });
  const window = cacheWindow({
    nowMs: Date.now(),
    lastFinishedAt: state?.lastCacheFinishedAt,
    plan,
    sinceDays: opts.sinceDays,
    isPackaged: app.isPackaged,
  });
  // Only one Sync at a time: any staging left now is stale (a crash, a quit).
  await cacheStaging().discardAll();
  const job = bridge.createCacheJob(decision.userId, {
    since: window.since,
    ownNumbers: state?.ownNumber ? [state.ownNumber] : [],
  });
  if (!job) return { ok: false, status: 409, error: "already_syncing", message: "Keepr is already syncing." };
  cacheLimitsByJob.set(job.jobId, window.limits);
  if (window.devOverrideDays !== null) {
    void logService.warn(`[RcsCache] DEV window override: ${window.devOverrideDays} days`, LOG_TAG);
  }
  return { ok: true, job };
}

const bridge = new RcsExtensionBridge({
  importChat: (chat, transactionId, people) => importChat(chat, transactionId, deps, people),
  // BACKLOG-3658: a cache job STAGES; only a finished job commits (atomic).
  importCacheChat: async (chat, userId, people, jobId) =>
    cacheStaging().stageChat(jobId, userId, chat, people, rcsChatHash(people.numbers)),
  importCacheImage: async (image, userId, chatHash, numbers, jobId) => {
    // Images only for chats with a live transaction contact (BACKLOG-3658).
    if (!databaseService.rcsNumbersMatchLiveContact(userId, numbers)) return { stored: false, reason: "not_a_contact" };
    return cacheStaging().stageImage(jobId, image, chatHash);
  },
  currentUserId,
  onHello: (hello) => void onHello(hello),
  onJobEnded: (ended) => {
    if (ended.kind !== "cache") return;
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
      void cacheStaging().abandon(jobId).catch(() => undefined);
    }, RCS_CACHE_SAVE_TIMEOUT_MS);
    hung.unref?.();
    void handleCacheJobEnded(ended, {
      saveFinishedAt: (userId, iso) => databaseService.updateRcsCacheState(userId, { lastCacheFinishedAt: iso }),
      saveOwnNumber: (userId, number) => databaseService.updateRcsCacheState(userId, { ownNumber: number }),
      commit: commitCacheJob,
      discard: discardCacheJob,
      autoLink: (userId) => autoLinkNewMessagesForUser(userId),
      // SR S1: open views refetch only once the texts are saved AND linked.
      onSaved: () => hostWindows.broadcast(RCS_DATA_CHANGED_CHANNEL, { reason: "cache-saved" }),
      now: () => Date.now(),
      log: (m) => void logService.warn(m, LOG_TAG),
    })
      .finally(() => {
        clearTimeout(hung);
        release();
      })
      .catch((err: unknown) => {
        void logService.error(
          `[RcsCache] After the cache Sync: ${err instanceof Error ? err.message : String(err)}`,
          LOG_TAG,
        );
      });
  },
  onChatImported: broadcastChatImported,
  importImage: async (image, transactionId, chatHash) => {
    const userId = await deps.getTransactionUserId(transactionId);
    if (!userId) throw new Error("Transaction not found");
    return storeImage(image, userId, mediaDeps, chatHash);
  },
  onJobChanged: broadcastJob,
  // The job finished in the browser: bring Keepr's main window forward
  // (BACKLOG-3636: shared with mailbox connect, incl. the Windows workaround).
  onJobFinished: () => bringAppToFront(getMainWindow()),
  // BACKLOG-3641: "Open Keepr" on the page (POST /focus).
  onFocusRequested: () => focusKeeprFromBrowser(),
  logger: {
    info: (m) => void logService.info(m, LOG_TAG),
    warn: (m) => void logService.warn(m, LOG_TAG),
    error: (m) => void logService.error(m, LOG_TAG),
  },
});

/** Start the loopback bridge. Never throws; a taken port leaves it "unavailable". */
export async function startRcsExtensionBridge(): Promise<void> {
  await bridge.start();
}

export async function stopRcsExtensionBridge(): Promise<void> {
  // Quit: a running cache Sync is not committed — its staging goes.
  const active = bridge.activeJob();
  if (active) bridge.cancelJob(active.jobId);
  if (staging) await staging.discardAll().catch(() => undefined);
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
    const result = clearGoogleMessagesWebData(
      userId,
      databaseService.rcsClearDbOps(),
      {
        attachmentsRoot: mediaDeps.attachmentsDir(),
        resolve: (p) => (path.isAbsolute(p) ? p : path.join(app.getPath("userData"), p)),
        deleteFile: (abs) => {
          try {
            fs.unlinkSync(abs);
            return true;
          } catch {
            return false;
          }
        },
      },
      (m) => void logService.info(m, LOG_TAG),
    );
    // BACKLOG-3658: the next cache Sync starts over (60 days) and re-learns the own number.
    databaseService.resetRcsCacheState(userId);
    hostWindows.broadcast(RCS_DATA_CLEARED_CHANNEL, { messagesDeleted: result.messagesDeleted });
    return result;
  });
}

/**
 * BACKLOG-3641: bring Keepr forward because the user asked from the browser
 * ("Open Keepr"). Windows may still refuse the foreground change, so the
 * taskbar button flashes as the fallback, until Keepr gets focus.
 */
export function focusKeeprFromBrowser(): void {
  bringAppToFrontOrFlash(getMainWindow());
}

export function registerRcsImportHandlers(): void {
  ipcMain.handle(
    "rcs-import:get-status",
    wrapHandler(async (): Promise<RcsImportStatusResult> => {
      return { success: true, status: bridge.getStatus() };
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:start-session",
    wrapHandler(async (_event, args: unknown): Promise<RcsImportStatusResult> => {
      const transactionId = requireString(argsObject(args).transactionId, "transactionId");
      const tx = await databaseService.getTransactionById(transactionId);
      if (!tx) return { success: false, error: "Transaction not found" };
      bridge.openSession(transactionId);
      return { success: true, status: bridge.getStatus() };
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:start-job",
    wrapHandler(async (_event, args: unknown): Promise<RcsImportJobResult> => {
      const transactionId = requireString(argsObject(args).transactionId, "transactionId");
      const tx = await databaseService.getTransactionById(transactionId);
      if (!tx) return { success: false, error: "Transaction not found" };
      // BACKLOG-3661: one Sync at a time — never replace a running one.
      const running = bridge.activeJob();
      if (running) {
        return {
          success: false,
          error: `${RCS_ALREADY_SYNCING_MESSAGE}${running.label ? `: ${running.label}` : ""}. Wait for it to finish, or cancel it.`,
        };
      }
      if (bridge.writesArePaused) {
        return { success: false, error: "Keepr is clearing imported texts. Try Sync again in a moment." };
      }
      if (cacheSaveInFlight()) return { success: false, error: RCS_SAVING_MESSAGE };
      if (bridge.getStatus().bridge !== "listening") {
        const s = bridge.getStatus();
        return { success: false, error: `Import bridge unavailable${s.reason ? `: ${s.reason}` : ""}.` };
      }
      const contacts = groupContacts(databaseService.getRcsImportContacts(transactionId));
      if (contacts.length === 0) {
        return { success: false, error: "This transaction has no contacts to look for." };
      }
      // The audit start date: the page loads chat history back past it.
      const job = bridge.createJob(transactionId, contacts, {
        startDate: tx.started_at ?? null,
        label: tx.property_address ?? null,
        userId: tx.user_id ?? null,
      });
      if (!job) {
        // A Sync started between the check above and here.
        return { success: false, error: `${RCS_ALREADY_SYNCING_MESSAGE}. Wait for it to finish, or cancel it.` };
      }
      await shell.openExternal(`${RCS_MESSAGES_WEB_URL}#keepr-job=${job.jobId}`);
      return { success: true, job };
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:cancel-job",
    wrapHandler(async (_event, args: unknown): Promise<RcsImportJobResult> => {
      const jobId = requireString(argsObject(args).jobId, "jobId");
      bridge.cancelJob(jobId);
      return { success: true, job: bridge.getJob() };
    }, { module: LOG_TAG }),
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
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:set-cache-opt-in",
    wrapHandler(async (_event, args: unknown): Promise<{ success: boolean; error?: string }> => {
      const optedIn = argsObject(args).optedIn === true;
      const userId = await currentUserId();
      if (!userId) return { success: false, error: "Sign in to Keepr first." };
      databaseService.updateRcsCacheState(userId, { optedIn });
      return { success: true };
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:get-extension-state",
    wrapHandler(async (): Promise<RcsExtensionStateResult> => {
      const userId = await currentUserId();
      const state = userId ? databaseService.getRcsCacheState(userId) : null;
      return {
        success: true,
        state: {
          extensionVersion: extensionPresence.version ?? state?.extensionVersion ?? null,
          extensionSeenAt: extensionPresence.seenAt ?? state?.extensionSeenAt ?? null,
          pairedAt: extensionPresence.pairedAt ?? state?.pairedAt ?? null,
          optedIn: !!state?.optedInAt,
          lastCacheFinishedAt: state?.lastCacheFinishedAt ?? null,
        },
      };
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:get-job",
    wrapHandler(async (): Promise<RcsImportJobResult> => {
      return { success: true, job: bridge.getJob() };
    }, { module: LOG_TAG }),
  );

  ipcMain.handle(
    "rcs-import:end-session",
    wrapHandler(async (_event, args: unknown): Promise<RcsImportStatusResult> => {
      const sessionId = requireString(argsObject(args).sessionId, "sessionId");
      bridge.closeSession(sessionId);
      return { success: true, status: bridge.getStatus() };
    }, { module: LOG_TAG }),
  );
}

/** One entry per contact with every E.164 number; a contact with none gets []. */
export function groupContacts(
  rows: { contactId: string; displayName: string; phoneE164: string | null }[],
): RcsJobContact[] {
  const byId = new Map<string, RcsJobContact>();
  for (const row of rows) {
    let c = byId.get(row.contactId);
    if (!c) {
      c = { contactId: row.contactId, displayName: row.displayName, phonesE164: [] };
      byId.set(row.contactId, c);
    }
    if (row.phoneE164 && !c.phonesE164.includes(row.phoneE164)) c.phonesE164.push(row.phoneE164);
  }
  return [...byId.values()];
}
