/**
 * BACKLOG-3910 (slice b): the one notice shown on a locked deal.
 *
 * Reusable on purpose: one component for both reasons ("submitted" while the
 * broker reviews, "sealed" once approved; BACKLOG-2229 adds closed deals).
 * Renders nothing for an open deal or an unknown reason rather than inventing
 * text.
 */
import React from "react";
import { DEAL_LOCK_NOTICE_COPY, type DealLockReason } from "../../../utils/dealLock";

interface DealLockNoticeProps {
  reason: DealLockReason | null;
}

export function DealLockNotice({ reason }: DealLockNoticeProps): React.ReactElement | null {
  if (!reason || !Object.prototype.hasOwnProperty.call(DEAL_LOCK_NOTICE_COPY, reason)) {
    return null;
  }
  return (
    <div
      className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6"
      role="status"
      data-testid="deal-lock-notice"
      data-reason={reason}
    >
      <div className="flex items-start gap-3">
        <svg
          className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
        <p className="text-sm text-gray-700">{DEAL_LOCK_NOTICE_COPY[reason]}</p>
      </div>
    </div>
  );
}
