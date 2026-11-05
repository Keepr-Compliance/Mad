/**
 * BACKLOG-3951 C8 — the paywall for a brokerage member with no license.
 *
 * Standing "unlicensed" ⇒ the founder's sentence (EmptyState, testId
 * paywall-no-license) and "Not now" only: no credit, Pay, Subscribe or Book a
 * call, even with credits held. Any other standing, or none known, ⇒ the plan
 * cards exactly as before (unknown ≠ known). Main's refusals (credit
 * not_licensed, card not_licensed) show the same sentence when the panel was
 * not up (an answer that arrived after the prompt opened).
 */

import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportUnlockPrompt, NO_LICENSE_MESSAGE } from "../ExportUnlockPrompt";
import { PurchaseUnlockHandoff } from "../PurchaseUnlockHandoff";
import LicenseContext from "../../../contexts/LicenseContext";
import type { EntitlementStatus } from "../../../services/entitlementService";

const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const unlockMock = window.api.entitlement.unlockWithCredit as jest.Mock;
const getAgentPricesMock = window.api.billing.getAgentPrices as jest.Mock;
const getPlanSummaryMock = window.api.billing.getPlanSummary as jest.Mock;
const beginCheckoutMock = window.api.payment.beginCheckout as jest.Mock;
const chargeMock = window.api.payment.chargeSavedCard as jest.Mock;
const hasSavedCardMock = window.api.payment.hasSavedCard as jest.Mock;
const onDeepLinkMock = window.api.onPaymentDeepLinkCallback as jest.Mock;

const TX = "tx-3951";
const QUOTE = { nextUnitIndex: 1, unitPriceCents: 1499, currency: "USD", pricingTierId: "t1" };

function locked(creditBalance: number | null): EntitlementStatus {
  return {
    localTransactionId: TX,
    status: "locked",
    lockReason: "no_unlock",
    fromCache: false,
    quote: QUOTE,
    creditBalance,
  } as EntitlementStatus;
}

type LicenseValue = NonNullable<React.ContextType<typeof LicenseContext>>;
type Standing = LicenseValue["membershipStanding"];

function renderPrompt(standing: Standing, extra: Partial<LicenseValue> = {}) {
  const onUnlocked = jest.fn();
  const onCancel = jest.fn();
  const value = {
    licenseType: "individual",
    organizationId: null,
    canSubmit: false,
    canExport: true,
    isLicenseResolved: true,
    membershipStanding: standing,
    ...extra,
  } as unknown as LicenseValue;
  render(
    <LicenseContext.Provider value={value}>
      <ExportUnlockPrompt transactionId={TX} onUnlocked={onUnlocked} onCancel={onCancel} />
    </LicenseContext.Provider>,
  );
  return { onUnlocked, onCancel };
}

beforeEach(() => {
  jest.clearAllMocks();
  getAgentPricesMock.mockResolvedValue({
    unavailable: false,
    month: { display: "$19.99", unitAmount: 1999, currency: "usd" },
    hasBookCall: true,
  });
  getPlanSummaryMock.mockResolvedValue({ unavailable: true });
  hasSavedCardMock.mockResolvedValue({ hasSavedCard: false });
  onDeepLinkMock.mockImplementation(() => jest.fn());
});

describe("BACKLOG-3951 C8: unlicensed member", () => {
  it.each([[2], [0]])("credits %p ⇒ the founder's sentence and no unlock of any kind", async (credits) => {
    getStatusMock.mockResolvedValue(locked(credits));
    const { onCancel } = renderPrompt("unlicensed");
    const panel = await screen.findByTestId("paywall-no-license");
    expect(panel).toHaveTextContent(NO_LICENSE_MESSAGE);
    expect(NO_LICENSE_MESSAGE).toBe("Your brokerage hasn't assigned you a license. Contact your admin.");
    // Let the entitlement / prices reads land; nothing may appear afterwards.
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
    for (const id of [
      "unlock-with-credit",
      "unlock-purchase",
      "agent-subscribe",
      "plan-card-solo",
      "plan-card-agent",
      "paywall-state-d",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /book a call/i })).toBeNull();
    // The only control is "Not now".
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Not now"]);
    await userEvent.click(screen.getByTestId("unlock-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(unlockMock).not.toHaveBeenCalled();
  });

  it.each<[string, Standing]>([
    ["left_brokerage", "left_brokerage"],
    ["licensed", "licensed"],
    ["none", "none"],
    ["unknown status", "unknown"],
    ["not known (read failed / loading)", undefined],
  ])("%s ⇒ plan cards as before (credit button shown)", async (_n, standing) => {
    getStatusMock.mockResolvedValue(locked(1));
    renderPrompt(standing);
    expect(await screen.findByTestId("unlock-with-credit")).toBeInTheDocument();
    expect(screen.queryByTestId("paywall-no-license")).toBeNull();
  });

  it("brokerage-licensed member keeps State D (the new panel only follows 'unlicensed')", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    renderPrompt("licensed", { canSubmit: true, organizationId: "org-1", licenseType: "team" } as Partial<LicenseValue>);
    expect(await screen.findByTestId("paywall-state-d")).toBeInTheDocument();
    expect(screen.queryByTestId("paywall-no-license")).toBeNull();
  });

  it("main refuses the credit unlock with not_licensed ⇒ the same sentence", async () => {
    getStatusMock.mockResolvedValue(locked(1));
    unlockMock.mockResolvedValue({ success: false, status: "locked", error: "not_licensed" });
    const { onUnlocked } = renderPrompt(undefined);
    await userEvent.click(await screen.findByTestId("unlock-with-credit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(NO_LICENSE_MESSAGE);
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3951: card refusals in the purchase hand-off", () => {
  function renderHandoff() {
    const onUnlocked = jest.fn();
    render(
      <PurchaseUnlockHandoff localTransactionId={TX} quote={QUOTE} onUnlocked={onUnlocked} onCancel={jest.fn()} />,
    );
    return onUnlocked;
  }

  it("checkout refused not_licensed ⇒ the founder's sentence", async () => {
    beginCheckoutMock.mockResolvedValue({ started: false, error: "not_licensed" });
    const onUnlocked = renderHandoff();
    await userEvent.click(await screen.findByTestId("purchase-confirm"));
    expect(await screen.findByTestId("purchase-error")).toHaveTextContent(NO_LICENSE_MESSAGE);
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("saved-card charge refused not_licensed ⇒ the founder's sentence; no Checkout fallback", async () => {
    hasSavedCardMock.mockResolvedValue({ hasSavedCard: true });
    chargeMock.mockResolvedValue({ outcome: "not_licensed" });
    const onUnlocked = renderHandoff();
    await waitFor(() => expect(hasSavedCardMock).toHaveBeenCalled());
    await screen.findByTestId("saved-card-consent");
    await userEvent.click(screen.getByTestId("purchase-confirm"));
    expect(await screen.findByTestId("purchase-error")).toHaveTextContent(NO_LICENSE_MESSAGE);
    expect(beginCheckoutMock).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
