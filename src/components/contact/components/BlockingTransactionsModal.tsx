import React from "react";
import { ResponsiveModal, MODAL_PANEL } from "../../common/ResponsiveModal";
import { TransactionWithRoles } from "../types";
// BACKLOG-2805: display label only — the ternary still branches on the
// stored enum, and its existing fall-through is unchanged.
import { TRANSACTION_TYPE_LABELS } from "../../../constants/transactionTypes";

interface BlockingTransactionsModalProps {
  transactions: TransactionWithRoles[];
  onClose: () => void;
}

/**
 * Blocking Transactions Modal
 * Shows when a contact cannot be deleted due to associated transactions
 */
function BlockingTransactionsModal({
  transactions,
  onClose,
}: BlockingTransactionsModalProps) {
  return (
    <ResponsiveModal onClose={onClose} overlayClassName="bg-black bg-opacity-50" panelClassName={MODAL_PANEL.lg}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-red-50 rounded-t-xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
              <svg
                className="w-6 h-6 text-red-600"
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
            <div>
              <h3 className="text-lg font-bold text-gray-900">
                Cannot Delete Contact
              </h3>
              <p className="text-sm text-gray-600">
                This contact is associated with active transactions
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          <div className="mb-4">
            <p className="text-gray-700">
              This contact cannot be deleted because they are associated with{" "}
              <span className="font-semibold text-red-600">
                {transactions.length} transaction
                {transactions.length !== 1 ? "s" : ""}
              </span>
              .
            </p>
            <p className="text-gray-600 text-sm mt-2">
              To delete this contact, you must first remove them from all
              associated transactions or delete the transactions.
            </p>
          </div>

          {/* Transactions List */}
          <div className="space-y-3">
            <h4 className="font-semibold text-gray-900 mb-3">
              Associated Transactions:
            </h4>
            {transactions.slice(0, 20).map((txn: TransactionWithRoles) => (
              <div
                key={txn.id}
                className="bg-gray-50 border border-gray-200 rounded-lg p-4 hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <svg
                        className="w-5 h-5 text-gray-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                      <h5 className="font-semibold text-gray-900">
                        {txn.property_address}
                      </h5>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-600">
                      {txn.roles && (
                        <div className="flex items-center gap-1">
                          <svg
                            className="w-4 h-4 text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                            />
                          </svg>
                          <span className="font-medium text-purple-600">
                            {txn.roles}
                          </span>
                        </div>
                      )}
                      {txn.transaction_type && (
                        <div className="flex items-center gap-1">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium ${
                              txn.transaction_type === "purchase"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-green-100 text-green-700"
                            }`}
                          >
                            {txn.transaction_type === "purchase"
                              ? TRANSACTION_TYPE_LABELS.purchase
                              : TRANSACTION_TYPE_LABELS.sale}
                          </span>
                        </div>
                      )}
                      {txn.status && (
                        <div className="flex items-center gap-1">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium ${
                              txn.status === "active"
                                ? "bg-green-100 text-green-700"
                                : "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {txn.status === "active" ? "Active" : "Closed"}
                          </span>
                        </div>
                      )}
                      {txn.closed_at && (
                        <div className="flex items-center gap-1">
                          <svg
                            className="w-4 h-4 text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                            />
                          </svg>
                          <span>
                            {new Date(txn.closed_at).toLocaleDateString()}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {transactions.length > 20 && (
              <div className="text-center py-3 text-gray-600">
                <p className="text-sm">
                  ... and {transactions.length - 20} more transaction
                  {transactions.length - 20 !== 1 ? "s" : ""}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 rounded-b-xl flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-600 text-white rounded-lg font-semibold hover:bg-gray-700 transition-all"
          >
            Close
          </button>
        </div>
    </ResponsiveModal>
  );
}

export default BlockingTransactionsModal;
