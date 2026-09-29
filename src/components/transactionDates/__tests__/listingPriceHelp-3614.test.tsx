/**
 * BACKLOG-3614 — a listing price entered at create reaches the commission step:
 * the Sale Price (i) reads it from the transaction row.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { CommissionFields } from "../CommissionFields";
import { useCommissionForm } from "../useCommissionForm";

type Source = Parameters<typeof useCommissionForm>[0];

function Harness({ listingPrice }: { listingPrice: number | null }): React.ReactElement {
  const commission = useCommissionForm({
    listing_price: listingPrice ?? undefined,
  } as unknown as Source);
  return <CommissionFields commission={commission} route="export" />;
}

async function saleHelpText(): Promise<string> {
  const label = screen.getByText("Sale Price");
  const trigger = label.parentElement!.querySelector('[data-testid="info-tooltip-trigger"]')!;
  await userEvent.hover(trigger);
  return screen.getByRole("tooltip").textContent ?? "";
}

describe("commission Sale Price help text (BACKLOG-3614)", () => {
  it("names the listing price stored on the transaction", async () => {
    render(<Harness listingPrice={525000} />);
    expect(await saleHelpText()).toContain("Listing price $525,000");
  });

  it("says only 'From the transaction.' when none was entered", async () => {
    render(<Harness listingPrice={null} />);
    const text = await saleHelpText();
    expect(text).toContain("From the transaction.");
    expect(text).not.toMatch(/Listing price/);
  });
});
