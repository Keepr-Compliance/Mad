/**
 * WindowApi Learn sub-interface — BACKLOG-4120 PR2.
 *
 * The renderer's view of `window.api.learn` ("Help Keepr learn"). Every
 * decision is made in main: whether Learn mode is available (the strict
 * autodetect_eval read) and on (the user's own toggle), which detection or
 * sample row may be previewed, and what is stored. Learn mode never creates a
 * transaction, never reads or changes AI detection, and never sends mail to a
 * cloud service.
 *
 * `success: false` means the request did not run (refused or failed). Type-only
 * imports from main: nothing here carries code into the renderer.
 */
import type { PublicRunSummary } from "../../services/learn/baselineRunner";
import type { SampleDrawResult } from "../../services/learn/bulkSample";
import type { LearnScore } from "../../services/learn/scoring";
import type { BulkAnswer, DealAnswer } from "../../services/learn/learnRules";

export type { PublicRunSummary, SampleDrawResult, LearnScore, BulkAnswer, DealAnswer };

export type LearnFailure = { success: false; error: string };

export type LearnStateResult =
  | {
      success: true;
      available: boolean;
      enabled: boolean;
      /** Saved answers of this user (counts only), whatever the toggle and the key say. */
      answers: { deal: number; bulk: number };
      /** BACKLOG-4219: "Help improve Keepr" is ON. */
      pilotReport: boolean;
      /** BACKLOG-4219: a withdraw is owed to Keepr (offline when it was turned off). */
      pilotPending: boolean;
      /** BACKLOG-4219: ISO time of the last successful send, or null. */
      pilotLastSentAt: string | null;
    }
  | LearnFailure;

export type LearnSetEnabledResult = { success: true; enabled: boolean } | LearnFailure;

export type LearnSetPilotReportResult =
  | { success: true; pilotReport: boolean; pilotPending: boolean }
  | LearnFailure;

export type LearnRunResultResponse = { success: true; summary: PublicRunSummary } | LearnFailure;

/** One `learn:run-progress` event: ids and counts only. */
export interface LearnRunProgressEvent {
  runId: string;
  pagesDone: number;
  rowsScanned: number;
}

/** A cleanup question. The address is shown on the card; it is never logged. */
export interface LearnCleanupQuestion {
  detectionId: string;
  address: string;
  emailCount: number;
}

export type LearnCleanupNextResult =
  | { success: true; question: LearnCleanupQuestion | null }
  | LearnFailure;

export type LearnAnswerResult = { success: true } | LearnFailure;

export type LearnSampleDrawResponse = { success: true; result: SampleDrawResult } | LearnFailure;

export type LearnSampleNextResult =
  | { success: true; question: { rowId: string } | null }
  | LearnFailure;

export type LearnScoreResult =
  | { success: true; score: LearnScore; copyBlock: string }
  | LearnFailure;

export type LearnDeleteAnswersResult =
  | { success: true; removed: { deal: number; bulk: number } }
  | LearnFailure;

/**
 * One saved answer in "Your answers" (2.46.2). `label`: the address (deal) or
 * the subject (mail; null when the message is no longer on this computer).
 * `itemDate`: the email's date (mail only). Shown to the user only; never
 * logged.
 */
export interface LearnAnswerRow {
  kind: "deal" | "bulk";
  id: string;
  label: string | null;
  itemDate: string | null;
  answeredAt: string | null;
  answer: DealAnswer | BulkAnswer;
}

export type LearnListAnswersResult = { success: true; answers: LearnAnswerRow[] } | LearnFailure;

export type LearnDeleteAnswerResult = { success: true } | LearnFailure;

export interface LearnPreviewAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Already on disk. Learn mode downloads only the question's own attachment (learn:attachment-open). */
  downloaded: boolean;
  /** Set only when downloaded; opened through the existing attachment channels. */
  storagePath: string | null;
}

/**
 * One message in a preview. `bodyHtml` is the stored HTML, unsanitized: the
 * renderer sanitizes it and blocks remote images by default (founder,
 * 2026-11-04).
 */
export interface LearnPreviewEmail {
  id: string;
  subject: string | null;
  sender: string | null;
  recipients: string | null;
  sentAt: string | null;
  bodyHtml: string | null;
  bodyPlain: string | null;
  attachments: LearnPreviewAttachment[];
}

export type LearnPreviewResult =
  | {
      success: true;
      emails: LearnPreviewEmail[];
      totalEmails: number;
      /**
       * Cleanup previews only: the one attachment the question is about (the
       * first PDF, newest message first), or null. Bulk previews: always null.
       */
      questionAttachmentId: string | null;
    }
  | LearnFailure;

export type LearnAttachmentOpenResult =
  | { success: true; dataUrl: string; downloadedNow: boolean }
  | LearnFailure;

export type LearnPreviewArgs =
  | { kind: "cleanup"; detectionId: string }
  | { kind: "bulk"; rowId: string };

export interface WindowApiLearn {
  /** BACKLOG-4219: `settle: true` first waits (capped) for this user's queued pilot send / withdraw. */
  getState: (args?: { settle?: boolean }) => Promise<LearnStateResult>;
  setEnabled: (args: { enabled: boolean }) => Promise<LearnSetEnabledResult>;
  /** BACKLOG-4219: turn "Help improve Keepr" on or off. */
  setPilotReport: (args: { enabled: boolean }) => Promise<LearnSetPilotReportResult>;
  run: (args: { windowMonths: number }) => Promise<LearnRunResultResponse>;
  onRunProgress: (callback: (progress: LearnRunProgressEvent) => void) => () => void;
  cleanupNext: (args?: { exclude: string[] }) => Promise<LearnCleanupNextResult>;
  cleanupAnswer: (args: { detectionId: string; answer: DealAnswer }) => Promise<LearnAnswerResult>;
  sampleDraw: (args: { windowMonths: number }) => Promise<LearnSampleDrawResponse>;
  sampleNext: () => Promise<LearnSampleNextResult>;
  sampleAnswer: (args: { rowId: string; answer: BulkAnswer }) => Promise<LearnAnswerResult>;
  score: () => Promise<LearnScoreResult>;
  deleteAnswers: () => Promise<LearnDeleteAnswersResult>;
  listAnswers: () => Promise<LearnListAnswersResult>;
  deleteAnswer: (args: { kind: "deal" | "bulk"; id: string }) => Promise<LearnDeleteAnswerResult>;
  preview: (args: LearnPreviewArgs) => Promise<LearnPreviewResult>;
  attachmentOpen: (args: { detectionId: string; attachmentId: string }) => Promise<LearnAttachmentOpenResult>;
}
