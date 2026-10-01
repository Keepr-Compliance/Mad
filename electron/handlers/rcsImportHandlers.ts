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
import { storeImage, type RcsMediaDeps } from "../services/rcsImportMedia";
import { importCacheChat, importChat, type RcsImportDeps } from "../services/rcsImportStore";
import {
  cacheSince,
  cacheStatusFrom,
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

/** Start the cache job for the signed-in user, or say why not (status + body). */
async function startCacheJob(): Promise<
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
  const job = bridge.createCacheJob(decision.userId, {
    since: cacheSince(Date.now(), state?.lastCacheFinishedAt),
    ownNumbers: state?.ownNumber ? [state.ownNumber] : [],
  });
  if (!job) return { ok: false, status: 409, error: "already_syncing", message: "Keepr is already syncing." };
  return { ok: true, job };
}

/** The page's "Sync to Keepr" state: the same rule as starting one. No user data. */
async function cacheStatus(): Promise<{ ready: true } | { ready: false; reason: "signed_out" | "not_opted_in" | "busy" }> {
  const userId = await currentUserId();
  const state = userId ? databaseService.getRcsCacheState(userId) : null;
  const active = bridge.activeJob();
  return cacheStatusFrom(decideCacheStart({
    userId,
    optedIn: !!state?.optedInAt,
    activeLabel: active ? active.label ?? "" : null,
    writesPaused: bridge.writesArePaused,
  }));
}

const bridge = new RcsExtensionBridge({
  importChat: (chat, transactionId, people) => importChat(chat, transactionId, deps, people),
  importCacheChat: (chat, userId, people) => importCacheChat(chat, userId, deps, people),
  importCacheImage: async (image, userId, chatHash, numbers) => {
    // Images only for chats with a live transaction contact (BACKLOG-3658).
    if (!databaseService.rcsNumbersMatchLiveContact(userId, numbers)) return { stored: false, reason: "not_a_contact" };
    return storeImage(image, userId, mediaDeps, chatHash);
  },
  currentUserId,
  cacheStatus,
  onHello: (hello) => void onHello(hello),
  startCacheJobFromPage: async () => {
    const started = await startCacheJob();
    if (!started.ok) return { status: started.status, body: { error: started.error, message: started.message } };
    return { status: 200, body: { jobId: started.job.jobId } };
  },
  onJobEnded: (ended) =>
    void handleCacheJobEnded(ended, {
      saveFinishedAt: (userId, iso) => databaseService.updateRcsCacheState(userId, { lastCacheFinishedAt: iso }),
      saveOwnNumber: (userId, number) => databaseService.updateRcsCacheState(userId, { ownNumber: number }),
      autoLink: (userId) => autoLinkNewMessagesForUser(userId),
      now: () => Date.now(),
      log: (m) => void logService.warn(m, LOG_TAG),
    }),
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
    wrapHandler(async (): Promise<RcsImportJobResult> => {
      if (bridge.getStatus().bridge !== "listening") {
        const st = bridge.getStatus();
        return { success: false, error: `Import bridge unavailable${st.reason ? `: ${st.reason}` : ""}.` };
      }
      const started = await startCacheJob();
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
