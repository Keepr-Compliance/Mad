import React, { useState, useCallback, useEffect } from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import type { BackupPasswordModalProps } from "../../types/iphone";

/**
 * BackupPasswordModal Component
 * Prompts user for encrypted backup password
 * Appears when an iPhone backup requires decryption
 */
export const BackupPasswordModal: React.FC<BackupPasswordModalProps> = ({
  isOpen,
  deviceName,
  onSubmit,
  onCancel,
  error,
  isLoading = false,
}) => {
  const [password, setPassword] = useState("");

  // Clear password when modal closes
  useEffect(() => {
    if (!isOpen) {
      setPassword("");
    }
  }, [isOpen]);

  // Handle form submission
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (password && !isLoading) {
        onSubmit(password);
      }
    },
    [password, isLoading, onSubmit],
  );

  if (!isOpen) return null;

  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-md">
        {/* Header */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-600 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <h2 className="text-xl font-bold text-white">
            Backup Password Required
          </h2>
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-colors disabled:opacity-50"
            aria-label="Close"
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
        <form onSubmit={handleSubmit} className="p-6">
          {/* Lock Icon */}
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
              <svg
                className="w-6 h-6 text-amber-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
          </div>

          <p className="text-gray-600 text-center mb-4">
            Your {deviceName} backup is encrypted. Enter the password you set in
            iTunes/Finder to continue.
          </p>

          {/* Password Input */}
          <div className="mb-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Backup password"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-amber-500 transition-colors text-gray-900 bg-white min-h-[44px]"
              autoFocus
              disabled={isLoading}
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={isLoading}
              className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!password || isLoading}
              className="flex-1 px-4 py-3 bg-gradient-to-r from-amber-500 to-orange-600 text-white font-medium rounded-lg hover:from-amber-600 hover:to-orange-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Verifying...</span>
                </>
              ) : (
                "Continue"
              )}
            </button>
          </div>

          {/* Help Text */}
          <p className="text-xs text-gray-500 mt-4 text-center">
            This is the password you set when enabling &quot;Encrypt iPhone
            backup&quot; in iTunes or Finder. It&apos;s different from your
            iPhone passcode. Keepr keeps it securely on this computer, so you
            only enter it once.
          </p>
        </form>
    </ResponsiveModal>
  );
};

export default BackupPasswordModal;
