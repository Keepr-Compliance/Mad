/**
 * Learn mode question sitting, over the main screen (BACKLOG-4120, 2.46.1).
 *
 * Settings › Help Keepr learn › Start closes Settings and opens this from the
 * app's modal layer (AppModals), the way Settings' "Import from iPhone" hands
 * off to the iPhone sync modal. It owns the session, so the sitting no longer
 * depends on the Settings page staying mounted.
 *
 * Starts the sitting once on mount; shows the question dialog (L2/L3), then
 * the score (L4) when the sitting ends with answers. onClose unmounts it.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import learnModeService from "@/services/learnModeService";
import type { LearnScore } from "../../../../electron/types/ipc/window-api-learn";
import { useLearnSession } from "./useLearnSession";
import { LearnQuestionDialog } from "./LearnQuestionDialog";
import { LearnScoreDialog } from "./LearnScoreDialog";

interface ScoreView {
  answered: number;
  score: LearnScore | null;
  copyBlock: string | null;
}

export function LearnSessionHost({ total, onClose }: { total: number; onClose: () => void }): React.ReactElement {
  const session = useLearnSession();
  const [scoreView, setScoreView] = useState<ScoreView | null>(null);
  const started = useRef(false);
  const { start, close, answered } = session;

  // Once per mount (StrictMode re-runs effects; the sitting must start once).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start(total);
  }, [start, total]);

  const finish = useCallback(async (): Promise<void> => {
    close();
    if (answered === 0) {
      onClose();
      return;
    }
    const r = await learnModeService.score();
    setScoreView({
      answered,
      score: r.success ? r.score : null,
      copyBlock: r.success ? r.copyBlock : null,
    });
  }, [answered, close, onClose]);

  // The sitting ran out of questions: show the score (board L4).
  useEffect(() => {
    if (session.phase === "done") void finish();
  }, [session.phase, finish]);

  return (
    <div data-testid="learn-session-host">
      <LearnQuestionDialog session={session} onClose={() => void finish()} />
      <LearnScoreDialog
        open={scoreView !== null}
        answered={scoreView?.answered ?? null}
        score={scoreView?.score ?? null}
        copyBlock={scoreView?.copyBlock ?? null}
        onClose={onClose}
      />
    </div>
  );
}

/**
 * "See score" over the main screen (BACKLOG-4120, 2.46.1): Settings › Help
 * Keepr learn › See score closes Settings and AppModals mounts this. Reads the
 * score from main once, then shows the L4 dialog titled "How Keepr is doing".
 */
export function LearnScoreHost({ onClose }: { onClose: () => void }): React.ReactElement {
  const [view, setView] = useState<{ score: LearnScore | null; copyBlock: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void learnModeService.score().then((r) => {
      if (!cancelled) setView({ score: r.success ? r.score : null, copyBlock: r.success ? r.copyBlock : null });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <LearnScoreDialog
      open={view !== null}
      answered={null}
      score={view?.score ?? null}
      copyBlock={view?.copyBlock ?? null}
      onClose={onClose}
    />
  );
}
