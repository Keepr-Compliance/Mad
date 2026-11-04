// ============================================
// LEARN MODE ("Help Keepr learn") — IPC HANDLERS (BACKLOG-4120 PR2)
// ============================================
//
// Learn mode is its own switch, separate from AI detection (founder,
// 2026-11-04): it runs the old detection rules over LOCAL mail to pick
// questions, stores the answers in the local encrypted database, and never
// creates a transaction, changes the dashboard, or sends mail anywhere.
//
// THE GATE. Every channel except `learn:get-state` and `learn:set-enabled`
// calls `isLearnModeAllowed` first, before any read or write:
//   the user's own toggle is ON (learn_mode_settings, missing row = OFF)
//   AND the strict autodetect_eval read is allowed (isAutodetectEvalAllowed).
// `learn:set-enabled` checks only the strict key (the toggle is what it sets);
// `learn:get-state` reports both and acts on nothing.
//
// What this file deliberately does NOT import: emailSyncHandlers
// (isAutoDetectAllowed), llmConfigService, transactionService,
// hybridExtractorService, the Gmail/Outlook fetch services, any LLM provider,
// featureGateService.checkFeature (fail-OPEN). learnModeBoundaries-4120 walks
// the import graph from here and fails on any of them. AI detection ON or OFF
// changes nothing here, and nothing here turns it on.
//
// PRIVACY. Replies carry ids and counts, except the two that must show the
// user what is asked about: `learn:cleanup-next` (the address on the card) and
// `learn:preview` (the message). Neither is ever logged, sent as an event, or
// attached to an error report. Logs name the channel and counts only; errors
// are logged by name, never by message, and are not sent to Sentry.
//
// Attachments: Learn mode lists them by name and reports whether the file is
// already on disk; it never downloads one (no M0a question is about an
// attachment — founder rule 2026-11-04: only the attachment a question is
// about may be downloaded).

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod/v4";

import logService from "../services/logService";
import sessionService from "../services/sessionService";
import {
  getLearnModeEnabled,
  isLiveBulkRow,
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listDealAnswers,
  previewAttachments,
  previewEmailForBulkRow,
  previewEmailsByIds,
  setLearnModeEnabled,
  softClearAnswers,
  type PreviewAttachmentRow,
  type PreviewEmailRow,
} from "../services/db/learnModeDbService";
import {
  clearLastRun,
  getLastRun,
  runBaseline0,
  setLastRun,
  toPublicRunSummary,
} from "../services/learn/baselineRunner";
import { answerCleanupQuestion, nextCleanupQuestion } from "../services/learn/cleanupPass";
import { answerBulkQuestion, ensureBulkSample, nextBulkQuestion } from "../services/learn/bulkSample";
import { formatCopyBlock, scoreRun } from "../services/learn/scoring";
import {
  LearnCleanupAnswerArgsSchema,
  LearnPreviewArgsSchema,
  LearnRunArgsSchema,
  LearnSampleAnswerArgsSchema,
  LearnSampleDrawArgsSchema,
  LearnSetEnabledArgsSchema,
} from "../schemas/learnMode";
import type {
  LearnAnswerResult,
  LearnCleanupNextResult,
  LearnDeleteAnswersResult,
  LearnFailure,
  LearnPreviewEmail,
  LearnPreviewResult,
  LearnRunProgressEvent,
  LearnRunResultResponse,
  LearnSampleDrawResponse,
  LearnSampleNextResult,
  LearnScoreResult,
  LearnSetEnabledResult,
  LearnStateResult,
} from "../types/ipc/window-api-learn";
import { isAutodetectEvalAllowed } from "./featureGateHandlers";

export const LEARN_RUN_PROGRESS_CHANNEL = "learn:run-progress";

/** Channels that call isLearnModeAllowed before anything else. */
export const LEARN_GATED_CHANNELS = [
  "learn:run",
  "learn:cleanup-next",
  "learn:cleanup-answer",
  "learn:sample-draw",
  "learn:sample-next",
  "learn:sample-answer",
  "learn:score",
  "learn:delete-answers",
  "learn:preview",
] as const;

/** Channels that do NOT call isLearnModeAllowed, and why (header). */
export const LEARN_UNGATED_CHANNELS = ["learn:get-state", "learn:set-enabled"] as const;

export const LEARN_NOT_AVAILABLE_ERROR = "Learn mode is not available.";
export const LEARN_NOT_ON_ERROR = "Learn mode is off.";
export const LEARN_NO_SESSION_ERROR = "Not signed in.";
export const LEARN_INVALID_ERROR = "Invalid request.";
export const LEARN_NO_RUN_ERROR = "Run the check first.";
export const LEARN_RUN_BUSY_ERROR = "A check is already running.";
export const LEARN_NOT_IN_SET_ERROR = "That item is not part of the current questions.";
export const LEARN_FAILED_ERROR = "Learn mode request failed.";

/** Messages per preview: newest first. */
export const LEARN_PREVIEW_MAX_EMAILS = 5;

const MODULE = "LearnMode";

async function sessionUserId(): Promise<string | null> {
  try {
    const session = await sessionService.loadSession();
    const id = session?.user?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * The Learn mode gate: the user's toggle ON AND the strict autodetect_eval
 * read allowed. Never `isAutoDetectAllowed`, never the fail-open checkFeature.
 * Any throw = not allowed.
 */
export async function isLearnModeAllowed(userId: string): Promise<boolean> {
  try {
    if (!getLearnModeEnabled(userId)) return false;
    return (await isAutodetectEvalAllowed()) === true;
  } catch {
    return false;
  }
}

function fail(error: string): LearnFailure {
  return { success: false, error };
}

function parse<T>(schema: z.ZodType<T>, payload: unknown): T | null {
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Catch-all for one channel. Logs the channel and the error's NAME only (an
 * error message could quote a subject or an address); nothing goes to Sentry.
 */
function guarded<A extends unknown[], R>(
  channel: string,
  body: (event: IpcMainInvokeEvent, ...args: A) => Promise<R>,
): (event: IpcMainInvokeEvent, ...args: A) => Promise<R | LearnFailure> {
  return async (event, ...args) => {
    try {
      return await body(event, ...args);
    } catch (error) {
      logService.warn("Learn mode request failed", MODULE, {
        channel,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return fail(LEARN_FAILED_ERROR);
    }
  };
}

/** Session + gate for a gated channel. Returns the user id or a refusal. */
async function gate(): Promise<{ userId: string } | LearnFailure> {
  const userId = await sessionUserId();
  if (!userId) return fail(LEARN_NO_SESSION_ERROR);
  if (!(await isLearnModeAllowed(userId))) return fail(LEARN_NOT_ON_ERROR);
  return { userId };
}

function isFailure(x: { userId: string } | LearnFailure): x is LearnFailure {
  return (x as LearnFailure).success === false;
}

const runningUsers = new Set<string>();

function toPreviewEmails(rows: PreviewEmailRow[], attachments: PreviewAttachmentRow[]): LearnPreviewEmail[] {
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    sender: r.sender,
    recipients: r.recipients,
    sentAt: r.sent_at,
    bodyHtml: r.body_html,
    bodyPlain: r.body_plain,
    attachments: attachments
      .filter((a) => a.email_id === r.id)
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        sizeBytes: a.file_size_bytes,
        downloaded: a.storage_path !== null && a.storage_path !== "",
        storagePath: a.storage_path || null,
      })),
  }));
}

export function registerLearnModeHandlers(): void {
  ipcMain.handle(
    "learn:get-state",
    guarded("learn:get-state", async (): Promise<LearnStateResult> => {
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      const available = (await isAutodetectEvalAllowed()) === true;
      return { success: true, available, enabled: available && getLearnModeEnabled(userId) };
    }),
  );

  ipcMain.handle(
    "learn:set-enabled",
    guarded("learn:set-enabled", async (_e, payload: unknown): Promise<LearnSetEnabledResult> => {
      const args = parse(LearnSetEnabledArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      if (!((await isAutodetectEvalAllowed()) === true)) return fail(LEARN_NOT_AVAILABLE_ERROR);
      setLearnModeEnabled(userId, args.enabled);
      if (!args.enabled) clearLastRun(userId);
      logService.info("Learn mode toggled", MODULE, { enabled: args.enabled });
      return { success: true, enabled: getLearnModeEnabled(userId) };
    }),
  );

  ipcMain.handle(
    "learn:run",
    guarded("learn:run", async (event, payload: unknown): Promise<LearnRunResultResponse> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const args = parse(LearnRunArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      if (runningUsers.has(g.userId)) return fail(LEARN_RUN_BUSY_ERROR);
      runningUsers.add(g.userId);
      try {
        const result = await runBaseline0(g.userId, args.windowMonths, {
          onProgress: (p) => {
            const progress: LearnRunProgressEvent = {
              runId: p.runId,
              pagesDone: p.pagesDone,
              rowsScanned: p.rowsScanned,
            };
            if (!event.sender.isDestroyed()) event.sender.send(LEARN_RUN_PROGRESS_CHANNEL, progress);
          },
        });
        setLastRun(g.userId, result);
        const summary = toPublicRunSummary(result);
        logService.info("Learn mode run finished", MODULE, {
          rowsScanned: summary.rowsScanned,
          detections: summary.detectionCount,
        });
        return { success: true, summary };
      } finally {
        runningUsers.delete(g.userId);
      }
    }),
  );

  ipcMain.handle(
    "learn:cleanup-next",
    guarded("learn:cleanup-next", async (): Promise<LearnCleanupNextResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const run = getLastRun(g.userId);
      if (!run) return fail(LEARN_NO_RUN_ERROR);
      const next = nextCleanupQuestion(g.userId, run);
      if (!next) return { success: true, question: null };
      const detection = run.detections.find((d) => d.id === next.detectionId);
      return {
        success: true,
        question: {
          detectionId: next.detectionId,
          address: next.address,
          emailCount: detection?.emailCount ?? 0,
        },
      };
    }),
  );

  ipcMain.handle(
    "learn:cleanup-answer",
    guarded("learn:cleanup-answer", async (_e, payload: unknown): Promise<LearnAnswerResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const args = parse(LearnCleanupAnswerArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      const run = getLastRun(g.userId);
      if (!run) return fail(LEARN_NO_RUN_ERROR);
      if (!answerCleanupQuestion(g.userId, run, args.detectionId, args.answer)) {
        return fail(LEARN_NOT_IN_SET_ERROR);
      }
      return { success: true };
    }),
  );

  ipcMain.handle(
    "learn:sample-draw",
    guarded("learn:sample-draw", async (_e, payload: unknown): Promise<LearnSampleDrawResponse> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const args = parse(LearnSampleDrawArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      const result = ensureBulkSample(g.userId, args.windowMonths);
      logService.info("Learn mode sample ready", MODULE, { sampleSize: result.sampleSize, drawn: result.drawn });
      return { success: true, result };
    }),
  );

  ipcMain.handle(
    "learn:sample-next",
    guarded("learn:sample-next", async (): Promise<LearnSampleNextResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      return { success: true, question: nextBulkQuestion(g.userId) };
    }),
  );

  ipcMain.handle(
    "learn:sample-answer",
    guarded("learn:sample-answer", async (_e, payload: unknown): Promise<LearnAnswerResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const args = parse(LearnSampleAnswerArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      if (!answerBulkQuestion(g.userId, args.rowId, args.answer)) return fail(LEARN_NOT_IN_SET_ERROR);
      return { success: true };
    }),
  );

  ipcMain.handle(
    "learn:score",
    guarded("learn:score", async (): Promise<LearnScoreResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const run = getLastRun(g.userId);
      if (!run) return fail(LEARN_NO_RUN_ERROR);
      const score = scoreRun(
        run,
        listAnswerKeyTransactions(g.userId),
        listDealAnswers(g.userId),
        listAnsweredBulkWithText(g.userId),
      );
      return { success: true, score, copyBlock: formatCopyBlock(score) };
    }),
  );

  ipcMain.handle(
    "learn:delete-answers",
    guarded("learn:delete-answers", async (): Promise<LearnDeleteAnswersResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const removed = softClearAnswers(g.userId);
      logService.info("Learn mode answers cleared", MODULE, removed);
      return { success: true, removed };
    }),
  );

  ipcMain.handle(
    "learn:preview",
    guarded("learn:preview", async (_e, payload: unknown): Promise<LearnPreviewResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const args = parse(LearnPreviewArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);

      if (args.kind === "cleanup") {
        const run = getLastRun(g.userId);
        if (!run) return fail(LEARN_NO_RUN_ERROR);
        const detection = run.detections.find((d) => d.id === args.detectionId);
        if (!detection) return fail(LEARN_NOT_IN_SET_ERROR);
        const rows = previewEmailsByIds(g.userId, detection.emailIds, LEARN_PREVIEW_MAX_EMAILS);
        const attachments = previewAttachments(g.userId, rows.map((r) => r.id));
        return { success: true, emails: toPreviewEmails(rows, attachments), totalEmails: detection.emailIds.length };
      }

      if (!isLiveBulkRow(g.userId, args.rowId)) return fail(LEARN_NOT_IN_SET_ERROR);
      const row = previewEmailForBulkRow(g.userId, args.rowId);
      if (!row) return { success: true, emails: [], totalEmails: 0 };
      const attachments = previewAttachments(g.userId, [row.id]);
      return { success: true, emails: toPreviewEmails([row], attachments), totalEmails: 1 };
    }),
  );
}
