/**
 * Credit Balance Chip (BACKLOG-2090)
 *
 * Always-visible remaining grant-credit balance for the transaction header, so
 * users see how many unlock credits they have WITHOUT opening the export/unlock
 * prompt.
 *
 * Self-contained: reads the balance via useCreditBalance (which fails safe to
 * null offline/unavailable). Renders NOTHING when the balance is unavailable
 * (null) or still loading — an unavailable balance must never read as "0 credits".
 *
 * Placed inside the toolbar's colored gradient header, so its styling is tuned
 * for a translucent-on-gradient chip (matches the header's other white-on-color
 * controls), not the neutral white toolbar below.
 */
import React from "react";
import { useCreditBalance } from "../../../hooks/useCreditBalance";

/** Coin/credit icon. */
const CreditIcon = (): React.ReactElement => (
  <svg
    className="w-4 h-4"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-3a2 2 0 11-4 0 2 2 0 014 0z"
    />
  </svg>
);

/**
 * The persistent credit-balance chip. Returns null while loading or when the
 * balance is unavailable.
 */
export function CreditBalanceChip(): React.ReactElement | null {
  const { balance, loading } = useCreditBalance();

  if (loading || balance === null) return null;

  const label = balance === 1 ? "1 credit" : `${balance} credits`;

  return (
    <span
      data-testid="credit-balance-chip"
      className="inline-flex items-center gap-1.5 rounded-lg bg-white bg-opacity-20 px-3 py-1.5 text-sm font-semibold text-white"
      title="Your remaining unlock credits"
    >
      <CreditIcon />
      {label}
    </span>
  );
}

export default CreditBalanceChip;
