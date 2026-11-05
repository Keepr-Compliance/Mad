/**
 * BACKLOG-3951 PR-B2 — per-user dismissal of the removed-member notice.
 *
 * Renderer state fed by a per-user preferences read through settingsService
 * (the same read path the BACKLOG-2890 hold state uses), so a dismissal
 * survives restarts for that user and never leaks to another user.
 *
 * `dismissed` is three-valued:
 *   undefined → not known yet (read pending or failed, or another user's answer)
 *   true      → this user dismissed the notice for this brokerage
 *   false     → this user has not dismissed it for this brokerage
 * Callers show the notice only on `false` (unknown is not known).
 */
import { useCallback, useEffect, useState } from "react";
import { settingsService } from "../services/settingsService";
import logger from "../utils/logger";

interface DismissalState {
  /** The user this answer belongs to. */
  forUserId: string | null;
  /** Brokerage name dismissed (null = none; undefined = read failed / pending). */
  dismissedFor: string | null | undefined;
}

export interface MembershipNoticeDismissal {
  dismissed: boolean | undefined;
  dismiss: () => void;
}

export function useMembershipNoticeDismissal(
  userId: string | undefined,
  brokerageName: string | undefined,
): MembershipNoticeDismissal {
  const [state, setState] = useState<DismissalState>({ forUserId: null, dismissedFor: undefined });
  const shouldRead = Boolean(userId && brokerageName);

  useEffect(() => {
    if (!userId || !shouldRead) return;
    let cancelled = false;
    void settingsService.getMembershipNoticeDismissedFor(userId).then((value) => {
      if (!cancelled) setState({ forUserId: userId, dismissedFor: value });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, shouldRead]);

  const dismiss = useCallback(() => {
    if (!userId || !brokerageName) return;
    setState({ forUserId: userId, dismissedFor: brokerageName });
    void settingsService.setMembershipNoticeDismissedFor(userId, brokerageName).then((result) => {
      if (!result.success) {
        logger.warn("[MembershipNotice] Failed to save the dismissal", { error: result.error });
      }
    });
  }, [userId, brokerageName]);

  let dismissed: boolean | undefined;
  if (!userId || !brokerageName || state.forUserId !== userId || state.dismissedFor === undefined) {
    dismissed = undefined;
  } else {
    dismissed = state.dismissedFor === brokerageName;
  }

  return { dismissed, dismiss };
}
