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
 * window.api.support.* and window.api.auth.getCurrentUser; no provider, and the
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
  const [supportOpen, setSupportOpen] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");

  const handleManageBilling = () => {
    // BACKLOG-3863: the portal Billing page (main builds the URL).
    void billingService.openPortal();
  };

  const handleContactSupport = async () => {
    // Pre-fill name/email when a session exists (SupportWidget.tsx does the same).
    // No session (blocked at sign-in) leaves the fields empty for the user to type.
    try {
      const result = await window.api?.auth?.getCurrentUser?.();
      if (result?.success && result.user) {
        setUserEmail(result.user.email || "");
        setUserName(result.user.display_name || result.user.email || "");
      }
    } catch {
      // No session or DB not ready: the dialog still opens with empty fields.
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
        // Category is a support_categories UUID loaded at runtime, so only the
        // subject is preset; the dialog has no category preset.
        <SupportTicketDialog
          onClose={() => setSupportOpen(false)}
          userEmail={userEmail}
          userName={userName}
          prefilledSubject={`Account or billing: ${message.title}`}
        />
      )}
    </div>
  );
}
