/**
 * BACKLOG-3676 — the export paywall's three plan cards and the Agent plan
 * Subscribe flow (renderer). Main is mocked through window.api (tests/setup.js
 * defaults are fail-closed); the shapes below are the PR-1 route answers:
 *   POST /api/payments/subscription-session → { checkout_url } | { code }
 *   GET  /api/billing/agent-prices → { month: { display, unitAmount, currency } | null, bookCallUrl }
 * (main turns the latter into { unavailable:false, month, hasBookCall }).
 */

import React from "react";
import { render, screen, act, waitFor, within } from "@testing-library/react";
import { ExportUnlockPrompt, NO_LICENSE_MESSAGE, STATE_D_MESSAGE } from "../ExportUnlockPrompt";
import LicenseContext from "../../../contexts/LicenseContext";
import type { EntitlementStatus } from "../../../services/entitlementService";
import type { SubscriptionRefusalCode } from "../../../services/paymentService";

const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const beginSubscriptionMock = window.api.payment.beginSubscription as jest.Mock;
const confirmSubscriptionMock = window.api.payment.confirmSubscription as jest.Mock;
const refreshGateMock = window.api.payment.refreshGate as jest.Mock;
const beginCheckoutMock = window.api.payment.beginCheckout as jest.Mock;
const getAgentPricesMock = window.api.billing.getAgentPrices as jest.Mock;
const getPlanSummaryMock = window.api.billing.getPlanSummary as jest.Mock;
const openPortalMock = window.api.billing.openPortal as jest.Mock;
const openBookCallMock = window.api.billing.openBookCall as jest.Mock;
const onDeepLinkMock = window.api.onPaymentDeepLinkCallback as jest.Mock;

const TX = "tx-3676";

function locked(creditBalance: number | null, unitPriceCents = 1499): EntitlementStatus {
  return {
    localTransactionId: TX,
    status: "locked",
    lockReason: "no_unlock",
    fromCache: false,
    quote: { nextUnitIndex: 1, unitPriceCents, currency: "USD", pricingTierId: "t1" },
    creditBalance,
  } as EntitlementStatus;
}

function prices(display: string, unitAmount: number) {
  return { unavailable: false, month: { display, unitAmount, currency: "usd" }, hasBookCall: true };
}

type LicenseValue = NonNullable<React.ContextType<typeof LicenseContext>>;
function licenseValue(kind: "individual" | "brokerage" | "unknown"): LicenseValue {
  return {
    licenseType: kind === "brokerage" ? "team" : "individual",
    organizationId: kind === "brokerage" ? "org-1" : null,
    canSubmit: kind === "brokerage",
    canExport: kind !== "brokerage",
    isLicenseResolved: kind !== "unknown",
  } as unknown as LicenseValue;
}

function renderPrompt(
  kind: "individual" | "brokerage" | "unknown" | "none" = "individual",
  props: Partial<React.ComponentProps<typeof ExportUnlockPrompt>> = {},
) {
  const onUnlocked = jest.fn();
  const onCancel = jest.fn();
  const ui = (
    <ExportUnlockPrompt transactionId={TX} onUnlocked={onUnlocked} onCancel={onCancel} {...props} />
  );
  render(
    kind === "none" ? (
      ui
    ) : (
      <LicenseContext.Provider value={licenseValue(kind)}>{ui}</LicenseContext.Provider>
    ),
  );
  return { onUnlocked, onCancel };
}

let deepLink: ((d: { sessionId: string | null }) => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  deepLink = null;
  onDeepLinkMock.mockImplementation((cb: (d: { sessionId: string | null }) => void) => {
    deepLink = cb;
    return jest.fn();
  });
  getAgentPricesMock.mockResolvedValue(prices("$19.99", 1999));
  getPlanSummaryMock.mockResolvedValue({ unavailable: true });
});

async function subscribeButton(): Promise<HTMLElement> {
  return screen.findByTestId("agent-subscribe");
}

describe("C-HILITE — the highlighted card follows the credit balance (boundary swept)", () => {
  it.each([
    [null, "agent"],
    [0, "agent"],
    [1, "solo"],
    [2, "solo"],
    [19, "solo"],
  ] as const)("creditBalance %p → %s highlighted", async (balance, expected) => {
    getStatusMock.mockResolvedValue(locked(balance));
    renderPrompt();
    await subscribeButton();
    const solo = screen.getByTestId("plan-card-solo");
    const agent = screen.getByTestId("plan-card-agent");
    if (expected === "solo") {
      await within(solo).findByTestId("unlock-with-credit");
      expect(solo).toHaveAttribute("data-highlighted", "true");
      expect(agent).toHaveAttribute("data-highlighted", "false");
      expect(within(solo).getByTestId("unlock-with-credit")).toHaveTextContent("Unlock with 1 credit");
      expect(screen.queryByTestId("unlock-purchase")).toBeNull();
    } else {
      await within(solo).findByTestId("unlock-purchase");
      expect(solo).toHaveAttribute("data-highlighted", "false");
      expect(agent).toHaveAttribute("data-highlighted", "true");
      expect(within(solo).getByTestId("unlock-purchase")).toHaveTextContent("Pay $14.99 for this deal");
      expect(screen.queryByTestId("unlock-with-credit")).toBeNull();
    }
  });
});

describe("C-PRICE-SERVER — both prices come from the server, never the app", () => {
  it.each([
    [1299, "$24.99", 2499, "$12.99"],
    [1499, "$19.99", 1999, "$14.99"],
  ])("quote %i, agent %s → shows exactly those", async (quoteCents, agentDisplay, agentCents, soloLabel) => {
    getStatusMock.mockResolvedValue(locked(0, quoteCents));
    getAgentPricesMock.mockResolvedValue(prices(agentDisplay, agentCents));
    renderPrompt();
    expect(await subscribeButton()).toHaveTextContent(`Subscribe — ${agentDisplay}/month`);
    expect(screen.getByTestId("agent-price")).toHaveTextContent(`${agentDisplay} / month`);
    expect(await screen.findByTestId("unlock-purchase")).toHaveTextContent(`Pay ${soloLabel} for this deal`);
  });

  it("the Agent price is the server's display string, not re-formatted in the app", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    getAgentPricesMock.mockResolvedValue(prices("US$21.50", 2150));
    renderPrompt();
    expect(await subscribeButton()).toHaveTextContent("Subscribe — US$21.50/month");
  });

  it("no price on sale → 'Not available right now', no Subscribe", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    getAgentPricesMock.mockResolvedValue({ unavailable: false, month: null, hasBookCall: true });
    renderPrompt();
    expect(await screen.findByTestId("agent-refusal-price_unavailable")).toHaveTextContent(
      "Not available right now.",
    );
    expect(screen.queryByTestId("agent-subscribe")).toBeNull();
  });
});

describe("C-SUBSCRIBE-PATH — Subscribe opens the Stripe Checkout through main, never the website", () => {
  it("calls beginSubscription once, never openPortal or the per-deal checkout, then waits", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: true });
    renderPrompt();
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    expect(beginSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(beginSubscriptionMock).toHaveBeenCalledWith();
    expect(openPortalMock).not.toHaveBeenCalled();
    expect(beginCheckoutMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId("agent-flow-waiting")).toHaveTextContent(
      "Agent plan, $19.99 / month",
    );
  });

  it("Subscribe is disabled while the license class is unknown (no provider or unresolved)", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    renderPrompt("unknown");
    expect(await subscribeButton()).toBeDisabled();
  });

  it("Subscribe is disabled with no license context at all", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    renderPrompt("none");
    expect(await subscribeButton()).toBeDisabled();
  });
});

describe("C-STATE-D — licensed by a brokerage: no billing buttons (founder 2026-10-09)", () => {
  it("brokerage class → state D, no Subscribe, no Pay, no Book a call", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    renderPrompt("brokerage");
    expect(await screen.findByTestId("paywall-state-d")).toHaveTextContent(STATE_D_MESSAGE);
    await waitFor(() => expect(getAgentPricesMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("agent-subscribe")).toBeNull();
    expect(screen.queryByTestId("unlock-purchase")).toBeNull();
    expect(screen.queryByTestId("book-call")).toBeNull();
    expect(screen.queryByText(/Subscribe|Pay \$|Book a call/)).toBeNull();
  });

  it("server backstop: a brokerage_managed refusal shows the same state D", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: false, code: "brokerage_managed" });
    renderPrompt("individual");
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    expect(await screen.findByTestId("paywall-state-d")).toHaveTextContent(STATE_D_MESSAGE);
    expect(screen.queryByTestId("unlock-purchase")).toBeNull();
    expect(screen.queryByTestId("book-call")).toBeNull();
  });
});

describe("C-CODES — every refusal code has its own message, none says Refresh", () => {
  const cases: [SubscriptionRefusalCode, string][] = [
    ["not_available", "Not available for this account."],
    ["no_license", NO_LICENSE_MESSAGE],
    ["suspended", "Your account is suspended. Contact support."],
    ["mode_refused", "Subscriptions are not available for this account."],
    ["price_unavailable", "Not available right now."],
    ["try_again", "Something went wrong. Try again."],
    ["unauthorized", "Please sign in again to subscribe."],
    ["already_have_plan", "You already have Unlimited."],
  ];

  it.each(cases)("%s → its own message", async (code, text) => {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: false, code });
    renderPrompt();
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    const msg = await screen.findByTestId(`agent-refusal-${code}`);
    expect(msg).toHaveTextContent(text);
    expect(document.body.textContent).not.toMatch(/refresh/i);
    if (code !== "unauthorized") expect(screen.queryByTestId("agent-subscribe")).toBeNull();
  });

  it("no_license (C7) shows the decided sentence and no Subscribe", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: false, code: "no_license" });
    renderPrompt();
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    expect(
      await screen.findByText("Your brokerage hasn't assigned you a license. Contact your admin."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("agent-subscribe")).toBeNull();
  });

  it("already_have_plan → one fresh gate read; unlocked → Continue export", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: false, code: "already_have_plan" });
    refreshGateMock.mockResolvedValue({ unlocked: true });
    const { onUnlocked } = renderPrompt();
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    expect(await screen.findByTestId("agent-plan-on")).toBeInTheDocument();
    expect(refreshGateMock).toHaveBeenCalledTimes(1);
    expect(refreshGateMock).toHaveBeenCalledWith(TX);
    await act(async () => {
      screen.getByTestId("agent-plan-on-continue").click();
    });
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("try_again → 'Try again' is a fresh gate read; still locked → Subscribe is back", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: false, code: "try_again" });
    refreshGateMock.mockResolvedValue({ unlocked: false });
    renderPrompt();
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      (await screen.findByTestId("agent-try-again")).click();
    });
    expect(refreshGateMock).toHaveBeenCalledWith(TX);
    expect(await subscribeButton()).toBeInTheDocument();
  });
});

describe("plan state from the plan summary", () => {
  it("payment_failed → banner, card-change buttons open Billing, no Subscribe", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    getPlanSummaryMock.mockResolvedValue({
      unavailable: false,
      summary: {
        state: "payment_failed",
        interval: "month",
        current_period_end: null,
        cancel_at_period_end: false,
        paymentIncomplete: true,
        supportGrantEffective: false,
      },
    });
    renderPrompt();
    expect(await screen.findByTestId("agent-payment-failed-banner")).toHaveTextContent(
      "Your Agent plan payment failed.",
    );
    expect(screen.queryByTestId("agent-subscribe")).toBeNull();
    await act(async () => {
      screen.getByTestId("agent-update-card").click();
    });
    expect(openPortalMock).toHaveBeenCalledTimes(1);
    expect(beginSubscriptionMock).not.toHaveBeenCalled();
  });

  it("active plan still locked → 'Checking your plan…' + Try again, no Subscribe", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    getPlanSummaryMock.mockResolvedValue({
      unavailable: false,
      summary: {
        state: "active",
        interval: "month",
        current_period_end: null,
        cancel_at_period_end: false,
        paymentIncomplete: false,
        supportGrantEffective: false,
      },
    });
    renderPrompt();
    expect(await screen.findByTestId("agent-plan-checking")).toHaveTextContent("Checking your plan…");
    expect(screen.queryByTestId("agent-subscribe")).toBeNull();
  });
});

describe("Book a call", () => {
  it("asks main to open the booking page and sends no URL", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    renderPrompt();
    const btn = await screen.findByTestId("book-call");
    await act(async () => {
      btn.click();
    });
    expect(openBookCallMock).toHaveBeenCalledTimes(1);
    expect(openBookCallMock).toHaveBeenCalledWith();
  });
});

describe("after Subscribe — browser return", () => {
  async function startWaiting() {
    getStatusMock.mockResolvedValue(locked(0));
    beginSubscriptionMock.mockResolvedValue({ started: true });
    const handlers = renderPrompt();
    const btn = await subscribeButton();
    await waitFor(() => expect(btn).not.toBeDisabled());
    await act(async () => {
      btn.click();
    });
    await screen.findByTestId("agent-flow-waiting");
    expect(deepLink).not.toBeNull();
    return handlers;
  }

  it("deep link with a session → confirmSubscription; gate unlocked → success → Continue export", async () => {
    confirmSubscriptionMock.mockResolvedValue({ unlocked: true });
    const { onUnlocked } = await startWaiting();
    await act(async () => {
      deepLink?.({ sessionId: "cs_test_1" });
    });
    expect(await screen.findByTestId("agent-flow-success")).toHaveTextContent("You're on the Agent plan");
    expect(confirmSubscriptionMock).toHaveBeenCalledWith(TX);
    await act(async () => {
      screen.getByTestId("agent-flow-continue").click();
    });
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it("C-FAILCLOSED: gate still locked after the poll → Pending, never success", async () => {
    confirmSubscriptionMock.mockResolvedValue({ unlocked: false, reason: "timeout" });
    const { onUnlocked } = await startWaiting();
    await act(async () => {
      deepLink?.({ sessionId: "cs_test_1" });
    });
    expect(await screen.findByTestId("agent-flow-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-flow-success")).toBeNull();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("C-PAYFAILED: locked after the poll and the plan says payment_failed → payment-failed screen", async () => {
    confirmSubscriptionMock.mockResolvedValue({ unlocked: false, reason: "timeout" });
    await startWaiting();
    getPlanSummaryMock.mockResolvedValue({
      unavailable: false,
      summary: {
        state: "payment_failed",
        interval: "month",
        current_period_end: null,
        cancel_at_period_end: false,
        paymentIncomplete: true,
        supportGrantEffective: false,
      },
    });
    await act(async () => {
      deepLink?.({ sessionId: "cs_test_1" });
    });
    expect(await screen.findByTestId("agent-flow-failed")).toHaveTextContent(
      "The payment didn't go through",
    );
  });

  it("deep link with NO session (cancelled page) → one fresh read, back to the cards", async () => {
    refreshGateMock.mockResolvedValue({ unlocked: false });
    await startWaiting();
    await act(async () => {
      deepLink?.({ sessionId: null });
    });
    expect(await screen.findByTestId("agent-checkout-cancelled")).toHaveTextContent(
      "Checkout cancelled. Nothing was charged.",
    );
    expect(refreshGateMock).toHaveBeenCalledTimes(1);
    expect(confirmSubscriptionMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("plan-cards")).toBeInTheDocument();
  });

  it("S2 renderer guard: two deep links while confirming → ONE confirmSubscription", async () => {
    let release: ((v: { unlocked: boolean }) => void) | undefined;
    confirmSubscriptionMock.mockReturnValue(
      new Promise((r) => {
        release = r;
      }),
    );
    await startWaiting();
    await act(async () => {
      deepLink?.({ sessionId: "cs_test_1" });
      deepLink?.({ sessionId: "cs_test_1" });
    });
    await act(async () => {
      release?.({ unlocked: true });
    });
    expect(await screen.findByTestId("agent-flow-success")).toBeInTheDocument();
    expect(confirmSubscriptionMock).toHaveBeenCalledTimes(1);
  });

  it("Cancel on the waiting screen returns to the cards", async () => {
    await startWaiting();
    await act(async () => {
      screen.getByTestId("agent-flow-cancel").click();
    });
    expect(await screen.findByTestId("plan-cards")).toBeInTheDocument();
  });
});

describe("'Not now' on the cards", () => {
  it("fires onCancel and starts nothing", async () => {
    getStatusMock.mockResolvedValue(locked(0));
    const { onCancel } = renderPrompt();
    await subscribeButton();
    await act(async () => {
      screen.getByTestId("unlock-cancel").click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(beginSubscriptionMock).not.toHaveBeenCalled();
  });
});
