/**
 * Zod schemas for the Learn mode IPC arguments — BACKLOG-4120 PR2.
 *
 * The renderer is not the authority on anything here: every payload arrives
 * over a channel anything in the window can call, so a payload that does not
 * parse is REFUSED. Ids are bounded strings (a detection id is "d<n>", a sample
 * row id is a UUID written by main); answers are the versioned rule lists.
 *
 * Result types live in `electron/types/ipc/window-api-learn.ts`; the renderer
 * imports those type-only and never this file.
 */
import { z } from "zod/v4";

import { LEARN_RULES } from "../services/learn/learnRules";

const DetectionIdSchema = z.string().regex(/^d[1-9][0-9]{0,6}$/, "Invalid detection id");
const RowIdSchema = z.string().min(1).max(64);
const WindowMonthsSchema = z
  .number()
  .int()
  .min(LEARN_RULES.windowMonthsMin)
  .max(LEARN_RULES.windowMonthsMax);

export const LearnSetEnabledArgsSchema = z.strictObject({ enabled: z.boolean() });

export const LearnRunArgsSchema = z.strictObject({ windowMonths: WindowMonthsSchema });

export const LearnCleanupAnswerArgsSchema = z.strictObject({
  detectionId: DetectionIdSchema,
  answer: z.enum(LEARN_RULES.dealAnswers),
});

export const LearnSampleDrawArgsSchema = z.strictObject({ windowMonths: WindowMonthsSchema });

export const LearnSampleAnswerArgsSchema = z.strictObject({
  rowId: RowIdSchema,
  answer: z.enum(LEARN_RULES.bulkAnswers),
});

export const LearnPreviewArgsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cleanup"), detectionId: DetectionIdSchema }),
  z.strictObject({ kind: z.literal("bulk"), rowId: RowIdSchema }),
]);

/**
 * learn:cleanup-next (PR3): optional detections skipped for now in this
 * session. Skipping stores nothing; the deal is asked again next time.
 */
export const LearnCleanupNextArgsSchema = z
  .strictObject({ exclude: z.array(DetectionIdSchema).max(5000) })
  .optional();

const AttachmentIdSchema = z.string().min(1).max(128);

/** learn:attachment-open (PR3): the cleanup question and its one attachment. */
export const LearnAttachmentOpenArgsSchema = z.strictObject({
  detectionId: DetectionIdSchema,
  attachmentId: AttachmentIdSchema,
});
