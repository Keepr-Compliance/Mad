import React, { useState, useEffect } from "react";
import { ResponsiveModal } from "./common/ResponsiveModal";
import type { Subscription } from "../../electron/types/models";
import { useLicense } from "@/contexts/LicenseContext";
import { useFeatureGate } from "@/hooks/useFeatureGate";
import logger from '../utils/logger';

interface User {
  id: string;
  display_name?: string;
  email: string;
  avatar_url?: string;
  last_login_at?: string | Date;
  created_at?: string | Date;
}

interface EmailConnectionStatus {
  connected: boolean;
  email: string | null;
}

interface EmailConnections {
  google: EmailConnectionStatus;
  microsoft: EmailConnectionStatus;
}

interface ProviderDisplayInfo {
  name: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

interface ProfileProps {
  user: User;
  provider: string;
  subscription?: Subscription;
  onLogout: () => void;
  onClose: () => void;
  onViewTransactions: () => void;
  onOpenSettings: (scrollTarget?: string) => void;
}

/**
 * Profile Component
 * Displays user information, session details, and account actions
 */
function Profile({
  user,
  provider,
  subscription,
  onLogout,
  onClose,
  onViewTransactions: _onViewTransactions,
  onOpenSettings,
}: ProfileProps) {
  const [showConfirmLogout, setShowConfirmLogout] = useState<boolean>(false);
  const [emailConnections, setEmailConnections] = useState<EmailConnections>({
    google: { connected: false, email: null },
    microsoft: { connected: false, email: null },
  });

  // Get license information for display
  const {
    licenseType,
    organizationId,
    isLoading: licenseLoading,
    validationStatus,
    trialDaysRemaining,
    transactionCount,
    transactionLimit,
  } = useLicense();
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");

  // Format license type for display
  const formatLicenseType = (type: string): string => {
    switch (type) {
      case "individual":
        return "Individual";
      case "team":
        return "Team";
      case "enterprise":
        return "Enterprise";
      default:
        return type.charAt(0).toUpperCase() + type.slice(1);
    }
  };

  const handleLogoutClick = (): void => {
    setShowConfirmLogout(true);
  };

  const handleConfirmLogout = (): void => {
    setShowConfirmLogout(false);
    onLogout();
  };

  const handleCancelLogout = (): void => {
    setShowConfirmLogout(false);
  };

  useEffect(() => {
    // Check email connection status when component mounts
    const checkEmailConnections = async (): Promise<void> => {
      if (!user?.id || !window.api?.system) return;

      try {
        const [googleStatus, microsoftStatus] = await Promise.all([
          window.api.system.checkGoogleConnection(user.id),
          window.api.system.checkMicrosoftConnection(user.id),
        ]);

        setEmailConnections({
          google: {
            connected: googleStatus?.connected || false,
            email: googleStatus?.email || null,
          },
          microsoft: {
            connected: microsoftStatus?.connected || false,
            email: microsoftStatus?.email || null,
          },
        });
      } catch (error) {
        logger.error("Error checking email connections:", error);
      }
    };

    checkEmailConnections();
  }, [user?.id]);

  const getProviderDisplay = (): ProviderDisplayInfo => {
    if (provider === "google") {
      return {
        name: "Google",
        color: "text-blue-600",
        bgColor: "bg-blue-50",
        borderColor: "border-blue-200",
      };
    } else if (provider === "microsoft") {
      return {
        name: "Microsoft",
        color: "text-purple-600",
        bgColor: "bg-purple-50",
        borderColor: "border-purple-200",
      };
    }
    return {
      name: provider,
      color: "text-gray-600",
      bgColor: "bg-gray-50",
      borderColor: "border-gray-200",
    };
  };

  const providerInfo = getProviderDisplay();

  const handleSettingsClick = (): void => {
    onClose();
    onOpenSettings();
  };

  return (
    <ResponsiveModal onClose={onClose} overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-md sm:max-h-[90vh] sm:overflow-hidden">
        {/* Header */}
        <div className="relative z-10 bg-gradient-to-r from-blue-500 to-purple-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl flex-shrink-0 shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h2 className="text-lg font-bold text-white">Account</h2>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <h2 className="text-xl font-bold text-white">Account</h2>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* User Info - Scrollable area with inset scrollbar */}
        <div className="flex-1 min-h-0 overflow-hidden px-2">
          <div className="h-full overflow-y-auto px-4 py-6">
            {/* Avatar and Name */}
            <div className="flex items-center mb-6">
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt={user.display_name}
                  className="w-16 h-16 rounded-full border-2 border-gray-200"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-2xl font-bold">
                  {user.display_name?.[0]?.toUpperCase() ||
                    user.email?.[0]?.toUpperCase() ||
                    "?"}
                </div>
              )}
              <div className="ml-4 flex-1">
                <h3 className="text-lg font-semibold text-gray-900">
                  {user.display_name || "User"}
                </h3>
                <p className="text-sm text-gray-600">{user.email}</p>
              </div>
            </div>

            {/* Provider Badge */}
            <div
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${providerInfo.bgColor} ${providerInfo.borderColor} border mb-4`}
            >
              <svg
                className={`w-4 h-4 ${providerInfo.color}`}
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
              <span className={`text-sm font-medium ${providerInfo.color}`}>
                Signed in with {providerInfo.name}
              </span>
            </div>

            {/* Email Connection Status - Only show if connected */}
            <div className="flex flex-wrap gap-2 mb-6">
              {/* Gmail Connection Status */}
              {emailConnections.google.connected && (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border-green-200 border">
                  <svg
                    className="w-4 h-4 text-green-600"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
                  </svg>
                  <span className="text-sm font-medium text-green-700">
                    Gmail
                    {emailConnections.google.email && (
                      <span className="text-green-600 font-normal">
                        {" "}
                        ({emailConnections.google.email})
                      </span>
                    )}
                  </span>
                </div>
              )}

              {/* Outlook Connection Status */}
              {emailConnections.microsoft.connected && (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border-blue-200 border">
                  <svg
                    className="w-4 h-4 text-blue-600"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
                  </svg>
                  <span className="text-sm font-medium text-blue-700">
                    Outlook
                    {emailConnections.microsoft.email && (
                      <span className="text-blue-600 font-normal">
                        {" "}
                        ({emailConnections.microsoft.email})
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>

            {/* Subscription Info */}
            {subscription && (
              <div className="bg-gray-50 rounded-lg p-4 mb-6 border border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">
                    Subscription
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      subscription.status === "active"
                        ? "bg-green-100 text-green-700"
                        : subscription.status === "trial"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {subscription.status || "Unknown"}
                  </span>
                </div>
                <p className="text-sm text-gray-600 capitalize">
                  {subscription.tier || "Free"} Plan
                </p>
                {subscription.isTrial &&
                  subscription.trialDaysRemaining !== undefined && (
                    <p className="text-xs text-gray-500 mt-1">
                      Trial: {subscription.trialDaysRemaining} days remaining
                    </p>
                  )}
                {/* License Type Display (BACKLOG-465) */}
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-200">
                  <span className="text-sm font-medium text-gray-700">
                    License
                  </span>
                  <div className="flex items-center gap-2">
                    {licenseLoading ? (
                      <span className="text-xs text-gray-400">Loading...</span>
                    ) : (
                      <>
                        <span className="text-sm text-gray-600">
                          {formatLicenseType(licenseType)}
                        </span>
                        {hasAIAddon && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                            + AI
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Trial Days Remaining */}
                {validationStatus?.trialStatus === "active" && trialDaysRemaining !== null && (
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm text-gray-600">Trial Remaining</span>
                    <span className={`text-sm font-medium ${trialDaysRemaining <= 3 ? "text-red-600" : "text-gray-900"}`}>
                      {trialDaysRemaining} day{trialDaysRemaining !== 1 ? "s" : ""}
                    </span>
                  </div>
                )}

                {/* Transaction Usage */}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm text-gray-600">Transactions</span>
                  <span className="text-sm text-gray-900">
                    {transactionCount} / {transactionLimit === Infinity ? "Unlimited" : transactionLimit}
                  </span>
                </div>

                {/* Organization ID (for team licenses) */}
                {(licenseType === "team" || licenseType === "enterprise") && organizationId && (
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm text-gray-600">Organization ID</span>
                    <span className="text-sm font-mono text-gray-900 truncate max-w-[150px]" title={organizationId}>
                      {organizationId}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Account Details */}
            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">User ID</span>
                <span className="text-sm font-mono text-gray-900">
                  {user.id}
                </span>
              </div>
              {user.last_login_at && (
                <div className="flex justify-between items-center py-2 border-b border-gray-100">
                  <span className="text-sm text-gray-600">Last Login</span>
                  <span className="text-sm text-gray-900">
                    {new Date(user.last_login_at).toLocaleDateString()}
                  </span>
                </div>
              )}
              {user.created_at && (
                <div className="flex justify-between items-center py-2">
                  <span className="text-sm text-gray-600">Member Since</span>
                  <span className="text-sm text-gray-900">
                    {new Date(user.created_at).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>

            {/* Settings Button */}
            <button
              onClick={handleSettingsClick}
              className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 px-4 rounded-lg transition-all shadow-md hover:shadow-lg mb-3"
              data-testid="nav-settings"
            >
              <div className="flex items-center justify-center gap-2">
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                Settings
              </div>
            </button>

            {/* Logout Button */}
            {!showConfirmLogout ? (
              <button
                onClick={handleLogoutClick}
                className="w-full bg-red-500 hover:bg-red-600 text-white font-semibold py-3 px-4 rounded-lg transition-all shadow-md hover:shadow-lg"
              >
                Sign Out
              </button>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm text-red-800 mb-3 text-center font-medium">
                  Are you sure you want to sign out?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleCancelLogout}
                    className="flex-1 bg-white hover:bg-gray-50 text-gray-700 font-medium py-2 px-4 rounded-lg border border-gray-300 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmLogout}
                    className="flex-1 bg-red-500 hover:bg-red-600 text-white font-medium py-2 px-4 rounded-lg transition-all"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
    </ResponsiveModal>
  );
}

export default Profile;
