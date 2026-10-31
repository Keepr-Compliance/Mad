/**
 * ExportUnlockPrompt — BACKLOG-2075 (gate export only), rebuilt as the three
 * plan cards by BACKLOG-3676 (tab A2, founder approval 2026-10-09; buying in the
 * app happens at this paywall only, through Stripe's hosted page, 2026-10-10).
 *
 * Shown when an export of a LOCKED transaction returns PAYWALL_LOCKED.
 *
 *   Solo      "Unlock with 1 credit" (credits held) or "Pay $X for this deal"
 *             (no credits; X from the live quote) → the existing
 *             PurchaseUnlockHandoff (saved card / Checkout, exact amount shown).
 *   Agent     "Subscribe — $X/month" (X from the portal on every open, never a
 *             constant) → main opens the Agent plan Stripe Checkout →
 *             AgentSubscribeFlow waits for the browser return.
 *   Brokerage "Book a call" → main opens the portal's booking URL.
 *
 * The highlighted card follows credits: credits held → Solo, none → Agent.
 *
 * State D (founder 2026-10-09): a user licensed by a brokerage sees "Your team
 * license covers this account. Contact your broker admin." and NO billing
 * buttons — no Subscribe, no per-deal Pay, no Book a call. The class is read
 * from the license context (the same test useCompleteTransaction uses); while
 * it is unknown, Subscribe is disabled. The portal's brokerage_managed refusal
 * is the server-side backstop and leads to the same screen.
 *
 * Every refusal code the portal answers maps to its own short message on the
 * Agent card (none says "Refresh the page"). "Try again" is always ONE fresh
 * gate read in main (memo cleared first), never a cached answer.
 *
 * On a confirmed unlock (credit, purchase or plan) `onUnlocked` fires and the
 * caller re-runs the export. Makes NO gate decision itself.
 */

import React, { useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@keepr/ui";
import { useTransactionEntitlement } from "../../hooks/useTransactionEntitlement";
import LicenseContext from "../../contexts/LicenseContext";
import { paymentService, type SubscriptionRefusalCode } from "../../services/paymentService";
import {
  billingService,
  type AgentPricesResult,
  type PlanSummaryResult,
} from "../../services/billingService";
import { PurchaseUnlockHandoff } from "./PurchaseUnlockHandoff";
import { PlanCards, type AgentAction, type SoloAction } from "./PlanCards";
import { AgentSubscribeFlow } from "./AgentSubscribeFlow";
import logger from "../../utils/logger";

export interface ExportUnlockPromptProps {
  /** The locked transaction the user tried to export. */
  transactionId: string;
  /** Human label for the deal (e.g. property address). Falls back to "this deal". */
  transactionLabel?: string | null;
  /** Called after a confirmed unlock (grant, purchase or plan). Caller re-runs the export. */
  onUnlocked: () => void;
  /** Called when the user dismisses the prompt without unlocking. */
  onCancel: () => void;
}

/** C7 wording, decided 2026-10-10 (BACKLOG-3648). */
export const NO_LICENSE_MESSAGE = "Your brokerage hasn't assigned you a license. Contact your admin.";
/** State D wording, decided 2026-10-09 (BACKLOG-3648). */
export const STATE_D_MESSAGE = "Your team license covers this account. Contact your broker admin.";

/** Agent-card message per refusal code (R6). None tells the user to refresh a page. */
export const REFUSAL_MESSAGES: Record<Exclude<SubscriptionRefusalCode, "brokerage_managed">, string> = {
  unauthorized: "Please sign in again to subscribe.",
  not_available: "Not available for this account.",
  no_license: NO_LICENSE_MESSAGE,
  suspended: "Your account is suspended. Contact support.",
  mode_refused: "Subscriptions are not available for this account.",
  already_have_plan: "You already have Unlimited.",
  price_unavailable: "Not available right now.",
  try_again: "Something went wrong. Try again.",
};

type LicenseClass = "brokerage" | "individual" | "unknown";

function formatCents(cents: number, currency: string): string {
  const usd = currency.toUpperCase() === "USD";
  return `$${(cents / 100).toFixed(2)}${usd ? "" : ` ${currency.toUpperCase()}`}`;
}

export function ExportUnlockPrompt({
  transactionId,
  transactionLabel,
  onUnlocked,
  onCancel,
}: ExportUnlockPromptProps): React.ReactElement {
  const { quote, creditBalance, unlockWithCredit, isLoading, lockReason, refresh } =
    useTransactionEntitlement(transactionId);
  const license = useContext(LicenseContext);

  const [showPurchase, setShowPurchase] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // BACKLOG-3676 state.
  const [prices, setPrices] = useState<AgentPricesResult | null>(null);
  const [planSummary, setPlanSummary] = useState<PlanSummaryResult | null>(null);
  const [refusal, setRefusal] = useState<SubscriptionRefusalCode | null>(null);
  const [starting, setStarting] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [flow, setFlow] = useState<"plans" | "subscribe" | "plan_on">("plans");
  const [cancelledNotice, setCancelledNotice] = useState(false);

  // Price and plan summary: read once per prompt mount (S1/S6: no cache).
  useEffect(() => {
    let cancelled = false;
    void billingService.getAgentPrices().then((r) => {
      if (!cancelled) setPrices(r);
    });
    void billingService.getPlanSummary().then((r) => {
      if (!cancelled) setPlanSummary(r);
    });
    return () => {
      cancelled = true;
    };
  }, [transactionId]);

  const licenseClass: LicenseClass =
    !license || !license.isLicenseResolved
      ? "unknown"
      : license.canSubmit && !!license.organizationId
        ? "brokerage"
        : "individual";

  const hasGrantCredits = (creditBalance ?? 0) > 0;
  const creditCount = creditBalance ?? 0;
  const canPurchase = quote !== null;
  const isOffline =
    lockReason === "offline_uncached" ||
    (typeof navigator !== "undefined" && navigator.onLine === false);

  const handleRetry = async (): Promise<void> => {
    setRetrying(true);
    setUnlockError(null);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  };

  const handleUseCredit = async (): Promise<void> => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      const result = await unlockWithCredit();
      if (result.success && result.status === "unlocked") {
        onUnlocked();
        return;
      }
      setUnlockError(
        result.error === "offline"
          ? "Unlocking requires an internet connection."
          : "Could not unlock with a credit. Please try again.",
      );
    } catch (err) {
      logger.error("Credit unlock failed:", err);
      setUnlockError("Could not unlock with a credit. Please try again.");
    } finally {
      setUnlocking(false);
    }
  };

  /** One fresh gate read in main (R1/R6). Unlocked → the plan-on screen. */
  const readGateFresh = useCallback(async (): Promise<boolean> => {
    setGateBusy(true);
    try {
      const { unlocked } = await paymentService.refreshGate(transactionId);
      if (unlocked) setFlow("plan_on");
      return unlocked;
    } finally {
      setGateBusy(false);
    }
  }, [transactionId]);

  /** Open the Agent plan Checkout. True when main opened it. */
  const startCheckout = useCallback(async (): Promise<boolean> => {
    setStarting(true);
    setCancelledNotice(false);
    try {
      const result = await paymentService.beginSubscription();
      if (result.started) {
        setRefusal(null);
        return true;
      }
      if (result.code === "offline") {
        setRefusal("try_again");
        return false;
      }
      setRefusal(result.code);
      if (result.code === "already_have_plan") void readGateFresh();
      return false;
    } finally {
      setStarting(false);
    }
  }, [readGateFresh]);

  const handleSubscribe = async (): Promise<void> => {
    if (await startCheckout()) setFlow("subscribe");
  };

  const handleTryAgain = async (): Promise<void> => {
    const unlocked = await readGateFresh();
    if (!unlocked && refusal === "try_again") setRefusal(null);
  };

  const backToPlans = useCallback((notice?: "cancelled") => {
    setFlow("plans");
    setCancelledNotice(notice === "cancelled");
    // The plan state may have changed while the browser was open.
    void billingService.getPlanSummary().then(setPlanSummary);
  }, []);

  // ── Purchase hand-off (Solo "Pay $X") ───────────────────────────────────
  if (showPurchase) {
    return (
      <div className="p-4" data-testid="export-unlock-prompt">
        <PurchaseUnlockHandoff
          localTransactionId={transactionId}
          quote={quote}
          onUnlocked={onUnlocked}
          onCancel={() => setShowPurchase(false)}
        />
      </div>
    );
  }

  const monthPrice = prices && !prices.unavailable ? prices.month : null;
  const priceDisplay = monthPrice?.display ?? null;

  // ── After Subscribe ─────────────────────────────────────────────────────
  if (flow === "subscribe") {
    return (
      <div data-testid="export-unlock-prompt">
        <AgentSubscribeFlow
          transactionId={transactionId}
          priceDisplay={priceDisplay}
          creditCount={creditCount}
          onContinue={onUnlocked}
          onBack={backToPlans}
          onKeepWorking={onCancel}
          onReopen={startCheckout}
        />
      </div>
    );
  }

  if (flow === "plan_on") {
    return (
      <div data-testid="export-unlock-prompt">
        <div
          className="mx-auto max-w-xl rounded-lg border border-primary/30 bg-primary/5 p-5 text-center"
          data-testid="agent-plan-on"
        >
          <p className="text-sm font-semibold text-gray-900">Unlimited exports are on</p>
          <Button className="mt-4" size="lg" onClick={onUnlocked} data-testid="agent-plan-on-continue">
            Continue export
          </Button>
        </div>
      </div>
    );
  }

  const dealLabel =
    transactionLabel && transactionLabel.trim() !== "" ? transactionLabel.trim() : "this deal";

  // ── State D: licensed by a brokerage — no billing buttons at all ────────
  if (licenseClass === "brokerage" || refusal === "brokerage_managed") {
    return (
      <div data-testid="export-unlock-prompt">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-5" data-testid="paywall-state-d">
          <p className="text-sm font-semibold text-gray-900">Team license</p>
          <p className="mt-1 text-sm text-gray-600">{STATE_D_MESSAGE}</p>
          {hasGrantCredits && (
            <div className="mt-4">
              <Button
                size="lg"
                className="w-full"
                onClick={() => void handleUseCredit()}
                disabled={unlocking}
                data-testid="unlock-with-credit"
              >
                {unlocking ? "Unlocking…" : "Unlock with 1 credit"}
              </Button>
            </div>
          )}
          {unlockError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {unlockError}
            </p>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            data-testid="unlock-cancel"
            className="text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  // ── Solo card action ────────────────────────────────────────────────────
  const solo: SoloAction = isLoading
    ? { kind: "loading" }
    : hasGrantCredits
      ? { kind: "credit", unlocking, onUseCredit: () => void handleUseCredit() }
      : canPurchase && quote
        ? {
            kind: "pay",
            priceLabel: formatCents(quote.unitPriceCents, quote.currency),
            onPay: () => setShowPurchase(true),
          }
        : { kind: "unavailable", isOffline, retrying, onRetry: () => void handleRetry() };

  // ── Agent card action ───────────────────────────────────────────────────
  const planState = planSummary && !planSummary.unavailable ? planSummary.summary.state : null;
  const paymentFailed = planState === "payment_failed";
  const tryAgainAction = {
    label: gateBusy ? "Checking…" : "Try again",
    testId: "agent-try-again",
    busy: gateBusy,
    onClick: () => void handleTryAgain(),
  };

  let agent: AgentAction;
  if (paymentFailed) {
    agent = {
      kind: "message",
      testId: "agent-payment-failed",
      text: "Update your card on the website to turn Unlimited exports back on.",
      action: {
        label: "Update card ↗",
        testId: "agent-update-card",
        onClick: () => void billingService.openPortal(),
      },
    };
  } else if (
    refusal === "already_have_plan" ||
    planState === "active" ||
    planState === "cancel_pending" ||
    planState === "support_grant"
  ) {
    agent = {
      kind: "message",
      testId:
        refusal === "already_have_plan" ? "agent-refusal-already_have_plan" : "agent-plan-checking",
      text:
        refusal === "already_have_plan"
          ? `${REFUSAL_MESSAGES.already_have_plan} Checking your plan…`
          : "Checking your plan…",
      action: tryAgainAction,
    };
  } else if (refusal === "try_again") {
    agent = {
      kind: "message",
      testId: "agent-refusal-try_again",
      text: REFUSAL_MESSAGES.try_again,
      tone: "error",
      action: tryAgainAction,
    };
  } else if (refusal && refusal !== "unauthorized") {
    agent = {
      kind: "message",
      testId: `agent-refusal-${refusal}`,
      text: REFUSAL_MESSAGES[refusal],
    };
  } else if (prices === null) {
    agent = { kind: "price_loading" };
  } else if (!monthPrice) {
    agent = {
      kind: "message",
      testId: "agent-refusal-price_unavailable",
      text: REFUSAL_MESSAGES.price_unavailable,
    };
  } else {
    agent = {
      kind: "subscribe",
      priceDisplay: monthPrice.display,
      starting,
      disabled: licenseClass !== "individual" || isOffline,
      onSubscribe: () => void handleSubscribe(),
    };
  }

  const bookCall =
    prices && !prices.unavailable && prices.hasBookCall
      ? () => void billingService.openBookCall()
      : null;

  return (
    <div data-testid="export-unlock-prompt">
      {paymentFailed && (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4"
          data-testid="agent-payment-failed-banner"
        >
          <p className="min-w-0 text-sm text-red-900">
            <span className="font-semibold">Your Agent plan payment failed.</span> Unlimited exports
            are off until it&apos;s paid.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void billingService.openPortal()}
            data-testid="agent-update-card-banner"
          >
            Update card on the website ↗
          </Button>
        </div>
      )}

      <h3 className="text-lg font-semibold text-gray-900">Your full audit is ready to export</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
        Every email and text on <span className="font-medium text-gray-800">{dealLabel}</span>, in
        one hyperlinked PDF. Pick how you&apos;d like to unlock it.
      </p>

      {cancelledNotice && (
        <p className="mt-3 text-sm text-gray-600" role="status" data-testid="agent-checkout-cancelled">
          Checkout cancelled. Nothing was charged.
        </p>
      )}
      {refusal === "unauthorized" && (
        <p className="mt-3 text-sm text-red-700" role="alert" data-testid="agent-refusal-unauthorized">
          {REFUSAL_MESSAGES.unauthorized}
        </p>
      )}
      {unlockError && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {unlockError}
        </p>
      )}

      <PlanCards
        soloHighlighted={hasGrantCredits}
        soloPriceLabel={quote ? formatCents(quote.unitPriceCents, quote.currency) : null}
        creditCount={creditCount}
        solo={solo}
        agentPriceDisplay={priceDisplay}
        agent={agent}
        agentPaymentFailed={paymentFailed}
        onBookCall={bookCall}
      />

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-gray-400">Reading is always free · Payments by Stripe</p>
        <button
          type="button"
          onClick={onCancel}
          data-testid="unlock-cancel"
          className="text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export default ExportUnlockPrompt;
