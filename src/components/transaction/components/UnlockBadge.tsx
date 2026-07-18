/**
 * Unlock Badge (BACKLOG-2090)
 *
 * At-a-glance per-transaction unlock indicator for the transaction list/cards.
 * Answers the founder's question "which deal did I already spend a credit on?"
 * without opening the deal.
 *
 * - UNLOCKED → a clear emerald "Unlocked" badge with an open-padlock icon.
 * - LOCKED   → a subtle gray padlock icon only (no loud copy for the common,
 *              not-yet-unlocked case), with a tooltip explaining export needs a
 *              credit.
 *
 * Styling matches the neighbouring detection badges (DetectionBadges.tsx):
 * `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium`.
 *
 * Purely presentational — the caller resolves `isUnlocked` from the batch
 * unlocked-ids Set (useUnlockedTransactionIds). This component never touches
 * window.api (architecture boundary: no IPC in card components).
 */
import React from "react";

export interface UnlockBadgeProps {
  /** True when this transaction is confirmed-unlocked on this device. */
  isUnlocked: boolean;
}

/** Open padlock — shown on unlocked deals. */
const OpenLockIcon = (): React.ReactElement => (
  <svg
    className="w-3.5 h-3.5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M8 11V7a4 4 0 018 0m-9 4h10a2 2 0 012 2v5a2 2 0 01-2 2H7a2 2 0 01-2-2v-5a2 2 0 012-2z"
    />
  </svg>
);

/** Closed padlock — the subtle locked affordance. */
const ClosedLockIcon = (): React.ReactElement => (
  <svg
    className="w-3.5 h-3.5"
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
);

/**
 * Unlock status badge for a transaction row/card.
 */
export function UnlockBadge({ isUnlocked }: UnlockBadgeProps): React.ReactElement {
  if (isUnlocked) {
    return (
      <span
        data-testid="unlock-badge-unlocked"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800"
        title="Unlocked — you've spent a credit on this deal; export is available"
      >
        <OpenLockIcon />
        Unlocked
      </span>
    );
  }

  return (
    <span
      data-testid="unlock-badge-locked"
      className="inline-flex items-center text-gray-400"
      title="Locked — exporting this deal requires a credit"
      aria-label="Locked"
    >
      <ClosedLockIcon />
    </span>
  );
}

export default UnlockBadge;
