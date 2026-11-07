/**
 * BACKLOG-3951 PR-B2 — per-user dismissal of the removed-member notice.
 *
 * Renderer state fed by a per-user preferences read through settingsService
 * (the same read path the BACKLOG-2890 hold state uses), so a dismissal
 * survives restarts for that user and never leaks to another user.
 *
 * BACKLOG-4171: keyed by user + organization id. Preferences are per user, and
 * `notices.membershipNoticeDismissedFor` holds the dismissed brokerage's id, so
 * two brokerages with the same name (or none) keep separate dismissals and a
 * renamed brokerage keeps its dismissal. A value saved before 4171 holds a
 * name, never equals an id, and so shows the notice once more; the next
 * dismiss overwrites it with the id.
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
  /** Brokerage id dismissed (null = none; undefined = read failed / pending). */
  dismissedFor: string | null | undefined;
}

export interface MembershipNoticeDismissal {
  dismissed: boolean | undefined;
  dismiss: () => void;
}

export function useMembershipNoticeDismissal(
  userId: string | undefined,
  organizationId: string | undefined,
): MembershipNoticeDismissal {
  const [state, setState] = useState<DismissalState>({ forUserId: null, dismissedFor: undefined });
  const shouldRead = Boolean(userId && organizationId);

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
    if (!userId || !organizationId) return;
    setState({ forUserId: userId, dismissedFor: organizationId });
    void settingsService.setMembershipNoticeDismissedFor(userId, organizationId).then((result) => {
      if (!result.success) {
        logger.warn("[MembershipNotice] Failed to save the dismissal", { error: result.error });
      }
    });
  }, [userId, organizationId]);

  let dismissed: boolean | undefined;
  if (!userId || !organizationId || state.forUserId !== userId || state.dismissedFor === undefined) {
    dismissed = undefined;
  } else {
    dismissed = state.dismissedFor === organizationId;
  }

  return { dismissed, dismiss };
}
