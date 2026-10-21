/**
 * UpgradeScreen Component
 * SPRINT-062: License Upgrade Prompt
 *
 * Shown when the user's license is blocked (expired, at limit, etc.)
 * Provides upgrade path and logout option.
 */

import React from "react";
import billingService from "../../services/billingService";

export type UpgradeReason =
  | "trial_expired"
  | "transaction_limit"
  | "suspended"
  | "unknown";

interface UpgradeScreenProps {
  reason: UpgradeReason;
  /** Called when user wants to switch account or sign out */
  onLogout?: () => Promise<void>;
}

const MESSAGES: Record<UpgradeReason, { title: string; description: string }> = {
  trial_expired: {
    title: "Your Trial Has Expired",
    description:
      "Your 14-day free trial has ended. Upgrade to continue using Keepr.",
  },
  transaction_limit: {
    title: "Transaction Limit Reached",
    description:
      "You've reached the maximum of 5 transactions on the free trial. Upgrade for unlimited transactions.",
  },
  suspended: {
    title: "License Suspended",
    description:
      "Your license has been suspended. Please contact support for assistance.",
  },
  unknown: {
    title: "License Required",
    description: "A valid license is required to use Keepr.",
  },
};

export function UpgradeScreen({ reason, onLogout }: UpgradeScreenProps): React.ReactElement {
  const message = MESSAGES[reason];

  const handleUpgrade = () => {
    // BACKLOG-3863: the portal Billing page (main builds the URL), not the old /beta page.
    void billingService.openPortal();
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-md text-center">
        {/* Icon */}
        <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg
            className="w-8 h-8 text-yellow-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{message.title}</h1>

        {/* Description */}
        <p className="text-gray-600 mb-6">{message.description}</p>

        {/* Features list */}
        <div className="text-left bg-gray-50 rounded-lg p-4 mb-6">
          <p className="font-medium text-gray-900 mb-2">
            With a paid plan you get:
          </p>
          <ul className="space-y-2 text-sm text-gray-600">
            <li className="flex items-center">
              <CheckIcon className="w-4 h-4 text-green-500 mr-2 flex-shrink-0" />
              Unlimited transactions
            </li>
            <li className="flex items-center">
              <CheckIcon className="w-4 h-4 text-green-500 mr-2 flex-shrink-0" />
              Up to 2 devices
            </li>
            <li className="flex items-center">
              <CheckIcon className="w-4 h-4 text-green-500 mr-2 flex-shrink-0" />
              Export audit packages
            </li>
            <li className="flex items-center">
              <CheckIcon className="w-4 h-4 text-green-500 mr-2 flex-shrink-0" />
              Priority support
            </li>
          </ul>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={handleUpgrade}
            className="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors"
          >
            Upgrade Now
          </button>
          <div className="flex gap-3">
            <button
              onClick={handleLogout}
              className="flex-1 px-4 py-2 text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Switch Account
            </button>
            <button
              onClick={handleLogout}
              className="flex-1 px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}
