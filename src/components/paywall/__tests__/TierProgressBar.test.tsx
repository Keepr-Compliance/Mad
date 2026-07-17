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
  baseUnitPriceCents: 1499,
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

  it("last deal in the band ⇒ 'last deal at this price' copy", () => {
    // 1 remaining ⇒ 0 more after this paid unlock ⇒ this is the last full-price deal.
    render(<TierProgressBar quote={baseQuote({ unitsUntilNextBand: 1 })} />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveTextContent(/last deal at this price/i);
    expect(bar).toHaveTextContent("$13.00");
  });

  // ── Best-price / top-band CELEBRATION (BACKLOG-2086 refinement) ────────────
  const topBand = (over: Partial<UnlockQuote> = {}): UnlockQuote =>
    baseQuote({
      nextUnitIndex: 30, // 29 paid deals closed
      unitPriceCents: 1100, // $11.00
      baseUnitPriceCents: 1499, // $14.99 ⇒ round((1499-1100)/1499*100) = 27%
      currentBandMaxUnits: null,
      unitsUntilNextBand: null,
      nextBandUnitPriceCents: null,
      nextBandCurrency: null,
      ...over,
    });

  it("top band ⇒ celebratory milestone: deals closed + savings %", () => {
    render(<TierProgressBar quote={topBand()} />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "best");
    // 🎉 29 deals closed this year — you've earned your best rate, saving 27% on every export.
    expect(bar).toHaveTextContent("29 deals closed this year");
    expect(bar).toHaveTextContent("saving 27% on every export");
    expect(bar).toHaveTextContent("🎉");
    expect(bar).not.toHaveTextContent(/drops to/i);
    // GUARDRAIL: the current unit price ($11.00) is NEVER shown — only the % saved.
    expect(bar).not.toHaveTextContent("$11.00");
    expect(bar).not.toHaveTextContent("$14.99");
  });

  it("top band singular: exactly one deal closed ⇒ 'deal' not 'deals'", () => {
    // nextUnitIndex 2 ⇒ 1 paid deal already closed.
    render(<TierProgressBar quote={topBand({ nextUnitIndex: 2 })} />);
    expect(screen.getByTestId("tier-progress-bar")).toHaveTextContent(
      "1 deal closed this year",
    );
  });

  it("top band null-safe: missing base price ⇒ quiet affirmation, no NaN%", () => {
    render(<TierProgressBar quote={topBand({ baseUnitPriceCents: null })} />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "best");
    expect(bar).toHaveTextContent(/best per-deal price/i);
    expect(bar).not.toHaveTextContent(/NaN|%|🎉/);
  });

  it("top band null-safe: zero deals closed (nextUnitIndex 1) ⇒ quiet affirmation", () => {
    render(<TierProgressBar quote={topBand({ nextUnitIndex: 1 })} />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveAttribute("data-tier-state", "best");
    expect(bar).toHaveTextContent(/best per-deal price/i);
    expect(bar).not.toHaveTextContent(/🎉/);
  });

  it("top band null-safe: base not higher than current (no real discount) ⇒ quiet affirmation", () => {
    render(<TierProgressBar quote={topBand({ baseUnitPriceCents: 1100 })} />);
    const bar = screen.getByTestId("tier-progress-bar");
    expect(bar).toHaveTextContent(/best per-deal price/i);
    expect(bar).not.toHaveTextContent(/saving|🎉|%/);
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
