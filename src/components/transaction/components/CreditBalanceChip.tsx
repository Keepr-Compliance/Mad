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
import React, { useEffect } from "react";
import { useCreditBalance } from "../../../hooks/useCreditBalance";

export interface CreditBalanceChipProps {
  /**
   * BACKLOG-2090: a monotonically-changing signal that forces a balance refetch
   * (e.g. bumped by the list after an unlock/export spends a credit, so the chip
   * reflects the post-spend balance without a remount). Optional — omit for a
   * self-managing chip.
   */
  refreshSignal?: number;
}

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
export function CreditBalanceChip({
  refreshSignal,
}: CreditBalanceChipProps = {}): React.ReactElement | null {
  const { balance, loading, refresh } = useCreditBalance();

  // Refetch when the parent bumps the signal (post-unlock/export). Skips the
  // initial mount (the hook already fetches once) via value comparison — no
  // didMount guard (StrictMode-safe).
  const lastSignalRef = React.useRef<number | undefined>(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined) return;
    if (lastSignalRef.current === refreshSignal) return;
    lastSignalRef.current = refreshSignal;
    refresh();
  }, [refreshSignal, refresh]);

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
