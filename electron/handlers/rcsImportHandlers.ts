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
import { importChat, type RcsImportDeps } from "../services/rcsImportStore";
import transactionService from "../services/transactionService";
import { bringAppToFront } from "../utils/bringAppToFront";
import { wrapHandler } from "../utils/wrapHandler";
import { getMainWindow } from "../windowRegistry";
import { ValidationError } from "../utils/validation";
import type {
  RcsChatReceivedEvent,
  RcsImportJobResult,
  RcsImportStatusResult,
} from "../types/ipc/window-api-rcs-import";

const LOG_TAG = "RcsImport";
export const RCS_CHAT_RECEIVED_CHANNEL = "rcs-import:chat-received";
export const RCS_JOB_PROGRESS_CHANNEL = "rcs-import:job-progress";
export const RCS_MESSAGES_WEB_URL = "https://messages.google.com/web/conversations";

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

const bridge = new RcsExtensionBridge({
  importChat: (chat, transactionId, opts) => importChat(chat, transactionId, deps, opts),
  onChatImported: broadcastChatImported,
  importImage: async (image, transactionId) => {
    const userId = await deps.getTransactionUserId(transactionId);
    if (!userId) throw new Error("Transaction not found");
    return storeImage(image, userId, mediaDeps);
  },
  onJobChanged: broadcastJob,
  // The job finished in the browser: bring Keepr's main window forward
  // (BACKLOG-3636: shared with mailbox connect, incl. the Windows workaround).
  onJobFinished: () => bringAppToFront(getMainWindow()),
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
      if (bridge.getStatus().bridge !== "listening") {
        const s = bridge.getStatus();
        return { success: false, error: `Import bridge unavailable${s.reason ? `: ${s.reason}` : ""}.` };
      }
      const contacts = groupContacts(databaseService.getRcsImportContacts(transactionId));
      if (contacts.length === 0) {
        return { success: false, error: "This transaction has no contacts to look for." };
      }
      // The audit start date: the page loads chat history back past it.
      const job = bridge.createJob(transactionId, contacts, { startDate: tx.started_at ?? null });
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
