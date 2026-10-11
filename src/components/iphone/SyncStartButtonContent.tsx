import React from "react";
import { retryCooldownMessage } from "../../utils/syncRetryCooldown";

/**
 * BACKLOG-3816: what a Sync / Try Again button shows while its request is being prepared.
 * Shared by the connect step's Sync button and the error screen's Try Again.
 */
export const GETTING_READY_LABEL = "Getting ready\u2026";

export const SyncStartButtonContent: React.FC<{ isStarting: boolean; label: string }> = ({
  isStarting,
  label,
}) =>
  isStarting ? (
    <span className="inline-flex items-center gap-2" data-testid="sync-getting-ready">
      <span
        className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
        aria-hidden="true"
      />
      {GETTING_READY_LABEL}
    </span>
  ) : (
    <>{label}</>
  );

/** BACKLOG-3816: the hold notice under the button; renders nothing once the hold is over. */
export const RetryCooldownNotice: React.FC<{ secondsLeft: number }> = ({ secondsLeft }) =>
  secondsLeft > 0 ? (
    <p className="text-sm text-gray-600 mt-3 max-w-sm" role="status" data-testid="sync-retry-cooldown">
      {retryCooldownMessage(secondsLeft)}
    </p>
  ) : null;
