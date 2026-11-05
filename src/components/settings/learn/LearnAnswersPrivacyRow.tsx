/**
 * Data & Privacy › "Learn mode answers" — BACKLOG-4120 PR3.
 *
 * Founder (2026-11-04): a user may delete his saved Learn mode answers with
 * Learn mode OFF and with his org's key off. This row therefore lives in Data
 * & Privacy, which is always shown, not in the "Help Keepr learn" section,
 * which is hidden when the key is off. It appears only when there are saved
 * answers (counts from main, whatever the toggle and the key say). Removal is
 * soft: main marks the rows removed and never reads them again.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ConfirmationDialog } from "@keepr/ui";
import learnModeService from "@/services/learnModeService";

export function LearnAnswersPrivacyRow(): React.ReactElement | null {
  const [count, setCount] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void learnModeService.getState().then((st) => {
      if (!cancelled && st.success) setCount(st.answers.deal + st.answers.bulk);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onConfirm = useCallback(async () => {
    setDeleting(true);
    const r = await learnModeService.deleteAnswers();
    setDeleting(false);
    setConfirming(false);
    if (r.success) {
      setCount(0);
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
              ? `${count} ${count === 1 ? "answer" : "answers"} saved on this computer. Deleting them does not change your transactions.`
              : message}
          </p>
        </div>
        {count > 0 && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded border border-red-200 transition-colors"
          >
            Delete answers
          </button>
        )}
      </div>
      <ConfirmationDialog
        open={confirming}
        title="Delete your Learn mode answers?"
        description="Keepr will forget every answer you gave in Learn mode on this computer."
        confirmLabel="Delete answers"
        isDestructive
        loading={deleting}
        onConfirm={() => void onConfirm()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
