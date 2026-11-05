/**
 * Learn mode score (board L4) — BACKLOG-4120 PR3.
 *
 * After a sitting: "Thanks, N answers saved". From "See score": "How Keepr is
 * doing". The three tiles are the board's; the detail lines below them carry
 * what the board leaves out (learnScoreView.ts) and the Copy block, which
 * holds aggregates only.
 */
import React, { useState } from "react";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@keepr/ui";
import { useCopyText } from "@/hooks/useCopyText";
import type { LearnScore } from "../../../../electron/types/ipc/window-api-learn";
import { LearnStatTiles } from "./LearnStatTiles";
import { learnDetailLines, learnTiles } from "./learnScoreView";

export function LearnScoreDialog({
  open,
  answered,
  score,
  copyBlock,
  onClose,
}: {
  open: boolean;
  /** Answers saved in the sitting just finished; null when opened from "See score". */
  answered: number | null;
  score: LearnScore | null;
  copyBlock: string | null;
  onClose: () => void;
}): React.ReactElement {
  const [details, setDetails] = useState(false);
  const { copied, copy } = useCopyText("LearnScore");
  const title =
    answered === null ? "How Keepr is doing" : `Thanks, ${answered} ${answered === 1 ? "answer" : "answers"} saved`;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent
        hideClose
        className="flex w-[560px] max-w-[calc(100vw-32px)] flex-col items-center gap-6 rounded-xl border-0 bg-white px-12 py-8 text-center text-[15px] leading-normal text-[#1C2430]"
      >
        <span className="inline-grid h-12 w-12 place-items-center rounded-full bg-green-100 text-green-700">
          <Check className="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="m-0 text-xl font-semibold leading-7">{title}</DialogTitle>
          <DialogDescription className="text-[15px] text-gray-500">
            Your answers are kept on this computer and are never sent anywhere.
          </DialogDescription>
        </div>
        {score ? (
          <div className="w-full rounded-[10px] border border-[#E6E4DF]">
            <LearnStatTiles tiles={learnTiles(score)} />
          </div>
        ) : (
          <p className="text-sm text-gray-500">The score is not ready yet.</p>
        )}
        {score && (
          <div className="w-full text-left">
            <button
              type="button"
              className="text-[13px] font-medium text-sky-700 hover:text-sky-800"
              aria-expanded={details}
              onClick={() => setDetails((d) => !d)}
            >
              {details ? "Hide details" : "Details"}
            </button>
            {details && (
              <div className="mt-2 flex flex-col gap-2" data-testid="learn-score-details">
                <ul className="m-0 list-none space-y-1 p-0 text-[13px] text-gray-600">
                  {learnDetailLines(score).map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
                {copyBlock && (
                  <button
                    type="button"
                    className="self-start rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    onClick={() => copy(copyBlock)}
                  >
                    {copied ? "Copied" : "Copy score"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-12 w-full items-center justify-center rounded-[10px] bg-sky-700 font-semibold text-white hover:bg-sky-800"
        >
          Done
        </button>
      </DialogContent>
    </Dialog>
  );
}
