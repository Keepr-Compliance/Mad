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
 *
 * Start and See score open nothing here: onStart / onSeeScore close Settings
 * and the app opens the questions or the score over the main screen
 * (LearnSessionHost / LearnScoreHost in AppModals, BACKLOG-4120 2.46.1).
 */
import React from "react";
import { usePlatform } from "@/contexts/PlatformContext";
import { useLearnSettings } from "./useLearnSettings";
import { LearnStatTiles } from "./LearnStatTiles";
import { learnTiles } from "./learnScoreView";
import { LearnAnswersList } from "./LearnAnswersList";
import { LEARN_SITTING_SIZE } from "./learnSitting";
import { pilotConsentText, pilotStatusLine } from "./learnPilotCopy";

function minutesFor(questions: number): string {
  const minutes = Math.max(1, Math.round((questions * 25) / 60));
  return minutes === 1 ? "About 1 minute" : `About ${minutes} minutes`;
}

export function LearnSettings({
  onStart,
  onSeeScore,
}: {
  onStart: (total: number) => void;
  onSeeScore: () => void;
}): React.ReactElement {
  const learn = useLearnSettings();
  const { isMacOS } = usePlatform();
  const machine = isMacOS ? "this Mac" : "this computer";
  // The card shows one sitting; Start passes the full count (the session stops at a sitting).
  const sitting = Math.min(LEARN_SITTING_SIZE, learn.questionsReady);

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
            <span className="text-[13px] text-gray-500" data-testid="learn-mode-copy">
              {/* BACKLOG-4219: true with sharing OFF and ON. */}
              Keepr asks questions about mail on {machine}. It never creates transactions and never uses AI.{" "}
              {learn.pilotReport
                ? `Your answers stay on ${machine}. Diagnostic numbers are shared with Keepr.`
                : `Nothing leaves ${machine}.`}
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
            {/* BACKLOG-4219: the pilot report switch (default OFF). */}
            <div
              className="flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4"
              data-testid="learn-pilot-row"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-gray-900">Help improve Keepr</span>
                <span className="text-[13px] text-gray-500" data-testid="learn-pilot-consent">
                  {pilotConsentText()}
                </span>
                {pilotStatusLine(learn.pilotPending, learn.pilotLastSentAt, machine) && (
                  <span className="text-[13px] text-gray-500" data-testid="learn-pilot-status">
                    {pilotStatusLine(learn.pilotPending, learn.pilotLastSentAt, machine)}
                  </span>
                )}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={learn.pilotReport}
                aria-label="Help improve Keepr"
                disabled={learn.loading || learn.pilotSaving}
                onClick={() => void learn.setPilotReport(!learn.pilotReport)}
                className={`relative inline-flex h-6 w-10 flex-none items-center rounded-full transition-colors disabled:opacity-50 ${
                  learn.pilotReport ? "bg-sky-700" : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white transition-transform ${
                    learn.pilotReport ? "translate-x-[19px]" : "translate-x-[3px]"
                  }`}
                />
              </button>
            </div>

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
                onClick={() => onStart(learn.questionsReady)}
                className="flex w-full items-center gap-4 rounded-lg bg-sky-700 px-5 py-4 text-left text-white hover:bg-sky-800 disabled:cursor-default disabled:hover:bg-sky-700"
              >
                <span className="inline-grid h-11 w-11 flex-none place-items-center rounded-lg bg-white/15 text-lg font-bold">
                  {sitting}
                </span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{learn.questionsReady === 0 ? "No questions right now" : "Questions ready"}</span>
                  <span className="text-[13px] text-sky-100">
                    {learn.questionsReady === 0
                      ? "There are no more questions about the mail on this computer."
                      : `${minutesFor(sitting)}. Stop any time; your answers are kept.`}
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
                    onClick={onSeeScore}
                  >
                    See score →
                  </button>
                </div>
                <LearnStatTiles tiles={learnTiles(learn.score)} />
              </div>
            )}

            <p className="m-0 text-[13px] text-gray-500" data-testid="learn-footer">
              {learn.answerCount === 1 ? "1 answer so far." : `${learn.answerCount} answers so far.`} Turning Learn mode
              off keeps your answers.
            </p>
          </>
        )}

        {/* Shown with the toggle off too: a user can always delete one of his own answers. */}
        {!learn.loading && <LearnAnswersList onChanged={() => void learn.refresh()} />}
      </div>

    </div>
  );
}
