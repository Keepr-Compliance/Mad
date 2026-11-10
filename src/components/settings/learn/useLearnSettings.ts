/**
 * State of the Settings "Help Keepr learn" section — BACKLOG-4120 PR3.
 *
 * Main decides everything (availability, the toggle, what is stored); this
 * hook only asks, through learnModeService, and keeps the answers for the
 * screen. Nothing here logs a reply.
 *
 * With the toggle ON the section needs a run of the old rules over local
 * mail: if main holds none for this user, one is started (12 months) and its
 * progress shown, then the bulk sample is drawn (once; idempotent in main).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import learnModeService from "@/services/learnModeService";
import type { LearnScore } from "../../../../electron/types/ipc/window-api-learn";

export const LEARN_WINDOW_MONTHS = 12;

export type LearnPrepPhase = "idle" | "reading" | "ready" | "error";

export interface LearnSettingsState {
  loading: boolean;
  available: boolean;
  enabled: boolean;
  answerCount: number;
  phase: LearnPrepPhase;
  rowsScanned: number;
  questionsReady: number;
  score: LearnScore | null;
  copyBlock: string | null;
  saving: boolean;
  error: string | null;
  /** BACKLOG-4219: "Share my score with Keepr" is ON. */
  pilotReport: boolean;
  /** BACKLOG-4219: a withdraw is still owed (it finishes when the computer is online). */
  pilotPending: boolean;
  pilotLastSentAt: string | null;
  pilotSaving: boolean;
}

const INITIAL: LearnSettingsState = {
  loading: true,
  available: false,
  enabled: false,
  answerCount: 0,
  phase: "idle",
  rowsScanned: 0,
  questionsReady: 0,
  score: null,
  copyBlock: null,
  saving: false,
  error: null,
  pilotReport: false,
  pilotPending: false,
  pilotLastSentAt: null,
  pilotSaving: false,
};

export interface UseLearnSettings extends LearnSettingsState {
  setEnabled: (enabled: boolean) => Promise<void>;
  /** BACKLOG-4219: turn "Share my score with Keepr" on or off. */
  setPilotReport: (enabled: boolean) => Promise<void>;
  /** Re-read the score and the question count (after a session). */
  refresh: () => Promise<void>;
}

export function useLearnSettings(): UseLearnSettings {
  const [state, setState] = useState<LearnSettingsState>(INITIAL);
  const mounted = useRef(true);
  const sampleSize = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const patch = useCallback((p: Partial<LearnSettingsState>) => {
    if (mounted.current) setState((s) => ({ ...s, ...p }));
  }, []);

  const loadScore = useCallback(async (): Promise<boolean> => {
    const r = await learnModeService.score();
    if (!r.success) return false;
    const bulkLeft = Math.max(0, sampleSize.current - r.score.bulk.answered);
    patch({
      score: r.score,
      copyBlock: r.copyBlock,
      questionsReady: Math.max(0, r.score.cleanupUnanswered) + bulkLeft,
      phase: "ready",
    });
    return true;
  }, [patch]);

  const loadCounts = useCallback(async () => {
    const st = await learnModeService.getState();
    if (st.success) {
      patch({
        available: st.available,
        enabled: st.enabled,
        answerCount: st.answers.deal + st.answers.bulk,
        pilotReport: st.pilotReport,
        pilotPending: st.pilotPending,
        pilotLastSentAt: st.pilotLastSentAt,
      });
    }
  }, [patch]);

  const prepare = useCallback(async () => {
    const draw = await learnModeService.sampleDraw(LEARN_WINDOW_MONTHS);
    if (draw.success) sampleSize.current = draw.result.sampleSize;
    if (await loadScore()) return;
    // No run in main for this user yet: read the mail now.
    patch({ phase: "reading", rowsScanned: 0, error: null });
    const unsubscribe = learnModeService.onRunProgress((p) => patch({ rowsScanned: p.rowsScanned }));
    try {
      const run = await learnModeService.run(LEARN_WINDOW_MONTHS);
      if (!run.success) {
        patch({ phase: "error", error: run.error });
        return;
      }
    } finally {
      unsubscribe();
    }
    if (!(await loadScore())) patch({ phase: "error", error: "Keepr could not read the score." });
  }, [loadScore, patch]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const st = await learnModeService.getState();
      if (cancelled) return;
      if (!st.success) {
        patch({ loading: false, error: st.error });
        return;
      }
      patch({
        loading: false,
        available: st.available,
        enabled: st.enabled,
        answerCount: st.answers.deal + st.answers.bulk,
        pilotReport: st.pilotReport,
        pilotPending: st.pilotPending,
        pilotLastSentAt: st.pilotLastSentAt,
      });
      if (st.enabled) await prepare();
    })();
    return () => {
      cancelled = true;
    };
  }, [patch, prepare]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      patch({ saving: true, error: null });
      const r = await learnModeService.setEnabled(enabled);
      if (!r.success) {
        patch({ saving: false, error: r.error });
        return;
      }
      patch({ saving: false, enabled: r.enabled, phase: "idle", score: null, copyBlock: null, questionsReady: 0 });
      // Learn mode off also turns sharing off (main): re-read it.
      if (!r.enabled) await loadCounts();
      if (r.enabled) await prepare();
    },
    [patch, prepare, loadCounts],
  );

  const setPilotReport = useCallback(
    async (enabled: boolean) => {
      patch({ pilotSaving: true, error: null });
      const r = await learnModeService.setPilotReport(enabled);
      if (!r.success) {
        patch({ pilotSaving: false, error: r.error });
        return;
      }
      patch({ pilotSaving: false, pilotReport: r.pilotReport, pilotPending: r.pilotPending });
    },
    [patch],
  );

  const refresh = useCallback(async () => {
    await loadCounts();
    const draw = await learnModeService.sampleDraw(LEARN_WINDOW_MONTHS);
    if (draw.success) sampleSize.current = draw.result.sampleSize;
    await loadScore();
  }, [loadCounts, loadScore]);

  return { ...state, setEnabled, setPilotReport, refresh };
}
