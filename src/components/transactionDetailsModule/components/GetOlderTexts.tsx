/**
 * BACKLOG-3892 S6 — "Get older texts": the action under an iPhone start warning (the Texts
 * tab notice and the export gate). Reads the deal's older texts from the iPhone backup kept
 * on this computer (S5), with progress and Cancel.
 *
 * Shows the button ONLY when availability is `available`. All IPC goes through
 * useIphoneBackfill -> iphoneBackfillService. Every line comes from coverageCopy.ts.
 */
import React from "react";
import { useIphoneBackfill } from "../../../hooks/useIphoneBackfill";
import type { BackfillReason, BackfillResult } from "../../../../electron/types/iphoneBackfill";
import {
  GET_OLDER_TEXTS_LABEL,
  GET_OLDER_TEXTS_PHASE,
  GET_OLDER_TEXTS_RUNNING,
  getOlderTextsDoneLine,
  getOlderTextsRefusalLine,
  getOlderTextsUnavailableLine,
} from "./coverageCopy";

const BACKUP_UNUSABLE: ReadonlySet<BackfillReason> = new Set<BackfillReason>(["missing", "damaged", "key-missing"]);

export interface GetOlderTextsProps {
  transactionId: string;
  /** Re-ask availability when this changes (the gap was re-read). */
  refreshKey?: string | number;
  /** A run ended successfully: re-check coverage with the chosen source, reload texts. */
  onSuccess?: (result: BackfillResult) => void | Promise<void>;
}

export function GetOlderTexts({ transactionId, refreshKey, onSuccess }: GetOlderTextsProps): React.ReactElement | null {
  const { availability, running, progress, result, start, cancel } = useIphoneBackfill(transactionId, {
    enabled: true,
    refreshKey,
    onSuccess,
  });

  if (running) {
    const percent = progress?.percent ?? 0;
    return (
      <div className="mt-2" data-testid="get-older-texts-progress">
        <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
          <span>
            {GET_OLDER_TEXTS_RUNNING}
            {progress && (
              <span className="ml-1 text-gray-500" data-testid="get-older-texts-phase">
                ({GET_OLDER_TEXTS_PHASE[progress.phase] ?? ""})
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            {progress && <span>{percent}%</span>}
            <button
              type="button"
              className="text-indigo-700 hover:text-indigo-900 font-medium"
              onClick={() => void cancel()}
              data-testid="get-older-texts-cancel"
            >
              Cancel
            </button>
          </span>
        </div>
        {progress ? (
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${percent}%` }} />
          </div>
        ) : (
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full w-1/3 bg-indigo-500 rounded-full animate-pulse" />
          </div>
        )}
      </div>
    );
  }

  const resultLine = result
    ? result.success
      ? getOlderTextsDoneLine(result.messagesStored)
      : getOlderTextsRefusalLine(result.reason, result.message)
    : null;
  const unavailableLine =
    !result && availability && !availability.available
      ? getOlderTextsUnavailableLine(availability.reason, availability.message)
      : null;
  // A run refused because the backup itself is unusable: availability can still say
  // `available` (the files are there), but trying again cannot help — no button.
  const backupUnusable = !!result && !result.success && !!result.reason && BACKUP_UNUSABLE.has(result.reason);
  const offered = availability?.available === true && !backupUnusable;

  if (!resultLine && !unavailableLine && !offered) return null;
  return (
    <span className="block mt-1">
      {resultLine && <span data-testid="get-older-texts-result">{resultLine}</span>}
      {unavailableLine && <span data-testid="get-older-texts-unavailable">{unavailableLine}</span>}
      {offered && (
        <button
          type="button"
          className={`${resultLine ? "ml-2 " : ""}text-indigo-700 hover:text-indigo-900 font-medium disabled:opacity-50`}
          onClick={() => void start()}
          data-testid="get-older-texts-button"
        >
          {GET_OLDER_TEXTS_LABEL}
        </button>
      )}
    </span>
  );
}

export default GetOlderTexts;
