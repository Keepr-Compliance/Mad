/**
 * AccountSettings — the Account tab, first on the Settings page (BACKLOG-3964).
 *
 * The read-only account details the Account popup (Profile) shows: who is
 * signed in and with what, which mailboxes are connected, plan, trial,
 * transactions, ids and dates. Plus the reserved Billing block.
 *
 * Founder decision 10: no Sign out here. It lives in the account side panel
 * (slice 3); Security keeps "Sign Out All Devices".
 */
import React, { useEffect, useRef, useState } from "react";
import { useLicense } from "@/contexts/LicenseContext";
import { formatDbDate } from "@/utils/dateFormatters";
import logger from "@/utils/logger";
import { getAccountInitials } from "../../../appCore/shell/AccountButton";
import { formatPlanLabel } from "./formatPlanLabel";
import { AccountBillingBlock } from "./AccountBillingBlock";

export interface AccountUser {
  id: string;
  display_name?: string;
  email: string;
  avatar_url?: string;
  last_login_at?: string | Date;
  created_at?: string | Date;
}

export interface AccountSettingsProps {
  user: AccountUser;
  /** Sign-in provider ("google" | "microsoft"). */
  provider?: string | null;
  /**
   * Connected mailboxes, as the Email section reports them (Settings already
   * holds this from EmailSettings' own check, so no second connection check).
   */
  mailboxes?: { google: boolean; microsoft: boolean };
}

const PROVIDER_NAMES: Record<string, string> = { google: "Google", microsoft: "Microsoft", azure: "Microsoft" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-dashed border-gray-200 pb-1.5">
      <span className="flex-none text-gray-500">{label}</span>
      <span className="min-w-0 truncate text-right text-gray-900">{children}</span>
    </div>
  );
}

export function AccountSettings({ user, provider, mailboxes = { google: false, microsoft: false } }: AccountSettingsProps) {
  const {
    licenseType,
    organizationId,
    isLoading: licenseLoading,
    validationStatus,
    trialDaysRemaining,
    transactionCount,
    transactionLimit,
  } = useLicense();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const handleCopy = (): void => {
    void navigator.clipboard?.writeText(user.id).then(
      () => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1200);
      },
      (error: unknown) => logger.error("[AccountSettings] copy failed:", error),
    );
  };

  const planLabel = licenseType ? formatPlanLabel(licenseType) : "";
  const providerName = provider ? PROVIDER_NAMES[provider] ?? provider : null;
  const onTrial = validationStatus?.trialStatus === "active" && typeof trialDaysRemaining === "number";
  const chip = "rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-600";

  return (
    <div id="settings-account" className="mb-8">
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Account</h3>
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="" className="h-12 w-12 flex-none rounded-full object-cover" />
          ) : (
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-purple-500 text-lg font-bold text-white">
              {getAccountInitials(user)}
            </div>
          )}
          <div className="min-w-0">
            <p className="font-semibold text-gray-900">{user.display_name || "User"}</p>
            <p className="truncate text-sm text-gray-500">{user.email}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2" data-testid="account-chips">
          {providerName && (
            <span className={chip}>
              <span className="hidden sm:inline">Signed in with </span>
              {providerName}
            </span>
          )}
          {mailboxes.microsoft && (
            <span className={chip}>
              Outlook<span className="hidden sm:inline"> connected</span>
            </span>
          )}
          {mailboxes.google && (
            <span className={chip}>
              Gmail<span className="hidden sm:inline"> connected</span>
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
          <Row label="Plan">
            {licenseLoading ? (
              <span className="text-xs text-gray-400">Loading...</span>
            ) : (
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">{planLabel}</span>
            )}
          </Row>
          {typeof transactionCount === "number" && (
            <Row label="Transactions">
              {transactionCount} / {transactionLimit === Infinity || typeof transactionLimit !== "number" ? "Unlimited" : transactionLimit}
            </Row>
          )}
          {onTrial && (
            <Row label="Trial remaining">
              {trialDaysRemaining} day{trialDaysRemaining !== 1 ? "s" : ""}
            </Row>
          )}
          <div className="flex min-w-0 items-center justify-between gap-3 border-b border-dashed border-gray-200 pb-1.5">
            <span className="flex-none text-gray-500">User ID</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-xs text-gray-900" title={user.id} data-testid="account-user-id">
                {user.id}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="flex-none rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
                data-testid="account-copy-user-id"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          {organizationId && (
            <Row label="Organization ID">
              <span className="font-mono text-xs" title={organizationId}>{organizationId}</span>
            </Row>
          )}
          {user.created_at && <Row label="Member since">{formatDbDate(user.created_at, {}) ?? ""}</Row>}
          {user.last_login_at && <Row label="Last login">{formatDbDate(user.last_login_at, {}) ?? ""}</Row>}
        </div>

        <AccountBillingBlock planLabel={planLabel} organizationId={organizationId ?? null} userId={user.id} />
      </div>
    </div>
  );
}
