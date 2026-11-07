/**
 * "Your answers" — BACKLOG-4120, 2.46.2.
 *
 * Every saved Learn mode answer of the user, newest first, each with Delete.
 * Delete asks inline, inside the row: no dialog, because a dialog portals out
 * of the Settings page and sits behind it (the trap that hid Start in 2.46.0).
 * Main soft-removes the answer and the item can be asked again.
 *
 * Works with Learn mode off and with the org key off (the channels are
 * ungated, session only). Addresses and subjects are shown, never logged.
 */
import React, { useCallback, useEffect, useState } from "react";
import learnModeService from "@/services/learnModeService";
import type { LearnAnswerRow } from "../../../../electron/types/ipc/window-api-learn";

const ANSWER_TEXT: Record<string, string> = {
  yes: "Yes, my deal",
  no: "No",
  real_estate: "Real estate",
  newsletter_spam: "Newsletter or spam",
  skip: "Skipped",
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function rowText(row: LearnAnswerRow): { label: string; date: string | null } {
  if (row.kind === "deal") {
    const answered = formatDate(row.answeredAt);
    return { label: row.label ?? "Deal", date: answered ? `Answered ${answered}` : null };
  }
  return { label: row.label ?? "Message no longer on this computer", date: formatDate(row.itemDate) };
}

function AnswerRow({
  row,
  onDeleted,
}: {
  row: LearnAnswerRow;
  onDeleted: (row: LearnAnswerRow) => void;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, date } = rowText(row);

  const onConfirm = useCallback(async () => {
    setDeleting(true);
    const r = await learnModeService.deleteAnswer(row.kind, row.id);
    setDeleting(false);
    if (r.success) {
      onDeleted(row);
    } else {
      setConfirming(false);
      setError(r.error);
    }
  }, [row, onDeleted]);

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-2.5" data-testid="learn-answer-row">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-gray-900">{label}</span>
        <span className="text-xs text-gray-500">
          {ANSWER_TEXT[row.answer] ?? row.answer}
          {date ? ` · ${date}` : ""}
        </span>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </span>
      {confirming ? (
        <span className="flex flex-none items-center gap-2">
          <span className="text-xs text-gray-700">Delete?</span>
          <button
            type="button"
            disabled={deleting}
            onClick={() => void onConfirm()}
            className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            Delete
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={() => setConfirming(false)}
            className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="flex-none rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Delete
        </button>
      )}
    </li>
  );
}

export function LearnAnswersList({
  onChanged,
  showWhenEmpty = false,
}: {
  /** Called after an answer is deleted (the score and the counts change). */
  onChanged?: () => void;
  /** Render "No answers saved." instead of nothing when the list is empty. */
  showWhenEmpty?: boolean;
}): React.ReactElement | null {
  const [rows, setRows] = useState<LearnAnswerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void learnModeService.listAnswers().then((r) => {
      if (cancelled) return;
      if (r.success) setRows(r.answers);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onDeleted = useCallback(
    (row: LearnAnswerRow) => {
      setRows((rs) => (rs ? rs.filter((x) => !(x.kind === row.kind && x.id === row.id)) : rs));
      onChanged?.();
    },
    [onChanged],
  );

  if (error) return showWhenEmpty ? <p className="m-0 text-[13px] text-red-700">{error}</p> : null;
  if (rows === null) return null;
  if (rows.length === 0 && !showWhenEmpty) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-[#E6E4DF] bg-white" data-testid="learn-answers-list">
      <div className="border-b border-[#E6E4DF] bg-[#FAF9F7] px-4 py-3 font-semibold">Your answers</div>
      {rows.length === 0 ? (
        <p className="m-0 px-4 py-3 text-sm text-gray-500">No answers saved.</p>
      ) : (
        <ul className="m-0 max-h-80 list-none divide-y divide-[#EEECE7] overflow-y-auto p-0">
          {rows.map((row) => (
            <AnswerRow key={`${row.kind}:${row.id}`} row={row} onDeleted={onDeleted} />
          ))}
        </ul>
      )}
    </div>
  );
}
