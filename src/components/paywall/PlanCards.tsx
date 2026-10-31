/**
 * PlanCards — BACKLOG-3676, the three export-paywall plan cards (tab A2,
 * approved 2026-10-09; kit sky-blue primary per BACKLOG-4073).
 *
 * Presentational only. ExportUnlockPrompt decides every state and passes it in;
 * nothing here calls a service.
 *
 *   Solo      — "Unlock with 1 credit" when the user has credits, otherwise
 *               "Pay $X for this deal" (X from the live quote).
 *   Agent     — monthly price from the portal (never a constant in the app),
 *               "Subscribe — $X/month", or the message for the refusal / plan
 *               state that replaces it.
 *   Brokerage — "Book a call" (main opens the portal's booking URL).
 *
 * The highlighted card follows the credit balance: credits → Solo, none → Agent.
 */

import React from "react";
import { Button } from "@keepr/ui";

/** What the Solo card's button area shows. */
export type SoloAction =
  | { kind: "loading" }
  | { kind: "credit"; unlocking: boolean; onUseCredit: () => void }
  | { kind: "pay"; priceLabel: string; onPay: () => void }
  | { kind: "unavailable"; isOffline: boolean; retrying: boolean; onRetry: () => void };

/** What the Agent card's button area shows. */
export type AgentAction =
  | { kind: "price_loading" }
  | { kind: "subscribe"; priceDisplay: string; starting: boolean; disabled: boolean; onSubscribe: () => void }
  /** A message instead of Subscribe (refusal or plan state). Optional action button. */
  | {
      kind: "message";
      testId: string;
      text: string;
      tone?: "neutral" | "error";
      action?: { label: string; testId: string; busy?: boolean; onClick: () => void };
    };

export interface PlanCardsProps {
  soloHighlighted: boolean;
  soloPriceLabel: string | null;
  creditCount: number;
  solo: SoloAction;
  agentPriceDisplay: string | null;
  agent: AgentAction;
  /** True when the Agent card shows the subscriber's failed card charge. */
  agentPaymentFailed: boolean;
  onBookCall: (() => void) | null;
}

const CARD_BASE = "relative flex flex-col gap-4 rounded-xl bg-white p-5";
const CARD_HI = `${CARD_BASE} border-2 border-primary shadow-lg`;
const CARD_LO = `${CARD_BASE} border border-gray-200 shadow-sm`;

function Check(): React.ReactElement {
  return (
    <span aria-hidden="true" className="text-primary">
      ✓
    </span>
  );
}

export function PlanCards({
  soloHighlighted,
  soloPriceLabel,
  creditCount,
  solo,
  agentPriceDisplay,
  agent,
  agentPaymentFailed,
  onBookCall,
}: PlanCardsProps): React.ReactElement {
  const agentHighlighted = !soloHighlighted;
  return (
    <div className="mt-5 grid items-stretch gap-4 md:grid-cols-3" data-testid="plan-cards">
      {/* Solo · Pay as you go */}
      <div
        className={soloHighlighted ? CARD_HI : CARD_LO}
        data-testid="plan-card-solo"
        data-highlighted={soloHighlighted ? "true" : "false"}
      >
        <div>
          <p className="flex h-6 items-center text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Solo · Pay as you go
          </p>
          {soloPriceLabel && (
            <p className="mt-1 text-3xl font-extrabold tracking-tight text-gray-900 tabular-nums">
              {soloPriceLabel}{" "}
              <span className="text-sm font-semibold text-gray-500">/ export</span>
            </p>
          )}
          <p className="mt-1 text-sm text-gray-600">This deal only. One payment.</p>
        </div>
        <ul className="flex-1 space-y-2 border-t border-gray-200 pt-3 text-sm text-gray-700">
          <li className="flex gap-2">
            <Check />
            No subscription
          </li>
          <li className="flex gap-2">
            <Check />
            Yours to export forever
          </li>
          {creditCount > 0 && (
            <li className="flex gap-2" data-testid="solo-credit-count">
              <Check />
              You have {creditCount} credit{creditCount === 1 ? "" : "s"}
            </li>
          )}
        </ul>
        <div className="flex flex-col gap-1.5">
          <SoloButton action={solo} primary={soloHighlighted} />
          {solo.kind === "pay" && (
            <p className="text-center text-[11px] text-gray-500">One payment, doesn&apos;t renew.</p>
          )}
        </div>
      </div>

      {/* Agent */}
      <div
        className={agentHighlighted ? CARD_HI : CARD_LO}
        data-testid="plan-card-agent"
        data-highlighted={agentHighlighted ? "true" : "false"}
      >
        <span
          className={`absolute -top-2.5 left-5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${
            agentPaymentFailed ? "bg-red-600" : "bg-primary"
          }`}
        >
          {agentPaymentFailed ? "Your plan · payment failed" : "Unlimited exports"}
        </span>
        <div>
          <p className="flex h-6 items-center text-[11px] font-bold uppercase tracking-wider text-primary">
            Agent
          </p>
          {agentPriceDisplay && (
            <p
              className="mt-1 text-3xl font-extrabold tracking-tight text-gray-900 tabular-nums"
              data-testid="agent-price"
            >
              {agentPriceDisplay}{" "}
              <span className="text-sm font-semibold text-gray-500">/ month</span>
            </p>
          )}
          <p className="mt-1 text-sm text-gray-600">
            {agentPaymentFailed
              ? "Unlimited exports are off until it's paid."
              : "Single license. Renews every month."}
          </p>
        </div>
        <ul className="flex-1 space-y-2 border-t border-gray-200 pt-3 text-sm text-gray-700">
          <li className="flex gap-2">
            <Check />
            Unlimited exports, text and email
          </li>
          <li className="flex gap-2">
            <Check />
            No credits spent while subscribed
          </li>
          <li className="flex gap-2 text-gray-400">
            <span aria-hidden="true">✕</span>
            No broker portal
          </li>
        </ul>
        <div className="flex flex-col gap-1.5">
          <AgentButton action={agent} primary={agentHighlighted} />
          {agent.kind === "subscribe" && (
            <p className="text-center text-[11px] text-gray-500">
              Renews every month until you cancel.
            </p>
          )}
        </div>
      </div>

      {/* Brokerage */}
      <div className={`${CARD_BASE} border border-primary/20 bg-primary/5`} data-testid="plan-card-brokerage">
        <div>
          <p className="flex h-6 items-center text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Brokerage
          </p>
          <p className="mt-1 text-3xl font-extrabold tracking-tight text-gray-900">
            Let&apos;s talk<span className="text-amber-500">.</span>
          </p>
          <p className="mt-1 text-sm text-gray-600">Per seat, billed monthly.</p>
        </div>
        <ul className="flex-1 space-y-2 border-t border-primary/10 pt-3 text-sm text-gray-700">
          <li className="flex gap-2">
            <Check />
            Broker portal and review
          </li>
          <li className="flex gap-2">
            <Check />
            Purchased by a Designated Broker
          </li>
        </ul>
        {onBookCall && (
          <Button
            variant="secondary"
            className="w-full"
            size="lg"
            onClick={onBookCall}
            data-testid="book-call"
          >
            Book a call
          </Button>
        )}
      </div>
    </div>
  );
}

function SoloButton({ action, primary }: { action: SoloAction; primary: boolean }): React.ReactElement {
  const variant = primary ? "primary" : "secondary";
  switch (action.kind) {
    case "loading":
      return (
        <Button variant="secondary" size="lg" className="w-full" disabled data-testid="unlock-loading">
          Checking…
        </Button>
      );
    case "credit":
      return (
        <Button
          variant={variant}
          size="lg"
          className="w-full"
          onClick={action.onUseCredit}
          disabled={action.unlocking}
          data-testid="unlock-with-credit"
        >
          {action.unlocking ? "Unlocking…" : "Unlock with 1 credit"}
        </Button>
      );
    case "pay":
      return (
        <Button
          variant={variant}
          size="lg"
          className="w-full"
          onClick={action.onPay}
          data-testid="unlock-purchase"
        >
          Pay {action.priceLabel} for this deal
        </Button>
      );
    case "unavailable":
      return (
        <div className="space-y-2">
          <Button
            variant="secondary"
            size="lg"
            className="w-full whitespace-normal"
            disabled
            data-testid="unlock-offline"
          >
            {action.isOffline
              ? "Unlocking requires an internet connection"
              : "Couldn’t load pricing — please try again"}
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            onClick={action.onRetry}
            disabled={action.retrying}
            data-testid="unlock-retry"
          >
            {action.retrying ? "Retrying…" : "Try again"}
          </Button>
        </div>
      );
  }
}

function AgentButton({ action, primary }: { action: AgentAction; primary: boolean }): React.ReactElement {
  switch (action.kind) {
    case "price_loading":
      return (
        <Button variant="secondary" size="lg" className="w-full" disabled data-testid="agent-price-loading">
          Checking…
        </Button>
      );
    case "subscribe":
      return (
        <Button
          variant={primary ? "primary" : "secondary"}
          size="lg"
          className="w-full"
          onClick={action.onSubscribe}
          disabled={action.disabled || action.starting}
          data-testid="agent-subscribe"
        >
          {action.starting ? "Opening checkout…" : `Subscribe — ${action.priceDisplay}/month`}
        </Button>
      );
    case "message":
      return (
        <div className="space-y-2">
          <p
            className={`text-center text-sm ${action.tone === "error" ? "text-red-700" : "text-gray-600"}`}
            data-testid={action.testId}
            role={action.tone === "error" ? "alert" : undefined}
          >
            {action.text}
          </p>
          {action.action && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={action.action.onClick}
              disabled={action.action.busy}
              data-testid={action.action.testId}
            >
              {action.action.label}
            </Button>
          )}
        </div>
      );
  }
}

export default PlanCards;
