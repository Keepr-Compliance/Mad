/**
 * Unit tests for PurchaseUnlockHandoff (BACKLOG-2015).
 *
 * Proves the desktop PAYG card-purchase flow drives Checkout (Flow A), one-click
 * saved-card charge (Flow B), SCA fallback, decline, offline, cancel, and the
 * fail-closed confirm — StrictMode-safe (value-comparison effects, no didMount
 * guard). All portal/Stripe work is mocked via window.api.payment.* — no live
 * round-trip (Stage-2 live test is deferred to BACKLOG-2017).
 *
 * Assertions are exact: exact transaction ids passed to the bridge, onUnlocked
 * called exactly once ONLY on a confirmed unlock, never on a portal-200-alone.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PurchaseUnlockHandoff } from "../PurchaseUnlockHandoff";
import type { UnlockQuote } from "../../../services/entitlementService";

const beginCheckoutMock = window.api.payment.beginCheckout as jest.Mock;
const chargeMock = window.api.payment.chargeSavedCard as jest.Mock;
const confirmMock = window.api.payment.confirm as jest.Mock;
const hasSavedCardMock = window.api.payment.hasSavedCard as jest.Mock;
const onDeepLinkMock = window.api.onPaymentDeepLinkCallback as jest.Mock;

const TX = "tx-2015";
const QUOTE: UnlockQuote = {
  nextUnitIndex: 3,
  unitPriceCents: 1499,
  currency: "USD",
  pricingTierId: "tier-1",
  // Band 1 (units 1-3, $14.99): next unit is index 3, 1 unlock left before the
  // $13.00 band ⇒ TierProgressBar shows a live "last deal at this price" state.
  currentBandMaxUnits: 3,
  unitsUntilNextBand: 1,
  nextBandUnitPriceCents: 1300,
  nextBandCurrency: "USD",
  baseUnitPriceCents: 1499,
};

const strictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

/**
 * Capture the deep-link callback the component registers so a test can fire the
 * browser-return event. Returns a getter for the latest registered handler.
 */
function captureDeepLinkHandler(): () => ((d: { sessionId: string | null }) => void) | undefined {
  let handler: ((d: { sessionId: string | null }) => void) | undefined;
  onDeepLinkMock.mockImplementation(
    (cb: (d: { sessionId: string | null }) => void) => {
      handler = cb;
      return jest.fn();
    },
  );
  return () => handler;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Safe defaults: no saved card, nothing starts/unlocks.
  hasSavedCardMock.mockResolvedValue({ hasSavedCard: false });
  beginCheckoutMock.mockResolvedValue({ started: false, error: "error" });
  chargeMock.mockResolvedValue({ outcome: "error" });
  confirmMock.mockResolvedValue({ unlocked: false, reason: "timeout" });
  onDeepLinkMock.mockImplementation(() => jest.fn());
});

describe("PurchaseUnlockHandoff — Flow A (first purchase, no saved card)", () => {
  it("primary CTA opens Checkout with the EXACT transaction id", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: false });
    beginCheckoutMock.mockResolvedValue({ started: true });
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    expect(beginCheckoutMock).toHaveBeenCalledWith(TX);
    expect(await screen.findByTestId("purchase-awaiting-browser")).toBeInTheDocument();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("deep-link return → confirm resolves unlocked → onUnlocked exactly once", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: false });
    beginCheckoutMock.mockResolvedValue({ started: true });
    confirmMock.mockResolvedValue({ unlocked: true });
    const getHandler = captureDeepLinkHandler();
    const onUnlocked = jest.fn();
    const onCancel = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={onCancel}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await screen.findByTestId("purchase-awaiting-browser");

    // Simulate the browser returning via keepr://payment-callback?session=cs_1.
    await act(async () => {
      getHandler()?.({ sessionId: "cs_1" });
    });

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledWith(TX, "cs_1");
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("PurchaseUnlockHandoff — Flow B (saved card, one-click)", () => {
  it("shows consent copy + exact price, charges the EXACT tx, confirms → onUnlocked", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({ outcome: "succeeded" });
    confirmMock.mockResolvedValue({ unlocked: true });
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    // Consent/mandate copy (founder hard requirement) + exact price.
    const consent = await screen.findByTestId("saved-card-consent");
    expect(consent).toHaveTextContent("$14.99");
    expect(consent).toHaveTextContent(/never charge automatically/i);

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    expect(chargeMock).toHaveBeenCalledWith(TX);
    expect(beginCheckoutMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    // Flow B confirms via the authoritative gate re-read (no session id).
    expect(confirmMock).toHaveBeenCalledWith(TX, null);
  });

  it("SCA with a hosted URL → awaiting-browser (main opened it); no unlock yet", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({
      outcome: "requires_action",
      redirectUrl: "https://hooks.stripe.com/3ds",
    });
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    expect(await screen.findByTestId("purchase-awaiting-browser")).toBeInTheDocument();
    expect(beginCheckoutMock).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  // AMENDMENT #2 (SR) — the 15th test: requires_action + NULL redirect → Checkout fallback.
  it("SCA with NULL redirect_url → auto-fallback to Flow A Checkout (no dead-end)", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({ outcome: "requires_action", redirectUrl: null });
    beginCheckoutMock.mockResolvedValue({ started: true });
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    // Falls back to full Checkout (which handles 3DS itself).
    await waitFor(() => expect(beginCheckoutMock).toHaveBeenCalledWith(TX));
    expect(await screen.findByTestId("purchase-awaiting-browser")).toBeInTheDocument();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("409 no_saved_card → falls back to Flow A Checkout", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({ outcome: "no_saved_card" });
    beginCheckoutMock.mockResolvedValue({ started: true });

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={jest.fn()}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    await waitFor(() => expect(beginCheckoutMock).toHaveBeenCalledWith(TX));
  });

  it("hard decline (402) → 'Try another card' routes to Flow A Checkout (NEW card), never re-charges the declined saved card", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({ outcome: "declined", code: "card_declined" });
    beginCheckoutMock.mockResolvedValue({ started: true });
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    // Declined: clear message + the primary CTA becomes "Try another card".
    expect(await screen.findByTestId("purchase-error")).toHaveTextContent(/declined/i);
    const retryBtn = await screen.findByTestId("purchase-confirm");
    expect(retryBtn).toHaveTextContent(/try another card/i);
    expect(chargeMock).toHaveBeenCalledTimes(1);

    // Clicking "Try another card" must open Checkout (new card) — NOT re-charge
    // the same declined saved card via chargeSavedCard.
    await waitFor(() => expect(retryBtn).toBeEnabled());
    await userEvent.click(retryBtn);

    await waitFor(() => expect(beginCheckoutMock).toHaveBeenCalledWith(TX));
    expect(chargeMock).toHaveBeenCalledTimes(1); // NOT re-charged (still 1)
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("invalid/detached saved card (BACKLOG-2088) → clear 'add a new card' message + Checkout, NEVER a false 'Payment received' or a re-charge", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({ outcome: "invalid_payment_method", code: "resource_missing" });
    beginCheckoutMock.mockResolvedValue({ started: true });
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    // Accurate, actionable message — NOT the misleading "Payment received".
    const errorEl = await screen.findByTestId("purchase-error");
    expect(errorEl).toHaveTextContent(/add a new card/i);
    expect(screen.queryByText(/payment received/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("purchase-confirming")).not.toBeInTheDocument();

    // The CTA becomes "Try another card" and routes to Checkout (add a NEW card) —
    // it must NOT re-charge the dead saved card.
    const retryBtn = await screen.findByTestId("purchase-confirm");
    expect(retryBtn).toHaveTextContent(/try another card/i);
    await waitFor(() => expect(retryBtn).toBeEnabled());
    await userEvent.click(retryBtn);

    await waitFor(() => expect(beginCheckoutMock).toHaveBeenCalledWith(TX));
    expect(chargeMock).toHaveBeenCalledTimes(1); // dead card NOT re-charged
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});

describe("PurchaseUnlockHandoff — fail-closed / edge states", () => {
  it("offline / no quote → disabled 'requires internet', no portal call", async () => {
    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={null}
        onUnlocked={jest.fn()}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    expect(screen.getByText(/requires an internet connection/i)).toBeInTheDocument();
    expect(screen.queryByTestId("purchase-confirm")).toBeNull();
    expect(beginCheckoutMock).not.toHaveBeenCalled();
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it("cancel → onCancel once, no unlock", async () => {
    const onCancel = jest.fn();
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={onCancel}
      />,
      { wrapper: strictWrapper },
    );

    await userEvent.click(await screen.findByTestId("purchase-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  // BACKLOG-2087: the confirm screen MUST offer an explicit escape (Back).
  it("BACKLOG-2087: explicit Back control returns to the prompt (onCancel), no unlock", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    const onCancel = jest.fn();
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={onCancel}
      />,
      { wrapper: strictWrapper },
    );

    const back = await screen.findByTestId("purchase-back");
    expect(back).toBeEnabled();
    await userEvent.click(back);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(chargeMock).not.toHaveBeenCalled();
  });

  // GUARDRAIL (BACKLOG-2086): the FINAL confirm/charge control still shows the
  // exact dollar amount before the tap — never abstracted at the charge moment.
  it("GUARDRAIL: saved-card confirm button shows the EXACT dollar amount", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={jest.fn()}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const confirm = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(confirm).toBeEnabled());
    // Exact price on the irreversible control (honesty / no hidden-price dark pattern).
    expect(confirm).toHaveTextContent("Confirm — $14.99");
  });

  it("renders the tier-progress incentive bar in the confirm state (discount-forward)", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={jest.fn()}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const bar = await screen.findByTestId("purchase-tier-progress");
    // 1 unlock remaining in the band ⇒ 0 more after this ⇒ "last deal" copy, next $13.00.
    expect(bar).toHaveTextContent(/last deal at this price/i);
    expect(bar).toHaveTextContent("$13.00");
  });

  it("fail-closed: confirm never returns unlocked → error state, onUnlocked NOT called", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: false });
    beginCheckoutMock.mockResolvedValue({ started: true });
    confirmMock.mockResolvedValue({ unlocked: false, reason: "timeout" });
    const getHandler = captureDeepLinkHandler();
    const onUnlocked = jest.fn();

    render(
      <PurchaseUnlockHandoff
        localTransactionId={TX}
        quote={QUOTE}
        onUnlocked={onUnlocked}
        onCancel={jest.fn()}
      />,
      { wrapper: strictWrapper },
    );

    const btn = await screen.findByTestId("purchase-confirm");
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);
    await screen.findByTestId("purchase-awaiting-browser");

    await act(async () => {
      getHandler()?.({ sessionId: "cs_x" });
    });

    expect(await screen.findByTestId("purchase-error")).toBeInTheDocument();
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
