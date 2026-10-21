/**
 * UpgradeScreen Component
 * SPRINT-062: License Upgrade Prompt
 * BACKLOG-4038: rewritten for the two reachable blocked states, founder-approved wording.
 *
 * Shown when the user's license is blocked. Reachable reasons (trace on 4038):
 *   - suspended  (licenses.status = 'suspended')
 *   - ended      (licenses.status = 'expired' | 'cancelled', set by an admin)
 * Anything else renders the fallback ("unknown").
 *
 * Kit components (@keepr/ui), no hand-styled controls:
 *   Card/CardHeader/CardTitle/CardDescription/CardContent  packages/ui/src/components/card.tsx:13,28,40,55,67
 *   Button variant="primary" | "secondary" | "ghost"       packages/ui/src/components/button.tsx:22-27
 *   AppMark                                                packages/ui/src/components/app-mark.tsx:24
 */

import React from "react";
import {
  AppMark,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@keepr/ui";
import billingService from "../../services/billingService";

export type UpgradeReason = "suspended" | "ended" | "unknown";

/** The address "Contact support" opens (shell:open-external allows mailto:). */
export const SUPPORT_MAILTO = "mailto:support@keeprcompliance.com";

/**
 * Map a license blockReason (LicenseValidationResult["blockReason"], or the
 * string Login passes on) to the screen variant. "expired" is an admin-set
 * expired/cancelled license, never a trial.
 */
export function upgradeReasonFor(blockReason: string | null | undefined): UpgradeReason {
  if (blockReason === "suspended") return "suspended";
  if (blockReason === "expired") return "ended";
  return "unknown";
}

interface UpgradeScreenProps {
  reason: UpgradeReason;
  /** Called when the user signs out */
  onLogout?: () => Promise<void>;
}

const MESSAGES: Record<UpgradeReason, { title: string; description: string }> = {
  suspended: {
    title: "Your account is paused",
    description:
      "This usually follows a payment dispute or a request from support. Sign in on the Keepr website to review your billing, or contact support.",
  },
  ended: {
    title: "Your Keepr license has ended",
    description: "Sign in on the Keepr website to see your plan and billing.",
  },
  unknown: {
    title: "Your Keepr license isn't active",
    description: "Sign in on the Keepr website to see your plan and billing.",
  },
};

export function UpgradeScreen({ reason, onLogout }: UpgradeScreenProps): React.ReactElement {
  const message = MESSAGES[reason] ?? MESSAGES.unknown;

  const handleManageBilling = () => {
    // BACKLOG-3863: the portal Billing page (main builds the URL).
    void billingService.openPortal();
  };

  const handleContactSupport = () => {
    void window.api?.shell?.openExternal?.(SUPPORT_MAILTO);
  };

  const handleLogout = async () => {
    // Clear license cache before logout
    await window.api?.license?.clearCache?.();

    // Use force logout to clear all sessions (works even without session token)
    await window.api?.auth?.forceLogout?.();

    if (onLogout) {
      // Also call provided logout handler to update React state
      await onLogout();
    } else {
      // Fallback: Reload the page
      window.location.reload();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-md text-center" data-testid="upgrade-screen">
        <CardHeader className="items-center">
          <AppMark size={48} className="mb-2" />
          <CardTitle>{message.title}</CardTitle>
          <CardDescription>{message.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button variant="primary" onClick={handleManageBilling}>
            Manage billing on the website
          </Button>
          <Button variant="secondary" onClick={handleContactSupport}>
            Contact support
          </Button>
          <Button variant="ghost" onClick={handleLogout}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
