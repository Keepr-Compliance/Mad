/**
 * AccountBillingBlock — the reserved Billing block on the Account tab
 * (BACKLOG-3964).
 *
 * A placeholder until the billing module (BACKLOG-3863) replaces THIS FILE in
 * place. The props are fixed now so that change never touches AccountSettings:
 * the Account tab's Plan row (formatPlanLabel) stays the one place the plan is
 * named, so this block does not repeat it.
 */
import React from "react";

export interface AccountBillingBlockProps {
  /** The plan label the Account tab shows (from formatPlanLabel). */
  planLabel: string;
  /** Set when a brokerage manages this user's plan. */
  organizationId: string | null;
  userId: string;
}

export function AccountBillingBlock(_props: AccountBillingBlockProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4"
      data-testid="account-billing-block"
    >
      <div>
        <p className="text-sm font-semibold text-gray-900">Billing</p>
        <p className="text-xs text-gray-500">
          <span className="hidden sm:inline">Invoices, payment method and plan changes. </span>
          Coming soon.
        </p>
      </div>
      <button
        type="button"
        disabled
        className="hidden sm:inline-block rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-400 cursor-not-allowed"
      >
        Manage billing
      </button>
    </div>
  );
}
