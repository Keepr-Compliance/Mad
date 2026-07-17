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
  quote: { nextUnitIndex: 3, unitPriceCents: 1300, currency: "USD", pricingTierId: "tier-1" },
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
  it("PAYG path: zero balance + quote ⇒ 'Unlock this deal to export — $X.XX (your Nth paid deal this year)'", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(0));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-purchase");
    // Option B (deliverable-forward): price-first primary CTA, no "error" framing.
    expect(btn).toHaveTextContent("Unlock this deal — $13.00");
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
