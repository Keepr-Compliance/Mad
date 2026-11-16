/**
 * "Senders you marked as automated or mass mail" — BACKLOG-4212 PR3.
 *
 * Senders the user answered "Automated or mass mail" for often enough that Keepr
 * skips their mail when it looks for new deals, plus the ones the user chose
 * "Stop hiding" for. Each row toggles Stop hiding / Hide again, confirmed
 * inline inside the row (no dialog: the LearnAnswersList pattern).
 *
 * Ungated (session only): shown with Learn mode off too. Hidden entirely when
 * the list is empty or cannot be read. Addresses are shown, never logged.
 */
import React, { useCallback, useEffect, useState } from "react";
import learnModeService from "@/services/learnModeService";
import type { LearnSuppressedSender } from "../../../../electron/types/ipc/window-api-learn";

function SenderRow({
  sender,
  onToggled,
}: {
  sender: LearnSuppressedSender;
  onToggled: (senderKey: string, hidden: boolean) => void;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = sender.hidden ? "Stop hiding" : "Hide again";

  const onConfirm = useCallback(async () => {
    setSaving(true);
    const r = await learnModeService.setOverride(sender.senderKey, !sender.hidden);
    setSaving(false);
    setConfirming(false);
    if (r.success) onToggled(sender.senderKey, r.hidden);
    else setError(r.error);
  }, [sender, onToggled]);

  const count = sender.newsletterCount === 1 ? "1 answer" : `${sender.newsletterCount} answers`;

  return (
    <li className="flex items-center justify-between gap-4 px-4 py-2.5" data-testid="learn-suppressed-row">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-gray-900">{sender.senderKey}</span>
        <span className="text-xs text-gray-500">
          {count}
          {sender.hidden ? "" : " · Not hidden"}
        </span>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </span>
      {confirming ? (
        <span className="flex flex-none items-center gap-2">
          <span className="text-xs text-gray-700">{action}?</span>
          <button
            type="button"
            disabled={saving}
            onClick={() => void onConfirm()}
            className="whitespace-nowrap rounded border border-sky-700 bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-50"
          >
            {action}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setConfirming(false)}
            className="whitespace-nowrap rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
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
          className="whitespace-nowrap flex-none rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          {action}
        </button>
      )}
    </li>
  );
}

export function LearnSuppressedSenders({ machine }: { machine: string }): React.ReactElement | null {
  const [senders, setSenders] = useState<LearnSuppressedSender[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void learnModeService.listSuppressed().then((r) => {
      if (cancelled) return;
      setSenders(r.success ? r.senders : []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggled = useCallback((senderKey: string, hidden: boolean) => {
    setSenders((ss) => (ss ? ss.map((s) => (s.senderKey === senderKey ? { ...s, hidden } : s)) : ss));
  }, []);

  if (!senders || senders.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-[#E6E4DF] bg-white" data-testid="learn-suppressed-senders">
      <div className="border-b border-[#E6E4DF] bg-[#FAF9F7] px-4 py-3">
        <div className="font-semibold">Senders you marked as automated or mass mail</div>
        <p className="m-0 mt-1 text-[13px] text-gray-500" data-testid="learn-suppressed-copy">
          Keepr skips mail from these senders when it looks for new deals. This list stays on {machine}. Senders on
          your deals are never hidden. Choose Stop hiding to see their mail again.
        </p>
      </div>
      <ul className="m-0 max-h-80 list-none divide-y divide-[#EEECE7] overflow-y-auto p-0">
        {senders.map((s) => (
          <SenderRow key={s.senderKey} sender={s} onToggled={onToggled} />
        ))}
      </ul>
    </div>
  );
}
