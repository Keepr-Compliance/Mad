/**
 * Data & Privacy › "Learn mode answers" — BACKLOG-4120 PR3.
 *
 * Founder (2026-11-04): a user may delete his saved Learn mode answers with
 * Learn mode OFF and with his org's key off. This row therefore lives in Data
 * & Privacy, which is always shown, not in the "Help Keepr learn" section,
 * which is hidden when the key is off. It appears only when there are saved
 * answers (counts from main, whatever the toggle and the key say). Removal is
 * soft: main marks the rows removed and never reads them again.
 *
 * 2.46.2: "Review" opens "Your answers" here (delete one), the only place it
 * is reachable with the org key off; both confirms are inline (no dialog).
 */
import React, { useCallback, useEffect, useState } from "react";
import learnModeService from "@/services/learnModeService";
import { LearnAnswersList } from "./LearnAnswersList";
import { PILOT_PRIVACY_DELETE_TOO, PILOT_PRIVACY_SHARED } from "./learnPilotCopy";

export function LearnAnswersPrivacyRow(): React.ReactElement | null {
  const [count, setCount] = useState(0);
  // BACKLOG-4219: "Help improve Keepr" is ON.
  const [sharing, setSharing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadCount = useCallback(async (isCancelled: () => boolean = () => false) => {
    const st = await learnModeService.getState();
    if (!isCancelled() && st.success) {
      setCount(st.answers.deal + st.answers.bulk);
      setSharing(st.pilotReport);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadCount(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadCount]);

  const onConfirm = useCallback(async () => {
    setDeleting(true);
    const r = await learnModeService.deleteAnswers();
    setDeleting(false);
    setConfirming(false);
    if (r.success) {
      setCount(0);
      setSharing(false); // Delete all also turns sharing off and deletes the shared numbers (main).
      setReviewing(false);
      setMessage("Your Learn mode answers were deleted.");
    } else {
      setMessage(r.error);
    }
  }, []);

  if (count === 0 && !message) return null;

  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200" data-testid="learn-answers-privacy">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <h4 className="text-sm font-medium text-gray-900">Learn mode answers</h4>
          <p className="text-xs text-gray-600 mt-1">
            {count > 0
              ? `${count} ${count === 1 ? "answer" : "answers"} saved on this computer. Deleting them does not change your transactions.${sharing ? ` ${PILOT_PRIVACY_SHARED}` : ""}`
              : message}
          </p>
        </div>
        {count > 0 && !confirming && (
          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              aria-expanded={reviewing}
              onClick={() => setReviewing((v) => !v)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 rounded border border-gray-300 transition-colors"
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded border border-red-200 transition-colors"
            >
              Delete all
            </button>
          </div>
        )}
      </div>
      {/* Inline, inside the row: a dialog would portal out of the Settings page and sit behind it. */}
      {confirming && (
        <div
          className="mt-3 flex items-center justify-between gap-4 rounded border border-red-200 bg-white px-3 py-2"
          data-testid="learn-delete-all-confirm"
        >
          <span className="text-sm text-gray-900">
            Delete all answers? Your transactions don&apos;t change.{sharing ? ` ${PILOT_PRIVACY_DELETE_TOO}` : ""}
          </span>
          <span className="flex flex-none items-center gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => void onConfirm()}
              className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              Delete all
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => setConfirming(false)}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </span>
        </div>
      )}
      {reviewing && count > 0 && (
        <div className="mt-3">
          <LearnAnswersList showWhenEmpty onChanged={() => void loadCount()} />
        </div>
      )}
    </div>
  );
}
