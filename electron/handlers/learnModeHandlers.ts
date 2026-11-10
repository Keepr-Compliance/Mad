// ============================================
// LEARN MODE ("Help Keepr learn") — IPC HANDLERS (BACKLOG-4120 PR2)
// ============================================
//
// Learn mode is its own switch, separate from AI detection (founder,
// 2026-11-04): it runs the old detection rules over LOCAL mail to pick
// questions, stores the answers in the local encrypted database, and never
// creates a transaction, changes the dashboard, or sends mail anywhere.
//
// THE GATE. Every channel in LEARN_GATED_CHANNELS calls `isLearnModeAllowed`
// first, before any read or write:
//   the user's own toggle is ON (local switch row; missing row = OFF)
//   AND the strict autodetect_eval read is allowed (isAutodetectEvalAllowed).
// Five channels are ungated (session only):
//   `learn:get-state`      reports availability, the toggle and the count of
//                          saved answers; acts on nothing.
//   `learn:set-enabled`    turning ON checks only the strict key (the toggle is
//                          what it sets); turning OFF is never refused.
//   `learn:delete-answers` soft-removes the caller's own answers, with Learn
//                          mode off and with the org key off (founder,
//                          2026-11-04): a user can always remove his own rows.
//   `learn:list-answers`   lists the caller's own saved answers, so one can be
//                          chosen for deletion (2.46.2). Same basis as above.
//   `learn:delete-answer`  soft-removes ONE of the caller's own answers; the
//                          item can be asked again (2.46.2). Same basis.
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
// Attachments (founder, 2026-11-04): Learn mode lists them by name and
// downloads ONLY the attachment a cleanup question is about, when that
// question is shown (`learn:attachment-open`). "The one" is decided here
// (pickQuestionAttachmentId); any other id is refused before any provider
// call. The downloader is INJECTED by main.ts (`deps.openQuestionAttachment`),
// so this file keeps no static edge to the mail provider services. Previews,
// cleanup-next and sample-next never download.

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod/v4";

import logService from "../services/logService";
import sessionService from "../services/sessionService";
import {
  countLiveAnswers,
  getLearnModeEnabled,
  getQuestionAttachment,
  isLiveBulkRow,
  listAnswerKeyTransactions,
  listAnsweredBulkWithText,
  listAnswers,
  listDealAnswers,
  listDealContactEmails,
  listDealLinkedEmails,
  listDealLinkedSeedCandidates,
  previewAttachments,
  previewEmailForBulkRow,
  previewEmailsByIds,
  setLearnModeEnabled,
  softClearAnswers,
  softDeleteAnswer,
  type PreviewAttachmentRow,
  type PreviewEmailRow,
  type QuestionAttachmentRow,
} from "../services/db/learnModeDbService";
import { pickQuestionAttachmentId } from "../services/learn/questionAttachment";
import {
  clearLastRun,
  getLastRun,
  runBaseline0,
  setLastRun,
  toPublicRunSummary,
} from "../services/learn/baselineRunner";
import { answerCleanupQuestion, nextCleanupQuestion } from "../services/learn/cleanupPass";
import { answerBulkQuestion, ensureBulkSample, nextBulkQuestion } from "../services/learn/bulkSample";
import {
  countSeedLinkedToDeals,
  formatCopyBlock,
  isHiddenBySenderRules,
  scoreRun,
  visibleEmailIds,
} from "../services/learn/scoring";
import { getActiveSenderRules } from "../services/senderRuleSetStore";
import { buildKeepSets } from "../utils/senderFilter/senderFilter";
import { LEARN_RULES } from "../services/learn/learnRules";
import {
  LearnAttachmentOpenArgsSchema,
  LearnCleanupAnswerArgsSchema,
  LearnCleanupNextArgsSchema,
  LearnDeleteAnswerArgsSchema,
  LearnPreviewArgsSchema,
  LearnRunArgsSchema,
  LearnSampleAnswerArgsSchema,
  LearnSampleDrawArgsSchema,
  LearnSetEnabledArgsSchema,
} from "../schemas/learnMode";
import type {
  LearnAnswerResult,
  LearnAttachmentOpenResult,
  LearnCleanupNextResult,
  LearnDeleteAnswerResult,
  LearnDeleteAnswersResult,
  LearnListAnswersResult,
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
  "learn:preview",
  "learn:attachment-open",
] as const;

/** Channels that do NOT call isLearnModeAllowed, and why (header). */
export const LEARN_UNGATED_CHANNELS = [
  "learn:get-state",
  "learn:set-enabled",
  "learn:delete-answers",
  "learn:list-answers",
  "learn:delete-answer",
] as const;

export const LEARN_NOT_AVAILABLE_ERROR = "Learn mode is not available.";
export const LEARN_NOT_ON_ERROR = "Learn mode is off.";
export const LEARN_NO_SESSION_ERROR = "Not signed in.";
export const LEARN_INVALID_ERROR = "Invalid request.";
export const LEARN_NO_RUN_ERROR = "Run the check first.";
export const LEARN_NOT_IN_SET_ERROR = "That item is not part of the current questions.";
export const LEARN_FAILED_ERROR = "Learn mode request failed.";
export const LEARN_ATTACHMENT_UNAVAILABLE_ERROR = "The document could not be opened.";
export const LEARN_ATTACHMENT_TOO_LARGE_ERROR = "The document is too large to preview.";

/**
 * What main.ts injects. The downloader lives outside this file so the Learn
 * handlers never import a mail provider service (header).
 */
export interface LearnModeHandlerDeps {
  openQuestionAttachment?: (
    userId: string,
    row: QuestionAttachmentRow,
  ) => Promise<
    | { ok: true; dataUrl: string; downloadedNow: boolean }
    | { ok: false; reason: "too_large" | "not_available" | "failed" }
  >;
}

/** Messages per preview: newest first. */
export const LEARN_PREVIEW_MAX_EMAILS = 5;

const MODULE = "LearnMode";

type LearnAnswerRowAnswer = Extract<LearnListAnswersResult, { success: true }>["answers"][number]["answer"];

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

/**
 * The run in flight for each user. A second learn:run while one runs (Settings
 * left and reopened mid-scan) joins it: same result, progress to both callers.
 */
interface InflightRun {
  done: Promise<LearnRunResultResponse>;
  senders: Set<IpcMainInvokeEvent["sender"]>;
}
const runningUsers = new Map<string, InflightRun>();

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

/**
 * The cleanup preview of one detection of the user's current run: its
 * messages (newest first, capped) and their attachments. Refused when the
 * detection is not part of the run.
 *
 * BACKLOG-4175: exact-seed messages are left out BEFORE the cap (so a mixed
 * detection whose newest mail is all seed still shows its other mail), `total`
 * is the visible count, and an all-seed detection is refused like an unknown
 * id. learn:preview and learn:attachment-open both come through here.
 */
function cleanupPreview(
  userId: string,
  detectionId: string,
): { rows: PreviewEmailRow[]; attachments: PreviewAttachmentRow[]; total: number; address: string } | LearnFailure {
  const run = getLastRun(userId);
  if (!run) return fail(LEARN_NO_RUN_ERROR);
  const detection = run.detections.find((d) => d.id === detectionId);
  if (!detection || isHiddenBySenderRules(run, detection)) return fail(LEARN_NOT_IN_SET_ERROR);
  const ids = visibleEmailIds(run, detection);
  const rows = previewEmailsByIds(userId, ids, LEARN_PREVIEW_MAX_EMAILS);
  const attachments = previewAttachments(userId, rows.map((r) => r.id));
  return { rows, attachments, total: ids.length, address: detection.address };
}

function isPreviewFailure(
  x: { rows: PreviewEmailRow[] } | LearnFailure,
): x is LearnFailure {
  return (x as LearnFailure).success === false;
}

export function registerLearnModeHandlers(deps: LearnModeHandlerDeps = {}): void {
  ipcMain.handle(
    "learn:get-state",
    guarded("learn:get-state", async (): Promise<LearnStateResult> => {
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      const available = (await isAutodetectEvalAllowed()) === true;
      return {
        success: true,
        available,
        enabled: available && getLearnModeEnabled(userId),
        answers: countLiveAnswers(userId),
      };
    }),
  );

  ipcMain.handle(
    "learn:set-enabled",
    guarded("learn:set-enabled", async (_e, payload: unknown): Promise<LearnSetEnabledResult> => {
      const args = parse(LearnSetEnabledArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      // Turning OFF is never refused (session only); only turning ON needs the key.
      if (args.enabled && !((await isAutodetectEvalAllowed()) === true)) return fail(LEARN_NOT_AVAILABLE_ERROR);
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
      const userId = g.userId;
      const inflight = runningUsers.get(userId);
      if (inflight) {
        inflight.senders.add(event.sender);
        return inflight.done;
      }
      const senders = new Set<IpcMainInvokeEvent["sender"]>([event.sender]);
      const done = (async (): Promise<LearnRunResultResponse> => {
        try {
          // BACKLOG-4175 PR4: the active set, read once; the score uses this same set.
          const { rules: senderRules, ...senderRulesProvenance } = getActiveSenderRules();
          const result = await runBaseline0(userId, args.windowMonths, {
            senderRules,
            senderRulesProvenance,
            onProgress: (p) => {
              const progress: LearnRunProgressEvent = {
                runId: p.runId,
                pagesDone: p.pagesDone,
                rowsScanned: p.rowsScanned,
              };
              for (const sender of senders) {
                if (!sender.isDestroyed()) sender.send(LEARN_RUN_PROGRESS_CHANNEL, progress);
              }
            },
          });
          setLastRun(userId, result);
          const summary = toPublicRunSummary(result);
          logService.info("Learn mode run finished", MODULE, {
            rowsScanned: summary.rowsScanned,
            detections: summary.detectionCount,
          });
          return { success: true, summary };
        } finally {
          runningUsers.delete(userId);
        }
      })();
      runningUsers.set(userId, { done, senders });
      return done;
    }),
  );

  ipcMain.handle(
    "learn:cleanup-next",
    guarded("learn:cleanup-next", async (_e, payload?: unknown): Promise<LearnCleanupNextResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const parsed = LearnCleanupNextArgsSchema.safeParse(payload);
      if (!parsed.success) return fail(LEARN_INVALID_ERROR);
      const run = getLastRun(g.userId);
      if (!run) return fail(LEARN_NO_RUN_ERROR);
      const next = nextCleanupQuestion(g.userId, run, parsed.data?.exclude ?? []);
      if (!next) return { success: true, question: null };
      const detection = run.detections.find((d) => d.id === next.detectionId);
      return {
        success: true,
        question: {
          detectionId: next.detectionId,
          address: next.address,
          emailCount: detection ? visibleEmailIds(run, detection).length : 0,
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
        countSeedLinkedToDeals(
          listDealLinkedSeedCandidates(g.userId, run.senderRules.suppress.exactAddresses),
          run.senderRules,
        ),
        {
          rules: run.senderRules,
          keep: buildKeepSets(listDealContactEmails(g.userId), run.senderRules),
          linked: listDealLinkedEmails(g.userId),
        },
      );
      return { success: true, score, copyBlock: formatCopyBlock(score) };
    }),
  );

  ipcMain.handle(
    "learn:delete-answers",
    guarded("learn:delete-answers", async (): Promise<LearnDeleteAnswersResult> => {
      // UNGATED (founder, 2026-11-04): session only. Own rows only, soft.
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      const removed = softClearAnswers(userId);
      logService.info("Learn mode answers cleared", MODULE, removed);
      return { success: true, removed };
    }),
  );

  ipcMain.handle(
    "learn:list-answers",
    guarded("learn:list-answers", async (): Promise<LearnListAnswersResult> => {
      // UNGATED (2.46.2): session only. Own rows only. The reply carries
      // addresses and subjects for the screen; the log carries the count only.
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      const rows = listAnswers(userId);
      logService.info("Learn mode answers listed", MODULE, { count: rows.length });
      return {
        success: true,
        answers: rows.map((r) => ({
          kind: r.kind,
          id: r.id,
          label: r.label,
          itemDate: r.item_date,
          answeredAt: r.answered_at,
          answer: r.answer as LearnAnswerRowAnswer,
        })),
      };
    }),
  );

  ipcMain.handle(
    "learn:delete-answer",
    guarded("learn:delete-answer", async (_e, payload: unknown): Promise<LearnDeleteAnswerResult> => {
      // UNGATED (2.46.2): session only. Own rows only, soft.
      const userId = await sessionUserId();
      if (!userId) return fail(LEARN_NO_SESSION_ERROR);
      const args = parse(LearnDeleteAnswerArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      if (!softDeleteAnswer(userId, args.kind, args.id, LEARN_RULES.version)) return fail(LEARN_NOT_IN_SET_ERROR);
      logService.info("Learn mode answer deleted", MODULE, { kind: args.kind });
      return { success: true };
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
        const p = cleanupPreview(g.userId, args.detectionId);
        if (isPreviewFailure(p)) return p;
        const emails = toPreviewEmails(p.rows, p.attachments);
        return {
          success: true,
          emails,
          totalEmails: p.total,
          questionAttachmentId: pickQuestionAttachmentId(emails, p.address),
        };
      }

      if (!isLiveBulkRow(g.userId, args.rowId)) return fail(LEARN_NOT_IN_SET_ERROR);
      const row = previewEmailForBulkRow(g.userId, args.rowId);
      if (!row) return { success: true, emails: [], totalEmails: 0, questionAttachmentId: null };
      const attachments = previewAttachments(g.userId, [row.id]);
      return { success: true, emails: toPreviewEmails([row], attachments), totalEmails: 1, questionAttachmentId: null };
    }),
  );

  ipcMain.handle(
    "learn:attachment-open",
    guarded("learn:attachment-open", async (_e, payload: unknown): Promise<LearnAttachmentOpenResult> => {
      const g = await gate();
      if (isFailure(g)) return g;
      const args = parse(LearnAttachmentOpenArgsSchema, payload);
      if (!args) return fail(LEARN_INVALID_ERROR);
      // Recompute "the one" from the same preview set; any other id is refused
      // before anything is read or fetched.
      const p = cleanupPreview(g.userId, args.detectionId);
      if (isPreviewFailure(p)) return p;
      const theOne = pickQuestionAttachmentId(toPreviewEmails(p.rows, p.attachments), p.address);
      if (theOne === null || theOne !== args.attachmentId) return fail(LEARN_NOT_IN_SET_ERROR);
      const row = getQuestionAttachment(g.userId, theOne);
      if (!row) return fail(LEARN_NOT_IN_SET_ERROR);
      if (!deps.openQuestionAttachment) return fail(LEARN_ATTACHMENT_UNAVAILABLE_ERROR);
      const opened = await deps.openQuestionAttachment(g.userId, row);
      if (!opened.ok) {
        logService.info("Learn mode attachment not opened", MODULE, { reason: opened.reason });
        return fail(opened.reason === "too_large" ? LEARN_ATTACHMENT_TOO_LARGE_ERROR : LEARN_ATTACHMENT_UNAVAILABLE_ERROR);
      }
      logService.info("Learn mode attachment opened", MODULE, { downloadedNow: opened.downloadedNow });
      return { success: true, dataUrl: opened.dataUrl, downloadedNow: opened.downloadedNow };
    }),
  );
}
