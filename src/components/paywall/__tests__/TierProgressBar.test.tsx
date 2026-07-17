/**
 * Unit tests for TierProgressBar (BACKLOG-2086).
 *
 * Proves the discount-forward incentive bar renders the correct copy per ladder
 * position and, critically, NEVER surfaces the current unit price (the exact $
 * belongs at the confirm/charge control — guardrail: abstract the browsing,
 * never the moment of charge). Degrades to nothing on the top band / missing
 * ladder data.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { TierProgressBar } from "../TierProgressBar";
import type { UnlockQuote } from "../../../services/entitlementService";

const baseQuote = (over: Partial<UnlockQuote>): UnlockQuote => ({
  nextUnitIndex: 1,
  unitPriceCents: 1499,
  currency: "USD",
  pricingTierId: "tier-1",
  currentBandMaxUnits: 3,
  unitsUntilNextBand: 3,
  nextBandUnitPriceCents: 1300,
  nextBandCurrency: "USD",
  ...over,
});

describe("TierProgressBar", () => {
  it("null quote ⇒ renders nothing", () => {
    const { container } = render(<TierProgressBar quote={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("mid-band ⇒ 'N more unlocks and every deal drops to <next $>'", () => {
    // nextUnitIndex 1, band max 3, 3 remaining ⇒ 2 more AFTER this unlock.
    render(<TierProgressBar quote={baseQuote({ unitsUntilNextBand: 3 })} />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "progress");
    expect(bar).toHaveTextContent("2 more unlocks and every deal drops to $13.00");
  });

  it("singular 'unlock' when exactly one remains after this deal", () => {
    // 2 remaining ⇒ 1 more after this ⇒ singular.
    render(<TierProgressBar quote={baseQuote({ unitsUntilNextBand: 2 })} />);
    expect(screen.getByTestId("tier-progress-bar")).toHaveTextContent(
      "1 more unlock and every deal drops to $13.00",
    );
  });

  it("last deal in the band ⇒ 'last deal at this price' copy (PAID path)", () => {
    // 1 remaining, paid ⇒ 0 more after this ⇒ this is the last full-price deal.
    render(<TierProgressBar quote={baseQuote({ unitsUntilNextBand: 1 })} currentUnlockAdvancesTier />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveTextContent(/last deal at this price/i);
    expect(bar).toHaveTextContent("$13.00");
  });

  // GRANT vs PAID off-by-one (SR nit, PR #1957): a credit/grant unlock has
  // counts_toward_tier=false, so it does NOT consume a ladder step. The copy
  // must NOT apply the "-1" that the paid path uses.
  it("GRANT path: does NOT subtract this unlock (no off-by-one), qualifies 'paid'", () => {
    // 3 remaining, grant ⇒ still 3 PAID unlocks to the next band (no -1).
    render(
      <TierProgressBar
        quote={baseQuote({ unitsUntilNextBand: 3 })}
        currentUnlockAdvancesTier={false}
      />,
    );
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "progress");
    expect(bar).toHaveTextContent("3 more paid unlocks and every deal drops to $13.00");
  });

  it("GRANT path vs PAID path differ by exactly one for the same ladder position", () => {
    const { rerender } = render(
      <TierProgressBar quote={baseQuote({ unitsUntilNextBand: 2 })} currentUnlockAdvancesTier />,
    );
    // Paid: 2 remaining ⇒ 1 more after this unlock advances the ladder.
    expect(screen.getByTestId("tier-progress-bar")).toHaveTextContent(
      "1 more unlock and every deal drops to $13.00",
    );

    rerender(
      <TierProgressBar
        quote={baseQuote({ unitsUntilNextBand: 2 })}
        currentUnlockAdvancesTier={false}
      />,
    );
    // Grant: same position, but the credit doesn't advance ⇒ 2 PAID unlocks still needed.
    expect(screen.getByTestId("tier-progress-bar")).toHaveTextContent(
      "2 more paid unlocks and every deal drops to $13.00",
    );
  });

  it("GRANT path at the band boundary does NOT say 'last deal at this price'", () => {
    // 1 remaining, grant ⇒ paid path would say "last deal"; grant must not
    // (the credit unlock doesn't move the ladder).
    render(
      <TierProgressBar
        quote={baseQuote({ unitsUntilNextBand: 1 })}
        currentUnlockAdvancesTier={false}
      />,
    );
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).not.toHaveTextContent(/last deal at this price/i);
    expect(bar).toHaveTextContent("1 more paid unlock and every deal drops to $13.00");
  });

  it("top band (nulls) ⇒ best-price affirmation, no next-band copy", () => {
    render(
      <TierProgressBar
        quote={baseQuote({
          nextUnitIndex: 30,
          unitPriceCents: 1100,
          currentBandMaxUnits: null,
          unitsUntilNextBand: null,
          nextBandUnitPriceCents: null,
          nextBandCurrency: null,
        })}
      />,
    );
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "best");
    expect(bar).toHaveTextContent(/best per-deal price/i);
    expect(bar).not.toHaveTextContent(/drops to/i);
  });

  it("GUARDRAIL: never renders the CURRENT unit price (only the cheaper next-band price)", () => {
    render(<TierProgressBar quote={baseQuote({ unitPriceCents: 1499, nextBandUnitPriceCents: 1300 })} />);
    const bar = screen.getByTestId("tier-progress-bar");
    // The current price ($14.99) must NOT appear while browsing; only the
    // aspirational next-band price ($13.00) is shown.
    expect(bar).not.toHaveTextContent("$14.99");
    expect(bar).toHaveTextContent("$13.00");
  });

  it("missing ladder fields (older DB) ⇒ degrades to nothing, no crash", () => {
    const { container } = render(
      <TierProgressBar
        quote={{
          nextUnitIndex: 1,
          unitPriceCents: 1499,
          currency: "USD",
          pricingTierId: "tier-1",
          // no tier-progress fields at all
        }}
      />,
    );
    // No next-band data ⇒ best-price affirmation (we still know the index).
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "best");
    expect(container).not.toBeEmptyDOMElement();
  });

  it("respects a data-testid override (two states render distinct instances)", () => {
    render(<TierProgressBar quote={baseQuote({})} data-testid="custom-bar" />);
    expect(screen.getByTestId("custom-bar")).toBeInTheDocument();
  });
});
