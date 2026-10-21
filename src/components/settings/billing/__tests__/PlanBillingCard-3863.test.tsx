/**
 * BACKLOG-3863 slice 3 — Settings › Plan & Billing card, one test per state
 * (plan 2c minus D3, SR R4.5 / R4.6).
 *
 * Real hooks: usePlanSummary (window.api.billing) and useFeatureGate
 * (window.api.featureGate.getAll) both run for real, so `isAllowed` keeps its
 * real fail-open behaviour for `unlimited_transactions`. Only useLicense is
 * mocked (it needs LicenseProvider).
 *
 * Fixtures:
 *   - plan summary DTO: slice 2's usePlanSummary-3863 fixture, itself
 *     transcribed from slice 1's planSummaryRoute.test.ts "returns the
 *     caller's plan" (state values from electron/types/billing.ts).
 *   - features: the renderer shape featureGateService.ts:396-401 builds from
 *     get_org_features ({ enabled, value, source } -> { allowed, value, source }),
 *     row values from entitlementService.unlimited-3675.test.ts:130.
 *   - quote: PurchaseUnlockHandoff.test.tsx QUOTE (unitPriceCents 1499, USD).
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanBillingCard } from "../PlanBillingCard";

const mockLicense = { isLicenseResolved: true };
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: () => mockLicense,
}));

const ACTIVE = {
  state: "active" as const,
  interval: "month",
  current_period_end: "2026-11-10T18:47:55+00:00",
  cancel_at_period_end: false,
  paymentIncomplete: false,
  supportGrantEffective: false,
};
const ENDING = { ...ACTIVE, state: "cancel_pending" as const, cancel_at_period_end: true };
const FAILED = { ...ACTIVE, state: "payment_failed" as const, paymentIncomplete: true };
const GRANT = { ...ACTIVE, state: "support_grant" as const, interval: null, current_period_end: null, supportGrantEffective: true };
const NONE = { ...ACTIVE, state: "none" as const, interval: null, current_period_end: null };

const UNLIMITED_ON = { unlimited_transactions: { allowed: true, value: "false", source: "override" as const } };
const UNLIMITED_OFF = { unlimited_transactions: { allowed: false, value: "false", source: "plan" as const } };

const QUOTE = { nextUnitIndex: 3, unitPriceCents: 1499, currency: "USD", pricingTierId: "tier-1" };

const api = () => window.api as unknown as {
  billing: Record<"openPortal" | "getPlanSummary" | "refresh", jest.Mock>;
  featureGate: Record<"getAll", jest.Mock>;
  entitlement: Record<"getQuote", jest.Mock>;
};

const RENEWAL = /Nov 1[01], 2026|Renews|until/;

function setSummary(summary: typeof ACTIVE | null): void {
  api().billing.getPlanSummary.mockResolvedValue(
    summary ? { unavailable: false, summary } : { unavailable: true },
  );
}

async function renderCard(organizationId: string | null = null) {
  const view = render(<PlanBillingCard organizationId={organizationId} userId="user-1" />);
  await act(async () => {}); // let the mount reads settle
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLicense.isLicenseResolved = true;
  setSummary(ACTIVE);
  api().featureGate.getAll.mockResolvedValue(UNLIMITED_ON);
  api().entitlement.getQuote.mockResolvedValue(QUOTE);
  api().billing.openPortal.mockResolvedValue({ success: true });
});

describe("BACKLOG-3863 — PlanBillingCard states", () => {
  it("agent active: Agent, Active, renewal date, Manage billing", async () => {
    await renderCard();
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Unlimited exports\. Renews Nov 1[01], 2026\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
  });

  it("agent ending: Ending, until date, Manage billing", async () => {
    setSummary(ENDING);
    await renderCard();
    expect(await screen.findByText("Ending")).toBeInTheDocument();
    expect(screen.getByText(/Unlimited exports until Nov 1[01], 2026\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
  });

  it("payment failed: Payment failed, exports off, Manage billing", async () => {
    setSummary(FAILED);
    await renderCard();
    expect(await screen.findByText("Payment failed")).toBeInTheDocument();
    expect(screen.getByText("Unlimited exports are off until it's paid.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
  });

  it("support grant: Unlimited exports, no button", async () => {
    setSummary(GRANT);
    await renderCard();
    expect(await screen.findByText("Unlimited exports")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("pay as you go: price per export, See plans and billing", async () => {
    setSummary(NONE);
    api().featureGate.getAll.mockResolvedValue(UNLIMITED_OFF);
    await renderCard();
    expect(await screen.findByText("Pay as you go")).toBeInTheDocument();
    expect(await screen.findByText("$14.99 per export.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See plans and billing" })).toBeInTheDocument();
  });

  it("pay as you go without a quote: no price invented", async () => {
    setSummary(NONE);
    api().entitlement.getQuote.mockResolvedValue(null);
    await renderCard();
    expect(await screen.findByText("You pay per export.")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("brokerage: Team license managed by the brokerage, NO billing button even with an active summary", async () => {
    await renderCard("org-1");
    expect(screen.getByText("Team license")).toBeInTheDocument();
    expect(screen.getByText(/Managed by your brokerage\./)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("summary unavailable + gate unlimited: plan from the gate, NO renewal line, link still shown", async () => {
    setSummary(null);
    await renderCard();
    expect(await screen.findByText("Unlimited exports")).toBeInTheDocument();
    expect(screen.queryByText(RENEWAL)).toBeNull();
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.getByRole("button", { name: "See plans and billing" })).toBeInTheDocument();
  });

  it("summary unavailable + features empty: Pay as you go, never Unlimited (fail-open isAllowed would say Unlimited)", async () => {
    setSummary(null);
    api().featureGate.getAll.mockResolvedValue({});
    await renderCard();
    expect(await screen.findByText("Pay as you go")).toBeInTheDocument();
    expect(screen.queryByText(/Unlimited/)).toBeNull();
  });

  it("endpoint and gate disagree: the endpoint wins (state none, gate unlimited -> Pay as you go)", async () => {
    setSummary(NONE);
    api().featureGate.getAll.mockResolvedValue(UNLIMITED_ON);
    await renderCard();
    expect(await screen.findByText("Pay as you go")).toBeInTheDocument();
    expect(screen.queryByText("Unlimited exports")).toBeNull();
  });

  it("endpoint and gate disagree: the endpoint wins (state active, gate off -> Agent Active)", async () => {
    setSummary(ACTIVE);
    api().featureGate.getAll.mockResolvedValue(UNLIMITED_OFF);
    await renderCard();
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("Pay as you go")).toBeNull();
  });
});

describe("BACKLOG-3863 — PlanBillingCard loading", () => {
  it("license not resolved: skeleton only, no plan text, no button", async () => {
    mockLicense.isLicenseResolved = false;
    setSummary(NONE);
    await renderCard();
    expect(screen.getByTestId("plan-billing-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/Pay as you go|Agent|Unlimited|Team license/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("summary still loading: skeleton", async () => {
    api().billing.getPlanSummary.mockReturnValue(new Promise(() => {}));
    await renderCard();
    expect(screen.getByTestId("plan-billing-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("summary unavailable and features not loaded yet: skeleton, not Pay as you go", async () => {
    setSummary(null);
    api().featureGate.getAll.mockReturnValue(new Promise(() => {}));
    await renderCard();
    expect(screen.getByTestId("plan-billing-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Pay as you go")).toBeNull();
  });
});

describe("BACKLOG-3863 — PlanBillingCard actions", () => {
  it("Manage billing calls billing:open-portal once, with no argument", async () => {
    await renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Manage billing" }));
    await waitFor(() => expect(api().billing.openPortal).toHaveBeenCalledTimes(1));
    expect(api().billing.openPortal).toHaveBeenCalledWith();
  });

  it("See plans and billing calls billing:open-portal too", async () => {
    setSummary(NONE);
    await renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "See plans and billing" }));
    await waitFor(() => expect(api().billing.openPortal).toHaveBeenCalledTimes(1));
  });

  it("after Manage billing, the next window focus refreshes the card (refresh armed)", async () => {
    api().billing.refresh.mockResolvedValue({ unavailable: false, summary: ENDING });
    await renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Manage billing" }));
    await waitFor(() => expect(api().billing.openPortal).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("Ending")).toBeInTheDocument();
    expect(api().billing.refresh).toHaveBeenCalledTimes(1);
  });

  it("browser did not open: warning with the allowed address", async () => {
    api().billing.openPortal.mockResolvedValue({ success: false, portalAddress: "https://app.example.test/dashboard/billing" });
    await renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Manage billing" }));
    expect(
      await screen.findByText("Couldn't open your browser. Go to https://app.example.test/dashboard/billing."),
    ).toBeInTheDocument();
  });
});
