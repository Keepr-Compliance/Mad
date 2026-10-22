/**
 * TransactionLimitModal
 *
 * Shown when user tries to create a new transaction but has reached their limit.
 * Offers upgrade link and support contact.
 */

import React from "react";
import { ResponsiveModal } from "./ResponsiveModal";
import billingService from "../../services/billingService";

interface TransactionLimitModalProps {
  transactionCount: number;
  transactionLimit: number;
  onClose: () => void;
}

export function TransactionLimitModal({
  transactionCount,
  transactionLimit,
  onClose,
}: TransactionLimitModalProps): React.ReactElement {
  return (
    <ResponsiveModal onClose={onClose} overlayClassName="bg-black/50" panelClassName="max-w-md p-6">
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-14 h-14 bg-orange-100 rounded-full flex items-center justify-center">
            <svg
              className="w-7 h-7 text-orange-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
        </div>

        {/* Title */}
        <h2 className="text-lg font-bold text-gray-900 text-center mb-2">
          Transaction Limit Reached
        </h2>

        {/* Description */}
        <p className="text-sm text-gray-600 text-center mb-4">
          You&apos;ve used{" "}
          <span className="font-semibold text-gray-900">
            {transactionCount}
          </span>{" "}
          of{" "}
          <span className="font-semibold text-gray-900">
            {transactionLimit}
          </span>{" "}
          transactions on your current plan. Upgrade to continue creating new
          transactions.
        </p>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={() => void billingService.openPortal()}
            className="w-full py-2.5 px-4 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
          >
            Upgrade Plan
          </button>
          <button
            onClick={() =>
              window.api?.shell?.openExternal?.("mailto:support@keeprcompliance.com?subject=Transaction%20Limit%20Inquiry")
            }
            className="w-full py-2.5 px-4 bg-white text-gray-700 rounded-lg font-medium border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Contact Support
          </button>
          <button
            onClick={onClose}
            className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
    </ResponsiveModal>
  );
}
