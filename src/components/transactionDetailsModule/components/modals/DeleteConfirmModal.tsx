/**
 * DeleteConfirmModal Component
 * Confirmation dialog for deleting a transaction
 */
import React from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";

interface DeleteConfirmModalProps {
  propertyAddress: string;
  onCancel: () => void;
  onDelete: () => void;
}

export function DeleteConfirmModal({
  propertyAddress,
  onCancel,
  onDelete,
}: DeleteConfirmModalProps): React.ReactElement {
  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" panelClassName="max-w-md p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
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
          <h3 className="text-lg font-bold text-gray-900">Delete Transaction?</h3>
        </div>
        <p className="text-sm text-gray-600 mb-2">
          Are you sure you want to delete this transaction? This will permanently
          remove:
        </p>
        <ul className="text-sm text-gray-600 mb-6 ml-6 list-disc">
          <li>
            Transaction details for <strong>{propertyAddress}</strong>
          </li>
          <li>All contact assignments</li>
          <li>All related communications</li>
        </ul>
        <p className="text-sm text-red-600 font-semibold mb-6">
          This action cannot be undone.
        </p>
        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            data-testid="delete-transaction-confirm"
            className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded-lg font-semibold transition-all"
          >
            Delete Transaction
          </button>
        </div>
    </ResponsiveModal>
  );
}
