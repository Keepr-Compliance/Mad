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
 * The consumer is PR3's Settings section.
 */
import type {
  BulkAnswer,
  DealAnswer,
  LearnAnswerResult,
  LearnCleanupNextResult,
  LearnDeleteAnswersResult,
  LearnFailure,
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

  cleanupNext: (): Promise<LearnCleanupNextResult> => call(() => window.api.learn.cleanupNext()),

  cleanupAnswer: (detectionId: string, answer: DealAnswer): Promise<LearnAnswerResult> =>
    call(() => window.api.learn.cleanupAnswer({ detectionId, answer })),

  sampleDraw: (windowMonths: number): Promise<LearnSampleDrawResponse> =>
    call(() => window.api.learn.sampleDraw({ windowMonths })),

  sampleNext: (): Promise<LearnSampleNextResult> => call(() => window.api.learn.sampleNext()),

  sampleAnswer: (rowId: string, answer: BulkAnswer): Promise<LearnAnswerResult> =>
    call(() => window.api.learn.sampleAnswer({ rowId, answer })),

  score: (): Promise<LearnScoreResult> => call(() => window.api.learn.score()),

  deleteAnswers: (): Promise<LearnDeleteAnswersResult> => call(() => window.api.learn.deleteAnswers()),

  preview: (args: LearnPreviewArgs): Promise<LearnPreviewResult> => call(() => window.api.learn.preview(args)),
};

export default learnModeService;
