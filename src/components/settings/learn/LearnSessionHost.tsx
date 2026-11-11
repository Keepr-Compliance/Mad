/**
 * Learn mode question sitting, over the main screen (BACKLOG-4120, 2.46.1).
 *
 * Settings › Help Keepr learn › Start closes Settings and opens this from the
 * app's modal layer (AppModals), the way Settings' "Import from iPhone" hands
 * off to the iPhone sync modal. It owns the session, so the sitting no longer
 * depends on the Settings page staying mounted.
 *
 * Starts the sitting once on mount; shows the question dialog (L2/L3), then
 * the score (L4) when the sitting ends (2.46.2: always, and "N more" when the
 * sitting of LEARN_SITTING_SIZE filled up and another question exists).
 * onClose unmounts it.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import learnModeService from "@/services/learnModeService";
import type { LearnScore } from "../../../../electron/types/ipc/window-api-learn";
import { useLearnSession } from "./useLearnSession";
import { LearnQuestionDialog } from "./LearnQuestionDialog";
import { LearnScoreDialog } from "./LearnScoreDialog";
import { LEARN_SITTING_SIZE } from "./learnSitting";

interface ScoreView {
  /** null: nothing answered in this sitting ("How Keepr is doing"). */
  answered: number | null;
  score: LearnScore | null;
  copyBlock: string | null;
  /** Size of the next sitting, when the sitting filled up and another question exists. */
  more: number | null;
  /** BACKLOG-4219: sharing ON / OFF; null when the state could not be read. */
  sharing: boolean | null;
}

/** BACKLOG-4219: whether the numbers are shared, for the dialog's privacy line. */
async function readSharing(): Promise<boolean | null> {
  const st = await learnModeService.getState();
  return st.success ? st.pilotReport : null;
}

export function LearnSessionHost({ total, onClose }: { total: number; onClose: () => void }): React.ReactElement {
  const session = useLearnSession();
  const [scoreView, setScoreView] = useState<ScoreView | null>(null);
  const started = useRef(false);
  const finishing = useRef(false);
  // Questions not yet handled, as counted when Start was pressed (uncapped).
  const remaining = useRef(total);
  const { start, close, settle, getAnswered, getHandled, peekMore, more } = session;

  // Once per mount (StrictMode re-runs effects; the sitting must start once).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start(total);
  }, [start, total]);

  /**
   * End the sitting (it filled up or ran out, or Done for now / Esc / click
   * outside). close() first, so a store in flight asks for nothing after it;
   * then wait for that store, so the score counts it. The score shows every
   * time.
   */
  const finish = useCallback(
    async (reason: "empty" | "sitting" | null): Promise<void> => {
      if (finishing.current) return;
      finishing.current = true;
      close();
      await settle();
      const answered = getAnswered();
      remaining.current = Math.max(0, remaining.current - getHandled());
      let next: number | null = null;
      if (reason === "sitting" && (await peekMore())) {
        next = Math.min(LEARN_SITTING_SIZE, Math.max(1, remaining.current));
      }
      const r = await learnModeService.score();
      const sharing = await readSharing();
      setScoreView({
        answered: answered > 0 ? answered : null,
        score: r.success ? r.score : null,
        copyBlock: r.success ? r.copyBlock : null,
        more: next,
        sharing,
      });
    },
    [close, settle, getAnswered, getHandled, peekMore],
  );

  // The sitting filled up or ran out of questions: show the score (board L4).
  useEffect(() => {
    if (session.phase === "done") void finish(session.doneReason);
  }, [session.phase, session.doneReason, finish]);

  const onMore = useCallback(() => {
    const next = scoreView?.more ?? null;
    if (next === null) return;
    setScoreView(null);
    finishing.current = false;
    void more(remaining.current);
  }, [scoreView, more]);

  return (
    <div data-testid="learn-session-host">
      <LearnQuestionDialog session={session} onClose={() => void finish(null)} />
      <LearnScoreDialog
        open={scoreView !== null}
        answered={scoreView?.answered ?? null}
        score={scoreView?.score ?? null}
        copyBlock={scoreView?.copyBlock ?? null}
        more={scoreView?.more ?? null}
        onMore={onMore}
        onClose={onClose}
        sharing={scoreView?.sharing ?? null}
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
  const [view, setView] = useState<{
    score: LearnScore | null;
    copyBlock: string | null;
    sharing: boolean | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await learnModeService.score();
      const sharing = await readSharing();
      if (!cancelled) {
        setView({ score: r.success ? r.score : null, copyBlock: r.success ? r.copyBlock : null, sharing });
      }
    })();
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
      sharing={view?.sharing ?? null}
    />
  );
}
