/**
 * One sitting of Learn mode questions — BACKLOG-4120 PR3.
 *
 * Order: the deal questions (cleanup pass, board L2) first, then the mail
 * questions (bulk sample, board L3). Main hands out the next unanswered item
 * each time; this hook only remembers what this sitting did, for "Question N
 * of M", "Skip for now" and "Undo last".
 *
 *   Skip, deal question  nothing is stored; the deal is passed over for the
 *                        rest of this sitting and asked again next time.
 *   Skip, mail question  stored as "skip" (the answer the sample defines).
 *   Undo last            shows the previous item again; the next answer
 *                        replaces the stored one (main's upserts).
 *
 * Attachments: a deal question's one attachment (main names it in the
 * preview) is opened when THAT question is shown, never earlier, and never
 * for any other attachment. Mail questions never open an attachment.
 */
import { useCallback, useRef, useState } from "react";
import learnModeService from "@/services/learnModeService";
import type {
  BulkAnswer,
  DealAnswer,
  LearnCleanupQuestion,
  LearnPreviewEmail,
} from "../../../../electron/types/ipc/window-api-learn";

export type LearnQuestion =
  | { kind: "cleanup"; question: LearnCleanupQuestion }
  | { kind: "bulk"; rowId: string };

export type AttachmentState =
  | { status: "none" }
  | { status: "loading"; attachmentId: string }
  | { status: "ready"; attachmentId: string; dataUrl: string }
  | { status: "error"; attachmentId: string; message: string };

interface HistoryEntry {
  item: LearnQuestion;
  skipped: boolean;
}

export interface LearnSessionState {
  phase: "closed" | "loading" | "question" | "done" | "error";
  current: LearnQuestion | null;
  emails: LearnPreviewEmail[];
  totalEmails: number;
  attachment: AttachmentState;
  index: number;
  total: number;
  answered: number;
  canUndo: boolean;
  busy: boolean;
  error: string | null;
}

const CLOSED: LearnSessionState = {
  phase: "closed",
  current: null,
  emails: [],
  totalEmails: 0,
  attachment: { status: "none" },
  index: 0,
  total: 0,
  answered: 0,
  canUndo: false,
  busy: false,
  error: null,
};

export interface UseLearnSession extends LearnSessionState {
  start: (total: number) => Promise<void>;
  answerDeal: (answer: DealAnswer) => Promise<void>;
  answerMail: (answer: Exclude<BulkAnswer, "skip">) => Promise<void>;
  skip: () => Promise<void>;
  undo: () => Promise<void>;
  close: () => void;
}

export function useLearnSession(): UseLearnSession {
  const [state, setState] = useState<LearnSessionState>(CLOSED);
  const seq = useRef(0);
  const skippedDeals = useRef<string[]>([]);
  const history = useRef<HistoryEntry[]>([]);

  const show = useCallback(async (item: LearnQuestion, my: number) => {
    setState((s) => ({ ...s, phase: "loading", current: item, emails: [], attachment: { status: "none" }, busy: true }));
    const preview = await learnModeService.preview(
      item.kind === "cleanup" ? { kind: "cleanup", detectionId: item.question.detectionId } : { kind: "bulk", rowId: item.rowId },
    );
    if (seq.current !== my) return;
    if (!preview.success) {
      setState((s) => ({ ...s, phase: "error", busy: false, error: preview.error }));
      return;
    }
    const attachmentId = item.kind === "cleanup" ? preview.questionAttachmentId : null;
    setState((s) => ({
      ...s,
      phase: "question",
      emails: preview.emails,
      totalEmails: preview.totalEmails,
      attachment: attachmentId ? { status: "loading", attachmentId } : { status: "none" },
      canUndo: history.current.length > 0,
      busy: false,
    }));
    if (!attachmentId || item.kind !== "cleanup") return;
    // The one attachment of THIS question, now that it is shown.
    const opened = await learnModeService.attachmentOpen(item.question.detectionId, attachmentId);
    if (seq.current !== my) return;
    setState((s) => ({
      ...s,
      attachment: opened.success
        ? { status: "ready", attachmentId, dataUrl: opened.dataUrl }
        : { status: "error", attachmentId, message: opened.error },
    }));
  }, []);

  const advance = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, busy: true }));
    const c = await learnModeService.cleanupNext(skippedDeals.current);
    if (seq.current !== my) return;
    if (c.success && c.question) {
      await show({ kind: "cleanup", question: c.question }, my);
      return;
    }
    const b = await learnModeService.sampleNext();
    if (seq.current !== my) return;
    if (b.success && b.question) {
      await show({ kind: "bulk", rowId: b.question.rowId }, my);
      return;
    }
    const failed = !c.success ? c : !b.success ? b : null;
    if (failed && !failed.success) {
      setState((s) => ({ ...s, phase: "error", busy: false, error: failed.error }));
      return;
    }
    setState((s) => ({ ...s, phase: "done", current: null, emails: [], attachment: { status: "none" }, busy: false }));
  }, [show]);

  const start = useCallback(
    async (total: number) => {
      skippedDeals.current = [];
      history.current = [];
      setState({ ...CLOSED, phase: "loading", index: 1, total });
      await advance();
    },
    [advance],
  );

  const record = useCallback(
    async (store: () => Promise<{ success: boolean; error?: string }>, item: LearnQuestion, skipped: boolean) => {
      setState((s) => ({ ...s, busy: true }));
      const r = await store();
      if (!r.success) {
        setState((s) => ({ ...s, busy: false, error: r.error ?? null }));
        return;
      }
      history.current.push({ item, skipped });
      setState((s) => ({
        ...s,
        index: Math.min(s.index + 1, Math.max(s.total, 1)),
        answered: skipped ? s.answered : s.answered + 1,
        error: null,
      }));
      await advance();
    },
    [advance],
  );

  const answerDeal = useCallback(
    async (answer: DealAnswer) => {
      const item = state.current;
      if (!item || item.kind !== "cleanup" || state.busy) return;
      await record(() => learnModeService.cleanupAnswer(item.question.detectionId, answer), item, false);
    },
    [record, state],
  );

  const answerMail = useCallback(
    async (answer: Exclude<BulkAnswer, "skip">) => {
      const item = state.current;
      if (!item || item.kind !== "bulk" || state.busy) return;
      await record(() => learnModeService.sampleAnswer(item.rowId, answer), item, false);
    },
    [record, state],
  );

  const skip = useCallback(async () => {
    const item = state.current;
    if (!item || state.busy) return;
    if (item.kind === "cleanup") {
      skippedDeals.current = [...skippedDeals.current, item.question.detectionId];
      await record(async () => ({ success: true }), item, true);
    } else {
      await record(() => learnModeService.sampleAnswer(item.rowId, "skip"), item, true);
    }
  }, [record, state]);

  const undo = useCallback(async () => {
    const last = history.current.pop();
    if (!last || state.busy) {
      if (last) history.current.push(last);
      return;
    }
    if (last.item.kind === "cleanup" && last.skipped) {
      const id = last.item.question.detectionId;
      skippedDeals.current = skippedDeals.current.filter((d) => d !== id);
    }
    setState((s) => ({
      ...s,
      index: Math.max(1, s.index - 1),
      answered: last.skipped ? s.answered : Math.max(0, s.answered - 1),
    }));
    const my = ++seq.current;
    await show(last.item, my);
  }, [show, state.busy]);

  const close = useCallback(() => {
    seq.current += 1;
    setState(CLOSED);
  }, []);

  return { ...state, start, answerDeal, answerMail, skip, undo, close };
}
