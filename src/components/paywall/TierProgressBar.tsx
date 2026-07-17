/**
 * TierProgressBar — BACKLOG-2086.
 *
 * Makes the descending calendar-year PAYG price ladder VISIBLE inside the
 * unlock/paywall module. Founder intent: shift attention off the raw dollar
 * amount and toward the DISCOUNT — "your per-deal cost keeps dropping" — by
 * showing how close the user is to the next cheaper price band, and by
 * CELEBRATING the milestone once the best (top) band is reached.
 *
 * Shown ONLY on the PAID path (zero grant credits + a live quote, or the
 * saved-card confirm screen). A credit-holder spends a FREE credit and never
 * reaches the paid confirm screen, so a "paid deals get cheaper" bar is
 * off-moment for them — the caller gates rendering on the paid path.
 *
 * PURE PRESENTATION. It renders ONLY from the read-only tier-progress fields
 * already on the quote (surfaced by get_next_unlock_quote); it derives nothing
 * about money and triggers no charge. It NEVER shows the current unit price —
 * the exact dollar amount belongs at the confirm/charge control (guardrail:
 * abstract the browsing, never the moment of charge). A savings % and a deal
 * COUNT are fine — they are not the price.
 *
 * Degrades to null (renders nothing) when the ladder data is unavailable; on
 * the best (top) band it shows a congratulatory milestone (deals closed +
 * savings %), falling back to a quiet affirmation if the count / base price is
 * unavailable — never "$null" / "NaN%".
 */

import React from "react";
import type { UnlockQuote } from "../../services/entitlementService";

export interface TierProgressBarProps {
  /** Live quote carrying the read-only tier-progress fields. */
  quote: UnlockQuote | null;
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
  "data-testid": testId = "tier-progress-bar",
}: TierProgressBarProps): React.ReactElement | null {
  // Nothing to show without a live quote.
  if (quote === null) return null;

  const {
    currentBandMaxUnits,
    unitsUntilNextBand,
    nextBandUnitPriceCents,
    nextBandCurrency,
    baseUnitPriceCents,
    unitPriceCents,
    nextUnitIndex,
  } = quote;

  const has = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined;

  const hasNextBand =
    has(currentBandMaxUnits) &&
    has(unitsUntilNextBand) &&
    has(nextBandUnitPriceCents) &&
    unitsUntilNextBand > 0;

  if (!hasNextBand) {
    // ── Best-price / top-band state ──────────────────────────────────────────
    // Celebrate the volume milestone + savings %. Requires a paid-deal index we
    // can trust; otherwise render nothing.
    if (!has(nextUnitIndex)) return null;

    // N = PAID deals closed this calendar year. nextUnitIndex = paidCount + 1
    // (it prices the NEXT unit), so the completed count is nextUnitIndex − 1.
    const dealsClosed = nextUnitIndex - 1;

    // X% saved vs the band-1 (highest) starting price. Guardrail: this is the
    // discount, NOT the current price. Only computed when both the base and the
    // current price are present and the base is a strictly higher, positive
    // number (a real discount) — else we fall back to the quiet affirmation.
    const savingsPct =
      has(baseUnitPriceCents) &&
      has(unitPriceCents) &&
      baseUnitPriceCents > 0 &&
      baseUnitPriceCents > unitPriceCents
        ? Math.round(((baseUnitPriceCents - unitPriceCents) / baseUnitPriceCents) * 100)
        : null;

    const canCelebrate = dealsClosed > 0 && savingsPct !== null && savingsPct > 0;

    return (
      <div
        className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2"
        data-testid={testId}
        data-tier-state="best"
      >
        <p className="text-xs font-medium text-indigo-700">
          {canCelebrate
            ? `🎉 ${dealsClosed} deal${dealsClosed === 1 ? "" : "s"} closed this year — you've earned your best rate, saving ${savingsPct}% on every export.`
            : "You're at your best per-deal price."}
        </p>
      </div>
    );
  }

  // ── Progress-toward-next-band state (PAID path) ────────────────────────────
  // Progress within the current band. Deals ALREADY completed in this band =
  // (max - remaining); "remaining" includes the deal being priced now, so the
  // fill reflects position at the START of this deal.
  const bandSize = currentBandMaxUnits;
  const completedInBand = Math.max(0, currentBandMaxUnits - unitsUntilNextBand);
  const pct =
    bandSize > 0
      ? Math.min(100, Math.max(0, Math.round((completedInBand / bandSize) * 100)))
      : 0;

  // "N more unlocks and every deal drops to <next price>." unitsUntilNextBand
  // includes the current (PAID) deal, which advances the ladder, so AFTER this
  // unlock (unitsUntilNextBand − 1) more flip the price. The bar only ever
  // renders on the paid path now, so this is always the correct arithmetic.
  const moreAfterThis = Math.max(0, unitsUntilNextBand - 1);
  const nextPriceLabel = formatCents(
    nextBandUnitPriceCents,
    nextBandCurrency ?? quote.currency,
  );

  const incentive =
    moreAfterThis === 0
      ? `This is your last deal at this price — your next one drops to ${nextPriceLabel}.`
      : `${moreAfterThis} more unlock${moreAfterThis === 1 ? "" : "s"} and every deal drops to ${nextPriceLabel}.`;

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
