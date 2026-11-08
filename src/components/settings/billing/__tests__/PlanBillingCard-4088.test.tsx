/**
 * BACKLOG-4088 — Settings › Plan & Billing card during a free trial.
 *
 * Founder copy (pm_comments 73bc361e Q3/Q4):
 *   trial:              "Free trial", pill "Trial", "Unlimited exports until <date>.
 *                       Subscribe now and you won't be charged until then.", "Subscribe"
 *   subscribed in trial "Billing starts <date>."
 *
 * Real hooks (usePlanSummary, useFeatureGate) over the window.api mocks in
 * tests/setup.js; only useLicense is mocked, as in PlanBillingCard-3863.
 *
 * Fixtures: the 3863 ACTIVE summary plus the two BACKLOG-4088 fields, shaped as
 * the portal's toPlanSummary emits them (broker-portal planSummaryRoute.test.ts,
 * "BACKLOG-4088: trialEndsOn and subscriptionTrialEndsOn"): a live trial is state
 * support_grant + trialEndsOn; subscribed in trial is state active +
 * subscriptionTrialEndsOn. Times are midday UTC so the shown day does not move
 * with the machine's time zone.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanBillingCard } from "../PlanBillingCard";
import type { PlanSummary } from "@/services/billingService";

const mockLicense = { isLicenseResolved: true };
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: () => mockLicense,
}));

const BASE: PlanSummary = {
  state: "active",
  interval: "month",
  current_period_end: "2026-11-10T18:47:55+00:00",
  cancel_at_period_end: false,
  paymentIncomplete: false,
  supportGrantEffective: false,
  trialEndsOn: null,
  subscriptionTrialEndsOn: null,
};
const TRIAL: PlanSummary = {
  ...BASE,
  state: "support_grant",
  interval: null,
  current_period_end: null,
  supportGrantEffective: true,
  trialEndsOn: "2026-11-21T12:00:00+00:00",
};
const GRANT: PlanSummary = { ...TRIAL, trialEndsOn: null };
const SUBSCRIBED_IN_TRIAL: PlanSummary = {
  ...BASE,
  current_period_end: "2026-11-21T12:00:00+00:00",
  subscriptionTrialEndsOn: "2026-11-21T12:00:00+00:00",
};

const TRIAL_DETAIL = "Unlimited exports until Nov 21, 2026. Subscribe now and you won't be charged until then.";

const api = () => window.api as unknown as {
  billing: Record<"openPortal" | "getPlanSummary" | "refresh", jest.Mock>;
  featureGate: Record<"getAll", jest.Mock>;
  entitlement: Record<"getQuote" | "getBalance", jest.Mock>;
  payment: Record<"beginSubscription", jest.Mock>;
};

function setSummary(summary: PlanSummary): void {
  api().billing.getPlanSummary.mockResolvedValue({ unavailable: false, summary });
}

async function renderCard() {
  const view = render(<PlanBillingCard organizationId={null} userId="user-1" />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLicense.isLicenseResolved = true;
  api().featureGate.getAll.mockResolvedValue({ unlimited_transactions: { allowed: true, value: "false", source: "override" } });
  api().entitlement.getQuote.mockResolvedValue(null);
  api().entitlement.getBalance.mockResolvedValue(null);
  api().billing.openPortal.mockResolvedValue({ success: true });
  api().billing.refresh.mockResolvedValue({ unavailable: false, summary: SUBSCRIBED_IN_TRIAL });
  api().payment.beginSubscription.mockResolvedValue({ started: true });
});

describe("BACKLOG-4088 — free trial on the plan card", () => {
  it("live trial: Free trial, pill Trial, the founder's line with the trial end, a Subscribe button and no billing link", async () => {
    setSummary(TRIAL);
    await renderCard();
    expect(screen.getByText("Free trial")).toBeInTheDocument();
    expect(screen.getByText("Trial")).toBeInTheDocument();
    expect(screen.getByText(TRIAL_DETAIL)).toBeInTheDocument();
    expect(screen.getByTestId("plan-billing-subscribe")).toHaveTextContent("Subscribe");
    expect(screen.queryByRole("button", { name: /Manage billing|See plans and billing/ })).not.toBeInTheDocument();
  });

  it("Subscribe opens the Agent plan Checkout once and refreshes the plan when the window regains focus", async () => {
    setSummary(TRIAL);
    await renderCard();
    await userEvent.click(screen.getByTestId("plan-billing-subscribe"));
    expect(api().payment.beginSubscription).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("plan-billing-subscribe-refusal")).not.toBeInTheDocument();
    expect(api().billing.refresh).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(api().billing.refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Unlimited exports. Billing starts Nov 21, 2026.")).toBeInTheDocument();
  });

  it.each([
    ["already_have_plan", { started: false, code: "already_have_plan" }, "You already have Unlimited."],
    ["offline", { started: false, code: "offline" }, "Something went wrong. Try again."],
    ["brokerage_managed", { started: false, code: "brokerage_managed" }, "Not available for this account."],
  ])("Subscribe refused (%s) -> the paywall's message, no refresh armed", async (_label, result, text) => {
    setSummary(TRIAL);
    api().payment.beginSubscription.mockResolvedValue(result);
    await renderCard();
    await userEvent.click(screen.getByTestId("plan-billing-subscribe"));
    expect(await screen.findByTestId("plan-billing-subscribe-refusal")).toHaveTextContent(text);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(api().billing.refresh).not.toHaveBeenCalled();
  });

  it("a Keepr grant that is not a trial (no trialEndsOn): Unlimited exports, Active, no Subscribe", async () => {
    setSummary(GRANT);
    await renderCard();
    expect(screen.getByText("Unlimited exports")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-billing-subscribe")).not.toBeInTheDocument();
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument();
  });

  it("subscribed during the trial: Agent, Active, 'Billing starts <date>.' in place of Renews", async () => {
    setSummary(SUBSCRIBED_IN_TRIAL);
    await renderCard();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Unlimited exports. Billing starts Nov 21, 2026.")).toBeInTheDocument();
    expect(screen.queryByText(/Renews/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("plan-billing-subscribe")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
  });

  it("positive control: active, not in a trial -> Renews <date>, no Billing starts", async () => {
    setSummary(BASE);
    await renderCard();
    expect(screen.getByText(/Unlimited exports\. Renews Nov 1[01], 2026\./)).toBeInTheDocument();
    expect(screen.queryByText(/Billing starts/)).not.toBeInTheDocument();
  });
});
