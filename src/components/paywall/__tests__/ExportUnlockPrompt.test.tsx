/**
 * Unit tests for ExportUnlockPrompt (BACKLOG-2075).
 *
 * Proves the export-unlock prompt renders the correct CTA per entitlement state
 * and drives the grant/purchase/offline paths — StrictMode-safe (the underlying
 * useTransactionEntitlement hook uses value comparison, no didMount guard).
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ExportUnlockPrompt } from "../ExportUnlockPrompt";
import type { EntitlementStatus } from "../../../services/entitlementService";

const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const unlockMock = window.api.entitlement.unlockWithCredit as jest.Mock;

const TX = "tx-1";

const lockedWithQuote = (creditBalance: number | null): EntitlementStatus => ({
  localTransactionId: TX,
  status: "locked",
  lockReason: "no_unlock",
  fromCache: false,
  // nextUnitIndex 3 in the $13.00 band (units 4-10): 6 unlocks left before the
  // $12.00 band ⇒ TierProgressBar has a live "N more unlocks" incentive.
  quote: {
    nextUnitIndex: 3,
    unitPriceCents: 1300,
    currency: "USD",
    pricingTierId: "tier-1",
    currentBandMaxUnits: 10,
    unitsUntilNextBand: 8,
    nextBandUnitPriceCents: 1200,
    nextBandCurrency: "USD",
  },
  creditBalance,
});

/** Top-band quote (best price): next_* null ⇒ celebration state (deals + %). */
const lockedTopBand = (creditBalance: number | null): EntitlementStatus => ({
  localTransactionId: TX,
  status: "locked",
  lockReason: "no_unlock",
  fromCache: false,
  quote: {
    nextUnitIndex: 30, // 29 paid deals closed
    unitPriceCents: 1100, // $11.00
    currency: "USD",
    pricingTierId: "tier-4",
    currentBandMaxUnits: null,
    unitsUntilNextBand: null,
    nextBandUnitPriceCents: null,
    nextBandCurrency: null,
    baseUnitPriceCents: 1499, // $14.99 ⇒ 27% saved
  },
  creditBalance,
});

const lockedOffline = (): EntitlementStatus => ({
  localTransactionId: TX,
  status: "locked",
  lockReason: "offline_uncached",
  fromCache: false,
  quote: null,
  creditBalance: null,
});

const strictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ExportUnlockPrompt — CTA per state", () => {
  it("PAYG path: zero balance + quote ⇒ CREDIT-FIRST CTA (no dollar amount while browsing)", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-purchase");
    // BACKLOG-2086: lead with the CREDIT requirement, not the raw price.
    expect(btn).toHaveTextContent("Unlock this deal — 1 credit");
    // GUARDRAIL (browsing side): the dollar amount is NOT on the browsing CTA —
    // it surfaces only at the confirm/charge step (PurchaseUnlockHandoff).
    expect(btn).not.toHaveTextContent("$");
    // Credit-first sub-copy tells the user what they need.
    expect(screen.getByText(/You need 1 credit to unlock/i)).toBeInTheDocument();
  });

  it("PAYG path: renders the tier-progress incentive bar (discount-forward)", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    // nextUnitIndex 3, band max 10, 8 remaining ⇒ 7 more AFTER this unlock, next $12.00.
    const bar = await screen.findByTestId("unlock-tier-progress");
    expect(bar).toHaveAttribute("data-tier-state", "progress");
    expect(bar).toHaveTextContent("7 more unlocks and every deal drops to $12.00");
  });

  it("top band (best price, paid): tier bar CELEBRATES with deals closed + savings %", async () => {
    getStatusMock.mockResolvedValue(lockedTopBand(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const bar = await screen.findByTestId("unlock-tier-progress");
    expect(bar).toHaveAttribute("data-tier-state", "best");
    expect(bar).toHaveTextContent("29 deals closed this year");
    expect(bar).toHaveTextContent("saving 27% on every export");
    expect(bar).not.toHaveTextContent(/drops to/i);
    // GUARDRAIL: the current unit price is never shown, even at the best band.
    expect(bar).not.toHaveTextContent("$11.00");
  });

  it("grant path: creditBalance > 0 ⇒ 'Unlock with 1 credit'", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(2));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-with-credit");
    expect(btn).toHaveTextContent("Unlock with 1 credit");
    // The credit balance is surfaced in the footnote, not the button.
    expect(screen.getByText(/You have 2 credits · Reading is always free/)).toBeInTheDocument();
    // The PAYG purchase button is NOT shown when credits are available.
    expect(screen.queryByTestId("unlock-purchase")).toBeNull();
  });

  // Tier bar is PAID-ONLY (BACKLOG-2086 refinement): a credit-holder spends a
  // free credit and never reaches the paid confirm screen, so the "paid deals
  // get cheaper" bar is off-moment and must NOT render in the has-credits state.
  it("grant path: renders NO tier-progress bar (paid-only)", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(2));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    // The grant CTA is present, but there is NO tier bar.
    await screen.findByTestId("unlock-with-credit");
    expect(screen.queryByTestId("unlock-tier-progress")).toBeNull();
    // The credit-holder just sees the "You have N credits" footnote.
    expect(screen.getByText(/You have 2 credits · Reading is always free/)).toBeInTheDocument();
  });

  it("zero-credit / paid path: DOES render the tier-progress bar", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const bar = await screen.findByTestId("unlock-tier-progress");
    expect(bar).toHaveAttribute("data-tier-state", "progress");
    // 8 remaining, paid ⇒ 7 more after this unlock.
    expect(bar).toHaveTextContent("7 more unlocks and every deal drops to $12.00");
  });

  it("offline / no quote ⇒ disabled 'online required' (fail-closed, never a free export)", async () => {
    getStatusMock.mockResolvedValue(lockedOffline());
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-offline");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Unlocking requires an internet connection");
    expect(screen.queryByTestId("unlock-purchase")).toBeNull();
    expect(screen.queryByTestId("unlock-with-credit")).toBeNull();
  });

  it("deliverable-forward framing: shows the audit headline + deal label, no error text", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt
        transactionId={TX}
        transactionLabel="123 Main St"
        onUnlocked={jest.fn()}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );
    expect(await screen.findByText("Your full audit is ready to export")).toBeInTheDocument();
    expect(screen.getByText(/123 Main St/)).toBeInTheDocument();
    // Not an error: no "PAYWALL_LOCKED", no "failed", no "error" copy.
    expect(screen.queryByText(/PAYWALL_LOCKED|failed|error/i)).toBeNull();
  });

  it("falls back to 'this deal' when no label is provided", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    expect(await screen.findByText(/this deal/)).toBeInTheDocument();
  });
});

describe("ExportUnlockPrompt — unlock actions", () => {
  it("grant unlock ⇒ calls unlockWithCredit then fires onUnlocked", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(1));
    unlockMock.mockResolvedValue({ success: true, status: "unlocked" });
    const onUnlocked = jest.fn();
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={onUnlocked} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-with-credit");
    await act(async () => {
      btn.click();
    });
    await waitFor(() => expect(unlockMock).toHaveBeenCalledWith(TX));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
  });

  it("zero-balance ⇒ clicking the CTA renders PurchaseUnlockHandoff with the quote", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-purchase");
    await act(async () => {
      btn.click();
    });
    const handoff = await screen.findByTestId("purchase-unlock-handoff");
    // The 2015 seam receives the transaction id; the quote drives its price label.
    expect(handoff).toHaveAttribute("data-transaction-id", TX);
    expect(handoff).toHaveTextContent("$13.00");
  });

  it("cancel ⇒ fires onCancel (export aborted, no unlock attempted)", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    const onCancel = jest.fn();
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={onCancel} />,
      { wrapper: strictWrapper },
    );
    const cancel = await screen.findByTestId("unlock-cancel");
    await act(async () => {
      cancel.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(unlockMock).not.toHaveBeenCalled();
  });
});
