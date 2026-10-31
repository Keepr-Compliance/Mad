/**
 * PlanBillingCard — Settings › Plan & Billing (BACKLOG-3863).
 *
 * Shows the user's plan and links to the website's Billing page. Display only:
 * nothing here gates a feature (exports stay on get_org_features /
 * entitlementService).
 *
 * Which line shows (plan 2c, SR R4.5/R4.6, founder D3):
 *   1. license not resolved yet                → Skeleton, no plan text.
 *   2. organizationId set (brokerage member)   → "Team license", managed by
 *      the brokerage. No billing button. Unaffected by the plan summary.
 *   3. plan summary loading                    → Skeleton.
 *   4. plan summary answered                   → its `state` decides the text
 *      (the same function the website uses). The feature gate is NOT consulted
 *      here, so when the two disagree (webhook lag) the website and the app
 *      still say the same thing.
 *   5. plan summary unavailable                → the feature gate's plan line,
 *      read STRICTLY (`features.unlimited_transactions.allowed === true`), no
 *      renewal / ending / failed line, "See plans and billing" still shown.
 *      Never `isAllowed()`: that key is fail-open, so every user would read
 *      "Unlimited" while features load or after an error.
 *
 * Mounted on the Account tab (BACKLOG-3964), which passes its plan label,
 * organization id and user id (planLabel optional).
 *
 * Kit components (@keepr/ui), no hand-styled controls:
 *   Card/CardHeader/CardTitle/CardDescription/CardContent  packages/ui/src/components/card.tsx:13,28,40,55,67
 *   Button variant="secondary" size="sm"                   packages/ui/src/components/button.tsx:23-24,49
 *   StatusPill                                             packages/ui/src/components/phone/status-pill.tsx:19-36
 *   AlertBanner variant="warning"                          packages/ui/src/components/alert-banner.tsx:24-25,44
 *   Skeleton                                               packages/ui/src/components/skeleton.tsx:8
 * No `primary`-scale hue is used (pill hues success/warning/danger/gray, banner
 * warning): under founder D2 that scale is still sky, next to #007AFF.
 */

import React, { useEffect, useState } from "react";
import {
  AlertBanner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  StatusPill,
} from "@keepr/ui";
import type { StatusPillProps } from "@keepr/ui";
import { useLicense } from "@/contexts/LicenseContext";
import { useFeatureGate } from "@/hooks/useFeatureGate";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { entitlementService } from "@/services/entitlementService";
import type { PlanSummary } from "@/services/billingService";
import { usePlanSummary } from "./usePlanSummary";

export interface PlanBillingCardProps {
  /** 3964's Account tab plan label. Accepted for that mount; this card names the plan itself. */
  planLabel?: string;
  /** Set when a brokerage manages this user's plan (from license:get). */
  organizationId: string | null;
  userId: string;
}

type Action = "manage" | "plans" | null;

interface View {
  title: string;
  pill?: { hue: StatusPillProps["hue"]; text: string };
  detail?: string;
  /** Pay as you go only: the remaining credits, shown next to the title. */
  showCredits?: boolean;
  action: Action;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatPrice(cents: number | null, currency: string | null): string | null {
  if (cents === null || cents === undefined || !currency) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(
      cents / 100,
    );
  } catch {
    return null;
  }
}

function payAsYouGo(price: string | null): View {
  return {
    title: "Pay as you go",
    detail: price ? `${price} per export.` : "You pay per export.",
    showCredits: true,
    action: "plans",
  };
}

/** The portal's answer decides (SR R4.6). */
function viewFromSummary(summary: PlanSummary, price: string | null): View {
  const date = formatDate(summary.current_period_end);
  switch (summary.state) {
    case "active":
      return {
        title: "Agent",
        pill: { hue: "success", text: "Active" },
        detail: date ? `Unlimited exports. Renews ${date}.` : "Unlimited exports.",
        action: "manage",
      };
    case "cancel_pending":
      return {
        title: "Agent",
        pill: { hue: "warning", text: "Ending" },
        detail: date ? `Unlimited exports until ${date}.` : "Unlimited exports until the period ends.",
        action: "manage",
      };
    case "payment_failed":
      return {
        title: "Agent",
        pill: { hue: "danger", text: "Payment failed" },
        detail: "Unlimited exports are off until it's paid.",
        action: "manage",
      };
    case "support_grant":
      return { title: "Unlimited exports", pill: { hue: "success", text: "Active" }, action: null };
    case "none":
    default:
      return payAsYouGo(price);
  }
}

export function PlanBillingCard({ organizationId }: PlanBillingCardProps) {
  const { isLicenseResolved } = useLicense();
  const { features, hasInitialized } = useFeatureGate();
  const { summary, loading, unavailable, openBillingPortal, openFailed, openFailedAddress } =
    usePlanSummary();
  const { balance, loading: balanceLoading } = useCreditBalance();
  const [price, setPrice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    void entitlementService.getQuote().then((quote) => {
      if (alive && quote) setPrice(formatPrice(quote.unitPriceCents, quote.currency));
    });
    return () => {
      alive = false;
    };
  }, []);

  let view: View | null;
  if (!isLicenseResolved) {
    view = null;
  } else if (organizationId) {
    view = {
      title: "Team license",
      detail: "Managed by your brokerage. Questions? Contact your broker admin.",
      action: null,
    };
  } else if (loading) {
    view = null;
  } else if (summary && !unavailable) {
    view = viewFromSummary(summary, price);
  } else if (!hasInitialized) {
    view = null;
  } else if (features.unlimited_transactions?.allowed === true) {
    view = { title: "Unlimited exports", action: "plans" };
  } else {
    view = payAsYouGo(price);
  }

  const onOpen = async (): Promise<void> => {
    setOpening(true);
    try {
      await openBillingPortal();
    } finally {
      setOpening(false);
    }
  };

  if (!view) {
    return (
      <Card data-testid="plan-billing-card" aria-busy="true">
        <CardHeader>
          <Skeleton className="h-5 w-32" data-testid="plan-billing-skeleton" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card data-testid="plan-billing-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{view.title}</CardTitle>
          {view.pill && <StatusPill hue={view.pill.hue}>{view.pill.text}</StatusPill>}
          {view.showCredits && !balanceLoading && balance !== null && (
            <span data-testid="plan-billing-credits" className="text-sm text-gray-600">
              {balance === 1 ? "1 credit" : `${balance} credits`}
            </span>
          )}
        </div>
        {view.detail && <CardDescription>{view.detail}</CardDescription>}
      </CardHeader>
      {(view.action || openFailed) && (
        <CardContent className="space-y-3">
          {view.action && (
            <Button variant="secondary" size="sm" isLoading={opening} onClick={() => void onOpen()}>
              {view.action === "manage" ? "Manage billing" : "See plans and billing"}
            </Button>
          )}
          {openFailed && (
            <AlertBanner variant="warning">
              {openFailedAddress
                ? `Couldn't open your browser. Go to ${openFailedAddress}.`
                : "Couldn't open the website."}
            </AlertBanner>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default PlanBillingCard;
