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
    // Exact label contract: price, ordinal, and the word "paid" (never bare "deals").
    expect(btn).toHaveTextContent("Unlock this deal to export — $13.00 (your 3rd paid deal this year)");
  });

  it("grant path: creditBalance > 0 ⇒ 'Unlock with 1 credit (you have N)'", async () => {
    getStatusMock.mockResolvedValue(lockedWithQuote(2));
    render(
      <ExportUnlockPrompt transactionId={TX} onUnlocked={jest.fn()} onCancel={jest.fn()} />,
      { wrapper: strictWrapper },
    );
    const btn = await screen.findByTestId("unlock-with-credit");
    expect(btn).toHaveTextContent("Unlock with 1 credit (you have 2)");
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
    expect(btn).toHaveTextContent("Unlock requires an internet connection");
    expect(screen.queryByTestId("unlock-purchase")).toBeNull();
    expect(screen.queryByTestId("unlock-with-credit")).toBeNull();
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
