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
 *
 * BACKLOG-4038 follow-up: "Contact support" opens the in-app SupportTicketDialog
 * (the form SupportWidget opens) instead of a mailto. The dialog needs only
 * window.api.support.* and window.api.auth.getUserContact; no provider, and the
 * main-process handlers carry no license check, so it submits while blocked.
 */

import React, { useState } from "react";
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
import { SupportTicketDialog } from "../support/SupportTicketDialog";

export type UpgradeReason = "suspended" | "ended" | "unknown";

/** Shown as selectable text under the buttons, in case the support form cannot submit. */
export const SUPPORT_EMAIL = "support@keeprcompliance.com";

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

/**
 * BACKLOG-4038: support form presets. The category is matched by slug against
 * the categories the dialog loads (never a hardcoded id). Every variant,
 * including the fallback (PM ruling 2026-10-21), presets Billing & Subscription.
 * Priority is high on every variant: the user is locked out.
 */
export const BILLING_CATEGORY_SLUG = "billing-subscription";
export const BLOCKED_SUPPORT_PRIORITY = "high" as const;
const CATEGORY_SLUG_FOR: Record<UpgradeReason, string> = {
  suspended: BILLING_CATEGORY_SLUG,
  ended: BILLING_CATEGORY_SLUG,
  unknown: BILLING_CATEGORY_SLUG,
};

interface UpgradeScreenProps {
  reason: UpgradeReason;
  /**
   * BACKLOG-4038: the blocked user's id, when the block came from a sign-in
   * (the auth:deep-link-license-blocked event). Absent for the startup block,
   * where main falls back to the saved session.
   */
  userId?: string;
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

export function UpgradeScreen({ reason, userId, onLogout }: UpgradeScreenProps): React.ReactElement {
  const message = MESSAGES[reason] ?? MESSAGES.unknown;
  const [supportOpen, setSupportOpen] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");

  const handleManageBilling = () => {
    // BACKLOG-3863: the portal Billing page (main builds the URL).
    void billingService.openPortal();
  };

  const handleContactSupport = async () => {
    // BACKLOG-4038: pre-fill name/email from main (name + email only, no tokens).
    // auth:get-current-user cannot do this for a sign-in block: no local session
    // is saved before the block, so it answers "No active session".
    try {
      const result = await window.api?.auth?.getUserContact?.(userId);
      if (result?.success) {
        setUserEmail(result.email || "");
        setUserName(result.name || result.email || "");
      }
    } catch {
      // Nothing to read: the dialog still opens with empty, editable fields.
    }
    setSupportOpen(true);
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
          <p className="text-sm text-muted-foreground select-text">
            Or email <span data-testid="upgrade-support-email">{SUPPORT_EMAIL}</span>
          </p>
        </CardContent>
      </Card>
      {supportOpen && (
        <SupportTicketDialog
          onClose={() => setSupportOpen(false)}
          userEmail={userEmail}
          userName={userName}
          prefilledSubject={`Account or billing: ${message.title}`}
          initialPriority={BLOCKED_SUPPORT_PRIORITY}
          initialCategorySlug={CATEGORY_SLUG_FOR[reason]}
        />
      )}
    </div>
  );
}
