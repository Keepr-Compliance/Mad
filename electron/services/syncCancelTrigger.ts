import type { SyncCancelTrigger } from "../types/ipc/window-api-platform";

/**
 * BACKLOG-3816: the controls that may end a sync as `user-cancel`. A Record (not an
 * array) so adding a member to `SyncCancelTrigger` without listing it here fails tsc.
 */
const SYNC_CANCEL_TRIGGERS: Record<SyncCancelTrigger, true> = {
  "progress-cancel": true,
  "error-close": true,
  "try-again-no-device": true,
};

export function isSyncCancelTrigger(value: unknown): value is SyncCancelTrigger {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SYNC_CANCEL_TRIGGERS, value);
}
