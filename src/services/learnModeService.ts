/**
 * Learn mode service — BACKLOG-4120 PR2.
 *
 * The renderer's abstraction over `window.api.learn` ("Help Keepr learn").
 * Components never touch `window.api` directly, and they decide nothing Learn
 * mode depends on: availability, the user's toggle, which item may be
 * previewed and what is stored are all decided in main.
 *
 * Privacy: a preview or a cleanup question carries an address or a message.
 * Nothing here logs a reply or an error message, and nothing goes to Sentry: a
 * thrown invoke becomes the fixed failure below.
 *
 * Consumers: the Settings "Help Keepr learn" section and its question dialog
 * (BACKLOG-4120 PR3), and the delete row in Data & Privacy.
 */
import type {
  BulkAnswer,
  LearnAttachmentOpenResult,
  DealAnswer,
  LearnAnswerResult,
  LearnCleanupNextResult,
  LearnDeleteAnswerResult,
  LearnDeleteAnswersResult,
  LearnFailure,
  LearnListAnswersResult,
  LearnPreviewArgs,
  LearnPreviewResult,
  LearnRunProgressEvent,
  LearnRunResultResponse,
  LearnSampleDrawResponse,
  LearnSampleNextResult,
  LearnScoreResult,
  LearnSetEnabledResult,
  LearnStateResult,
} from "../../electron/types/ipc/window-api-learn";

export const LEARN_UNREACHABLE_ERROR = "Learn mode could not be reached.";

async function call<R>(fn: () => Promise<R>): Promise<R | LearnFailure> {
  try {
    return await fn();
  } catch {
    return { success: false, error: LEARN_UNREACHABLE_ERROR };
  }
}

export const learnModeService = {
  getState: (): Promise<LearnStateResult> => call(() => window.api.learn.getState()),

  setEnabled: (enabled: boolean): Promise<LearnSetEnabledResult> =>
    call(() => window.api.learn.setEnabled({ enabled })),

  run: (windowMonths: number): Promise<LearnRunResultResponse> =>
    call(() => window.api.learn.run({ windowMonths })),

  /** Subscribe to run progress (ids and counts only). Returns an unsubscribe. */
  onRunProgress: (callback: (progress: LearnRunProgressEvent) => void): (() => void) =>
    window.api.learn.onRunProgress(callback),

  /** `exclude`: detections skipped for now in this session (nothing is stored). */
  cleanupNext: (exclude: string[] = []): Promise<LearnCleanupNextResult> =>
    call(() => (exclude.length > 0 ? window.api.learn.cleanupNext({ exclude }) : window.api.learn.cleanupNext())),

  cleanupAnswer: (detectionId: string, answer: DealAnswer): Promise<LearnAnswerResult> =>
    call(() => window.api.learn.cleanupAnswer({ detectionId, answer })),

  sampleDraw: (windowMonths: number): Promise<LearnSampleDrawResponse> =>
    call(() => window.api.learn.sampleDraw({ windowMonths })),

  sampleNext: (): Promise<LearnSampleNextResult> => call(() => window.api.learn.sampleNext()),

  sampleAnswer: (rowId: string, answer: BulkAnswer): Promise<LearnAnswerResult> =>
    call(() => window.api.learn.sampleAnswer({ rowId, answer })),

  score: (): Promise<LearnScoreResult> => call(() => window.api.learn.score()),

  deleteAnswers: (): Promise<LearnDeleteAnswersResult> => call(() => window.api.learn.deleteAnswers()),

  /** The user's saved answers, newest first. */
  listAnswers: (): Promise<LearnListAnswersResult> => call(() => window.api.learn.listAnswers()),

  /** Delete one saved answer (soft, in main); the item can be asked again. */
  deleteAnswer: (kind: "deal" | "bulk", id: string): Promise<LearnDeleteAnswerResult> =>
    call(() => window.api.learn.deleteAnswer({ kind, id })),

  preview: (args: LearnPreviewArgs): Promise<LearnPreviewResult> => call(() => window.api.learn.preview(args)),

  /** The one attachment a cleanup question is about; main downloads it if needed. */
  attachmentOpen: (detectionId: string, attachmentId: string): Promise<LearnAttachmentOpenResult> =>
    call(() => window.api.learn.attachmentOpen({ detectionId, attachmentId })),
};

export default learnModeService;
