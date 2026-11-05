/**
 * Settings › "Help Keepr learn" (board L1) — BACKLOG-4120 PR3.
 *
 * Rendered by Settings only when the strict autodetect_eval read is
 * "allowed" (never the fail-open isAllowed, never the AI add-on gate). Inside:
 * the Learn mode switch (default OFF). Everything below the switch renders
 * only when main says the switch is ON.
 *
 * Learn mode is separate from AI detection: it reads mail on this computer,
 * never creates a transaction, and never uses AI.
 */
import React, { useCallback, useEffect, useState } from "react";
import { usePlatform } from "@/contexts/PlatformContext";
import { useLearnSettings } from "./useLearnSettings";
import { useLearnSession } from "./useLearnSession";
import { LearnQuestionDialog } from "./LearnQuestionDialog";
import { LearnScoreDialog } from "./LearnScoreDialog";
import { LearnStatTiles } from "./LearnStatTiles";
import { learnTiles } from "./learnScoreView";

function minutesFor(questions: number): string {
  const minutes = Math.max(1, Math.round((questions * 25) / 60));
  return minutes === 1 ? "About 1 minute" : `About ${minutes} minutes`;
}

export function LearnSettings(): React.ReactElement {
  const learn = useLearnSettings();
  const session = useLearnSession();
  const { isMacOS } = usePlatform();
  const [scoreOpen, setScoreOpen] = useState<null | { answered: number | null }>(null);
  const machine = isMacOS ? "this Mac" : "this computer";

  const { answered, close } = session;
  const { refresh } = learn;
  const finishSession = useCallback((): void => {
    close();
    void refresh();
    setScoreOpen({ answered });
  }, [answered, close, refresh]);

  // The sitting ran out of questions: show the score (board L4).
  useEffect(() => {
    if (session.phase === "done") finishSession();
  }, [session.phase, finishSession]);

  return (
    <div id="settings-learn" className="mb-8" data-testid="settings-learn">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-xl font-semibold leading-7 text-gray-900">Help Keepr learn</h3>
          <p className="m-0 text-sm text-gray-500">
            Answer quick Yes / No questions so Keepr gets better at finding your deals.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4">
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-gray-900">Learn mode</span>
            <span className="text-[13px] text-gray-500">
              Keepr asks questions about mail on {machine}. It never creates transactions and never uses AI. Nothing
              leaves {machine}.
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={learn.enabled}
            aria-label="Learn mode"
            disabled={learn.loading || learn.saving}
            onClick={() => void learn.setEnabled(!learn.enabled)}
            className={`relative inline-flex h-6 w-10 flex-none items-center rounded-full transition-colors disabled:opacity-50 ${
              learn.enabled ? "bg-sky-700" : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white transition-transform ${
                learn.enabled ? "translate-x-[19px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>
        {learn.error && <p className="m-0 text-[13px] text-red-700">{learn.error}</p>}

        {learn.enabled && (
          <>
            {learn.phase === "reading" || learn.phase === "idle" ? (
              <div
                className="flex items-center gap-4 rounded-lg bg-sky-700 px-5 py-4 text-white"
                data-testid="learn-reading"
              >
                <span className="h-5 w-5 flex-none animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">Reading your mail…</span>
                  <span className="text-[13px] text-sky-100">
                    {learn.rowsScanned > 0 ? `${learn.rowsScanned.toLocaleString()} emails so far.` : "This can take a minute."}
                  </span>
                </span>
              </div>
            ) : learn.phase === "ready" ? (
              <button
                type="button"
                data-testid="learn-start"
                disabled={learn.questionsReady === 0}
                onClick={() => void session.start(learn.questionsReady)}
                className="flex w-full items-center gap-4 rounded-lg bg-sky-700 px-5 py-4 text-left text-white hover:bg-sky-800 disabled:cursor-default disabled:hover:bg-sky-700"
              >
                <span className="inline-grid h-11 w-11 flex-none place-items-center rounded-lg bg-white/15 text-lg font-bold">
                  {learn.questionsReady}
                </span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{learn.questionsReady === 0 ? "No questions right now" : "Questions ready"}</span>
                  <span className="text-[13px] text-sky-100">
                    {learn.questionsReady === 0
                      ? "There are no more questions about the mail on this computer."
                      : `${minutesFor(learn.questionsReady)}. Stop any time; your answers are kept.`}
                  </span>
                </span>
                {learn.questionsReady > 0 && (
                  <span className="inline-flex h-9 flex-none items-center rounded-md bg-white px-4 font-semibold text-sky-700">
                    Start
                  </span>
                )}
              </button>
            ) : null}

            {learn.score && (
              <div className="overflow-hidden rounded-lg border border-[#E6E4DF] bg-white" data-testid="learn-doing">
                <div className="flex justify-between border-b border-[#E6E4DF] bg-[#FAF9F7] px-5 py-3">
                  <span className="font-semibold">How Keepr is doing</span>
                  <button
                    type="button"
                    className="font-medium text-sky-700 hover:text-sky-800"
                    onClick={() => setScoreOpen({ answered: null })}
                  >
                    See score →
                  </button>
                </div>
                <LearnStatTiles tiles={learnTiles(learn.score)} />
              </div>
            )}

            <p className="m-0 text-[13px] text-gray-500" data-testid="learn-footer">
              {learn.answerCount === 1 ? "1 answer so far." : `${learn.answerCount} answers so far.`} Turning Learn mode
              off keeps your answers; you can delete them in Data & Privacy.
            </p>
          </>
        )}
      </div>

      <LearnQuestionDialog
        session={session}
        onClose={() => {
          if (session.answered > 0) finishSession();
          else {
            session.close();
            void learn.refresh();
          }
        }}
      />
      <LearnScoreDialog
        open={scoreOpen !== null}
        answered={scoreOpen?.answered ?? null}
        score={learn.score}
        copyBlock={learn.copyBlock}
        onClose={() => setScoreOpen(null)}
      />
    </div>
  );
}
