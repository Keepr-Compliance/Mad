/**
 * TierProgressBar — BACKLOG-2086.
 *
 * Makes the descending calendar-year PAYG price ladder VISIBLE inside the
 * unlock/paywall module. Founder intent: shift attention off the raw dollar
 * amount and toward the DISCOUNT — "your per-deal cost keeps dropping" — by
 * showing how close the user is to the next cheaper price band.
 *
 * Shown in BOTH unlock states (spend-a-credit AND pay-with-card/confirm): a
 * funded credit still advances the tier (counts_toward_tier=true), so the
 * incentive is identical.
 *
 * PURE PRESENTATION. It renders ONLY from the read-only tier-progress fields
 * already on the quote (surfaced by get_next_unlock_quote); it derives nothing
 * about money and triggers no charge. It NEVER shows the current unit price —
 * the exact dollar amount belongs at the confirm/charge control (guardrail:
 * abstract the browsing, never the moment of charge).
 *
 * Degrades to null (renders nothing) when the ladder data is unavailable or the
 * user is already on the best (top) band — no bar, no broken copy.
 */

import React from "react";
import type { UnlockQuote } from "../../services/entitlementService";

export interface TierProgressBarProps {
  /** Live quote carrying the read-only tier-progress fields. */
  quote: UnlockQuote | null;
  /**
   * Whether the unlock the user is about to perform will ACTUALLY advance the
   * tier ladder. A PAID unlock (counts_toward_tier=true) does; a GRANT/credit
   * unlock (counts_toward_tier=false) does NOT. This is load-bearing for the
   * "N more unlocks…" copy: on the paid path THIS deal consumes one ladder step
   * (so N = unitsUntilNextBand − 1), but on the grant path it consumes none
   * (so N = unitsUntilNextBand). Defaults to true (paid) for back-compat.
   */
  currentUnlockAdvancesTier?: boolean;
  /** Optional testid override (states render two instances). */
  "data-testid"?: string;
}

/** Format a cents price as "$X.XX" (USD unsuffixed; other currencies suffixed). */
function formatCents(cents: number, currency: string): string {
  const usd = currency.toUpperCase() === "USD";
  return `$${(cents / 100).toFixed(2)}${usd ? "" : ` ${currency.toUpperCase()}`}`;
}

export function TierProgressBar({
  quote,
  currentUnlockAdvancesTier = true,
  "data-testid": testId = "tier-progress-bar",
}: TierProgressBarProps): React.ReactElement | null {
  // Nothing to show without a live quote.
  if (quote === null) return null;

  const {
    currentBandMaxUnits,
    unitsUntilNextBand,
    nextBandUnitPriceCents,
    nextBandCurrency,
    nextUnitIndex,
  } = quote;

  // Top band / missing ladder data ⇒ already at the best price. Show a quiet
  // "best price" affirmation rather than a progress bar (or nothing if we lack
  // even the index). Never fabricate a next band.
  const has = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined;

  const hasNextBand =
    has(currentBandMaxUnits) &&
    has(unitsUntilNextBand) &&
    has(nextBandUnitPriceCents) &&
    unitsUntilNextBand > 0;

  if (!hasNextBand) {
    // Best-price state: only render if we at least know this is a paid deal.
    if (!has(nextUnitIndex)) return null;
    return (
      <div
        className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2"
        data-testid={testId}
        data-tier-state="best"
      >
        <p className="text-xs font-medium text-indigo-700">
          You&apos;re at your best per-deal price.
        </p>
      </div>
    );
  }

  // Progress within the current band. Deals ALREADY completed in this band =
  // (max - remaining); "remaining" includes the deal being priced now, so the
  // fill reflects position at the START of this deal.
  const bandSize = currentBandMaxUnits; // deals in this band (min..max is max-min+1, but max is the count boundary)
  const completedInBand = Math.max(0, (currentBandMaxUnits ?? 0) - (unitsUntilNextBand ?? 0));
  const pct =
    bandSize && bandSize > 0
      ? Math.min(100, Math.max(0, Math.round((completedInBand / bandSize) * 100)))
      : 0;

  // How many PAID unlocks still stand between the user and the cheaper band.
  // unitsUntilNextBand counts the current deal as one of the remaining steps.
  //   - Paid path: THIS deal advances the ladder ⇒ after it, (unitsUntilNextBand
  //     − 1) more paid unlocks flip the price.
  //   - Grant path: a credit unlock does NOT advance the ladder
  //     (counts_toward_tier=false) ⇒ spending it changes nothing, so it still
  //     takes unitsUntilNextBand paid unlocks. The old unconditional "− 1"
  //     overstated progress here (SR nit, PR #1957).
  const moreAfterThis = currentUnlockAdvancesTier
    ? Math.max(0, unitsUntilNextBand - 1)
    : unitsUntilNextBand;
  const nextPriceLabel = formatCents(
    nextBandUnitPriceCents,
    nextBandCurrency ?? quote.currency,
  );

  // Copy differs by path:
  //  - Paid & this is the final full-price deal ⇒ "last deal at this price".
  //  - Paid & more remain ⇒ "N more unlocks…".
  //  - Grant (credit doesn't advance the ladder) ⇒ "N more PAID unlocks…" so the
  //    user understands a credit unlock won't move them down a tier.
  let incentive: string;
  if (!currentUnlockAdvancesTier) {
    incentive = `${moreAfterThis} more paid unlock${moreAfterThis === 1 ? "" : "s"} and every deal drops to ${nextPriceLabel}.`;
  } else if (moreAfterThis === 0) {
    incentive = `This is your last deal at this price — your next one drops to ${nextPriceLabel}.`;
  } else {
    incentive = `${moreAfterThis} more unlock${moreAfterThis === 1 ? "" : "s"} and every deal drops to ${nextPriceLabel}.`;
  }

  return (
    <div
      className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5"
      data-testid={testId}
      data-tier-state="progress"
      data-units-until-next={unitsUntilNextBand}
    >
      <p className="text-xs font-medium text-indigo-700">{incentive}</p>
      {/* Descending-ladder progress track. Decorative; the copy carries the
          meaning for assistive tech. */}
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-indigo-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Progress toward your next cheaper price tier"
      >
        <div
          className="h-full rounded-full bg-indigo-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default TierProgressBar;
